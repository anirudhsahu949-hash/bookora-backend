const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// =======================================================
// 🚦 RATE LIMITING
// =======================================================
const rateLimit = require("express-rate-limit");

const rateLimitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    error: "Too many requests. Please wait a moment and try again.",
  });
};

// FIX ✅: removed invalid `trustProxy` from each limiter object.
// app.set("trust proxy", 1) is set once at app level below — that is the correct approach.

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const cancelLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const refundStatusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const adminActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// =======================================================
// 🔥 Firebase Admin Init
// =======================================================
const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  console.log("Firebase connected ✅ - server.js:86");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:88", e);
}

const db = admin.firestore();

// =======================================================
// 🔔 PUSH NOTIFICATIONS
//
// BUG 4 FIX: moved to AFTER db is initialized (line above).
// Previously this function was defined before Firebase init,
// meaning db was in the temporal dead zone (const is not hoisted).
// Any call during startup would throw:
//   ReferenceError: Cannot access 'db' before initialization
// Safe now — db is guaranteed to exist when this function runs.
// =======================================================
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// ─── Playon notification image constants ──────────────────────────────────────
const NOTIF_LARGE_ICON =
  "https://github.com/anirudhsahu949-hash/turf-images/blob/main/playon-logo/playon-v7.png?raw=true";
const NOTIF_BIG_PICTURE =
  "https://github.com/anirudhsahu949-hash/turf-images/blob/main/playon-logo/playon-v7.png?raw=true";

async function sendPushToUser(userId, title, body, data = {}, imageUrl = null) {
  try {
    if (!userId) return;
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;
    const u = userDoc.data();

    // Always try FCM first if fcmToken exists — it supports all 3 icon positions
    if (u.fcmToken) {
      const bigPicture = imageUrl || NOTIF_BIG_PICTURE;
      try {
     // AFTER — correct
await admin.messaging().send({
  token: u.fcmToken,
  // ✅ NO imageUrl here at top level — keeps small icon safe
  notification: {
    title,
    body,
  },
  android: {
    priority: "high",
    notification: {
      channelId:  "bookora-default",
      sound:      "default",
      icon:       "notification_icon",   // ✅ small icon always stays
      color:      "#4DB408",
       // ✅ big picture only in android block
    },
  },
  apns: {
    payload: {
      aps: { "mutable-content": 1, sound: "default" },
    },
    fcmOptions: { imageUrl: bigPicture }, // iOS only
  },
  data: data || {},
});
        console.log(`FCM push sent to ${userId} - server.js:148`);
        return;
      } catch (fcmErr) {
        console.warn("FCM send failed, falling back to Expo: - server.js:151", fcmErr.message);
      }
    }

    // Fallback → Expo Push API (no image support but reliable)
    const token = u.expoPushToken;
    if (!token || !token.startsWith("ExponentPushToken[")) return;

    await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        to:        token,
        sound:     "default",
        title,
        body,
        data,
        channelId: "bookora-default",
        priority:  "high",
      }),
    });
    console.log(`Expo push sent to ${userId} - server.js:172`);
  } catch (e) {
    console.error("sendPushToUser failed: - server.js:174", e.message);
  }
}

const app = express();

// FIX ✅: trust proxy set ONCE at app level (correct way — not per-limiter)
app.set("trust proxy", 1);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use(cors());

// =======================================================
// 🔐 Razorpay
// =======================================================
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

// =======================================================
// ✅ HELPERS
// =======================================================

function parseHour(slot) {
  const startPart = slot.split("-")[0].trim();
  const timeParts = startPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  let hour = 0;
  if (timeParts) {
    hour = parseInt(timeParts[1]);
    const meridiem = timeParts[3].toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
  }
  return hour;
}

// FIX ✅: Moved helper functions to module scope — they were defined
// INSIDE the verify-payment handler body which caused duplicate-declaration
// errors on repeated requests and made them unavailable elsewhere.
function parseTimePart(t) {
  const parts = t.trim().split(" ");
  const [hStr, mStr] = (parts[0] || "0:0").split(":");
  let h = Number(hStr);
  const m = Number(mStr || 0);
  const period = (parts[1] || "").toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + m;
}

function formatMinutes(mins) {
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

function getProfessionalSlotRange(slots = []) {
  if (!Array.isArray(slots) || !slots.length) return "";
  const parsed = slots
    .map((slot) => {
      const parts = slot.split(" - ");
      if (parts.length < 2) return null;
      return { start: parseTimePart(parts[0]), end: parseTimePart(parts[1]) };
    })
    .filter(Boolean);
  if (!parsed.length) return "";
  parsed.sort((a, b) => a.start - b.start);
  return `${formatMinutes(parsed[0].start)} – ${formatMinutes(parsed[parsed.length - 1].end)}`;
}

// =======================================================
// ✅ ADMIN AUTH MIDDLEWARE
//
// BUG 3 FIX: Replaced hardcoded ADMIN_SECRET check with Firebase ID token
// verification. The old approach put ADMIN_SECRET in the client bundle
// (EXPO_PUBLIC_* variables are visible in the compiled APK). Anyone could
// decompile the app and call admin endpoints freely.
//
// NEW APPROACH:
//   Client sends:  Authorization: Bearer <Firebase ID token>
//   Server does:   admin.auth().verifyIdToken(token) → checks role === "admin"
//
// Firebase ID tokens are short-lived (1hr), cryptographically signed by Google,
// and impossible to forge. No secret ever touches the client.
//
// MIGRATION: remove ADMIN_SECRET and EXPO_PUBLIC_ADMIN_SECRET from your .env
// and from Render environment variables — they are no longer needed.
// =======================================================
async function requireAdminSecret(req, res, next) {
  try {
    const authHeader = req.headers["authorization"] || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      return res.status(401).json({ success: false, error: "Missing authorization token" });
    }

    // Verify the token is a valid Firebase ID token (not expired, not tampered)
    const decoded = await admin.auth().verifyIdToken(idToken);

    // Now check the user's role in Firestore — token alone doesn't carry role
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    if (!userDoc.exists) {
      return res.status(403).json({ success: false, error: "User not found" });
    }

    const role = userDoc.data()?.role;
    if (role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }

    // Attach uid to request so handlers can use it if needed
    req.adminUid = decoded.uid;
    next();
  } catch (e) {
    console.error("requireAdminSecret auth error: - server.js:300", e.message);
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// =======================================================
// ✅ CREATE ORDER
// =======================================================
app.post("/create-order", orderLimiter, async (req, res) => {
  try {
    const { turfId, slots, dateString, userId, bookingType } = req.body;

    if (!turfId || !dateString) {
      return res.status(400).json({ error: "turfId and dateString required" });
    }
    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: "slots required" });
    }

    // Fetch turf
    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) {
      return res.status(404).json({ error: "Turf not found" });
    }
    const turf = turfDoc.data();

    // Special prices
    const specialSnap = await db
      .collection("specialPrices")
      .where("turfId", "==", turfId)
      .where("date", "==", dateString)
      .get();
    const specialPrices = specialSnap.docs.map((d) => d.data());

    // Already booked slots
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", turfId)
      .where("dateString", "==", dateString)
      .get();

    const bookedSlots = bookingSnap.docs
      .map((d) => d.data())
      .filter((b) => b.status !== "cancelled")
      .flatMap((b) => b.selectedSlots || []);

    // Prevent already-booked slots
    for (const slot of slots) {
      if (bookedSlots.map((s) => String(s).trim()).includes(String(slot).trim())) {
        return res.status(400).json({ error: `Slot already booked: ${slot}` });
      }
    }

    // Calculate total amount
    let totalAmount = 0;
    for (const slot of slots) {
      const special = specialPrices.find(
        (s) => String(s.slotTime).trim() === String(slot).trim()
      );
      if (special) {
        totalAmount += Number(special.price);
      } else {
        const hour = parseHour(slot);
        let hourlyPrice = 0;
        if (hour >= 6 && hour < 18) {
          hourlyPrice = parseFloat(turf.dayPrice || turf.price || 0);
        } else {
          hourlyPrice = parseFloat(turf.nightPrice || turf.price || 0);
        }
        if (isNaN(hourlyPrice)) hourlyPrice = 0;
        totalAmount += hourlyPrice / 2; // 30-min slot
      }
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const finalBookingType =
      String(bookingType).trim().toLowerCase() === "full" ? "full" : "advance";

    let advanceAmount = 0;
    if (finalBookingType === "full") {
      advanceAmount = Number(totalAmount);
    } else {
      advanceAmount = Number(turf.bookingPrice || 0);
      if (advanceAmount > totalAmount) advanceAmount = totalAmount;
    }

    const remainingAmount = Math.max(totalAmount - advanceAmount, 0);

    console.log("Booking Type: - server.js:391", finalBookingType);
    console.log("Total Amount: - server.js:392", totalAmount);
    console.log("Advance Amount: - server.js:393", advanceAmount);

    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    await db.collection("orders").doc(order.id).set({
      bookingType: finalBookingType,
      paymentMode: finalBookingType === "full" ? "full_payment" : "advance_payment",
      turfId,
      turfName: turf.name || "",
      turfLocation: turf.location || "",
      image:
        Array.isArray(turf.images) && turf.images.length > 0
          ? turf.images[0]
          : turf.image || "",
      ownerId: turf.ownerId || null,
      ownerName: turf.ownerName || "",
      mapLink: turf.mapLink || "",
      userId: userId || null,
      slots,
      dateString,
      totalAmount,
      paidAmount: advanceAmount,
      advanceAmount,
      remainingAmount,
      orderId: order.id,
      orderStatus: "created",
      paymentStatus: "pending",
      verificationStatus: "pending",
      ownerSettlementStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.KEY_ID,
    });
  } catch (err) {
    console.error("createorder error: - server.js:436", err);
    return res.status(500).json({ error: err.message });
  }
});

// =======================================================
// ✅ VERIFY PAYMENT
//
// FIX ✅ #1 — Idempotency via Firestore TRANSACTION on the orders doc.
//   Old code: read order → (gap) → write booking → mark paid
//   Problem:  two concurrent /verify-payment calls both read "created",
//             both pass, both write a booking → duplicate booking.
//   Fix:      runTransaction reads-then-writes atomically. The second
//             call sees orderStatus === "paid" inside the transaction
//             and returns early with success: true.
//
// FIX ✅ #2 — Duplicate function declarations removed.
//   parseTimePart / formatMinutes / getProfessionalSlotRange were
//   declared TWICE inside the handler body. Moved to module scope above.
// =======================================================
app.post("/verify-payment", verifyLimiter, async (req, res) => {
  let order_id = null;

  try {
    const { order_id: incomingOrderId, payment_id, signature } = req.body;
    order_id = incomingOrderId;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    // Verify Razorpay signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    // Verify payment captured at Razorpay before touching Firestore
    const payment = await razorpay.payments.fetch(payment_id);
    if (payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured" });
    }

    const orderRef = db.collection("orders").doc(order_id);

    // ── TRANSACTION: idempotent booking creation ──────────────────────────────
    let bookingId = null;
    let orderData = null;
    let alreadyPaid = false;

    await db.runTransaction(async (txn) => {
      const orderDoc = await txn.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error("Order not found");
      }

      orderData = orderDoc.data();

      // Idempotency: already processed → return early
      if (orderData.orderStatus === "paid") {
        alreadyPaid = true;
        return;
      }

      // Double-booking check INSIDE the transaction
      // Read all existing bookings for this turf+date
      const existingSnap = await txn.get(
        db
          .collection("bookings")
          .where("turfId", "==", orderData.turfId)
          .where("dateString", "==", orderData.dateString)
      );

      const existingSlots = existingSnap.docs
        .map((d) => d.data())
        .filter((b) => b.status !== "cancelled")
        .flatMap((b) => b.selectedSlots || []);

      for (const slot of orderData.slots) {
        if (existingSlots.includes(slot)) {
          throw new Error(`Slot already booked: ${slot}`);
        }
      }

      // Fetch user info (outside transaction is fine — user doc rarely changes)
      // We do it after the conflict check to avoid wasted reads on conflict
      bookingId = `${orderData.turfId}_${Date.now()}`;
      const bookingRef = db.collection("bookings").doc(bookingId);

      const paymentStatus = orderData.bookingType === "full" ? "fully_paid" : "advance_paid";

      const parsedDate = new Date(orderData.dateString);
      const bookingDate = admin.firestore.Timestamp.fromDate(
        isNaN(parsedDate.getTime()) ? new Date() : parsedDate
      );

      // Write booking
      txn.set(bookingRef, {
        bookingType: orderData.bookingType || "advance",
        paymentMode: orderData.paymentMode || "advance_payment",
        turfId: orderData.turfId,
        turfName: orderData.turfName,
        turfLocation: orderData.turfLocation,
        image: orderData.image,
        ownerId: orderData.ownerId,
        ownerName: orderData.ownerName,
        mapLink: orderData.mapLink,
        userId: orderData.userId || null,
        userName: "",    // filled below after transaction
        userPhone: "",
        userEmail: "",
        date: bookingDate,
        dateString: orderData.dateString,
        selectedSlots: orderData.slots,
        paymentId: payment_id,
        orderId: order_id,
        totalAmount: orderData.totalAmount,
        paidAmount: orderData.paidAmount,
        advanceAmount: orderData.advanceAmount,
        remainingAmount: orderData.remainingAmount,
        status: "confirmed",
        paymentStatus,
        verificationStatus: "verified",
        ownerSettlementStatus: "pending",
        refundStatus: "not_applicable",
        refundAmount: 0,
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark order paid
      txn.update(orderRef, {
        orderStatus: "paid",
        paymentId: payment_id,
        paymentStatus,
        verificationStatus: "verified",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Already paid on a previous request — just return success
    if (alreadyPaid) {
      return res.json({ success: true, bookingId: null });
    }

    // ── Post-transaction: fill in user name + clean up locks ─────────────────
    // These don't need to be atomic — they're best-effort enrichment.

    let userName = "";
    let userPhone = "";
    let userEmail = "";

    if (orderData.userId) {
      try {
        const userDoc = await db.collection("users").doc(orderData.userId).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          userName = u.name || "";
          userPhone = u.phone || "";
          userEmail = u.email || "";
        }
      } catch (e) {
        console.warn("Could not fetch user for name enrichment: - server.js:605", e.message);
      }

      // Update booking with actual user name (non-critical)
      if (userName && bookingId) {
        db.collection("bookings")
          .doc(bookingId)
          .update({ userName, userPhone, userEmail })
          .catch((e) => console.warn("Name update failed: - server.js:613", e.message));
      }
    }

    // Delete slot locks
    try {
      const lockSnap = await db
        .collection("slotLocks")
        .where("turfId", "==", orderData.turfId)
        .where("dateString", "==", orderData.dateString)
        .where("userId", "==", orderData.userId)
        .get();

      const deletePromises = lockSnap.docs
        .filter((docSnap) => orderData.slots.includes(docSnap.data().slotTime))
        .map((docSnap) => docSnap.ref.delete());

      await Promise.all(deletePromises);
    } catch (e) {
      console.warn("Lock cleanup failed (noncritical): - server.js:632", e.message);
    }

    // Push notifications (non-blocking)
    const slotSummary = getProfessionalSlotRange(orderData.slots);
    const dateOnly =
      orderData.dateString?.split(" ").slice(0, 3).join(" ") || orderData.dateString;

    sendPushToUser(
      orderData.userId,
      "🎉 Booking Confirmed!",
      `Your booking at ${orderData.turfName} on ${dateOnly} from ${slotSummary} is confirmed.`,
      { screen: "bookings", bookingId }
    );

    if (orderData.ownerId) {
      sendPushToUser(
        orderData.ownerId,
        "📅 New Booking",
        `${userName || "A user"} booked ${orderData.turfName} on ${dateOnly} from ${slotSummary}.`,
        { screen: "owner-bookings", bookingId }
      );
    }

    return res.json({ success: true, bookingId });
  } catch (err) {
    console.error("verifypayment error: - server.js:658", err);

    // Mark order failed (best effort)
    try {
      if (order_id) {
        const orderDoc = await db.collection("orders").doc(order_id).get();
        if (orderDoc.exists && orderDoc.data().orderStatus !== "paid") {
          await db.collection("orders").doc(order_id).update({
            orderStatus: "failed",
            paymentStatus: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (e) {
      console.warn("Failed order update: - server.js:673", e.message);
    }

    return res.status(500).json({
      success: false,
      error: err.message || "Verification failed",
    });
  }
});

// =======================================================
// ✅ CANCEL BOOKING
// =======================================================
app.post("/cancel-booking", cancelLimiter, async (req, res) => {
  try {
    const { bookingId, userId, reason } = req.body;

    if (!bookingId || !userId) {
      return res.status(400).json({
        success: false,
        error: "bookingId and userId are required",
      });
    }

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: "Booking not found" });
    }

    const booking = bookingDoc.data();

    if (booking.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "You are not authorised to cancel this booking",
      });
    }

    if (booking.status === "cancelled") {
      return res.status(400).json({
        success: false,
        error: "This booking is already cancelled",
      });
    }

    // Past booking check
    const bookingDate = booking.date?.toDate ? booking.date.toDate() : new Date(booking.dateString);
    const bookingDay = new Date(bookingDate);
    bookingDay.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (bookingDay < today) {
      return res.status(400).json({
        success: false,
        error: "Cannot cancel a booking that has already passed",
      });
    }

    // 2-hour cancellation window
    const slots = booking.selectedSlots || [];
    if (slots.length > 0) {
      const firstSlot = String(slots[0]);
      const startPart = firstSlot.split(" - ")[0]?.trim();
      if (startPart) {
        const match = startPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1]);
          const min = parseInt(match[2] || "0");
          const period = match[3].toUpperCase();
          if (period === "PM" && h !== 12) h += 12;
          if (period === "AM" && h === 12) h = 0;
          const slotStartHour = h + min / 60;

          const slotDateTime = new Date(bookingDate);
          slotDateTime.setHours(Math.floor(slotStartHour), Math.round((slotStartHour % 1) * 60), 0, 0);

          const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntilSlot < 2) {
            return res.status(400).json({
              success: false,
              error: "Cancellations are not allowed within 2 hours of the slot start time",
              hoursUntilSlot: Math.round(hoursUntilSlot * 10) / 10,
            });
          }
        }
      }
    }

    const paidAmount = Number(booking.paidAmount || booking.advanceAmount || 0);
    const paymentId = booking.paymentId || null;
    const wasOnlinePayment = !!paymentId;
    const refundAmount = wasOnlinePayment ? paidAmount : 0;

    // Mark booking cancelled
    const batch = db.batch();
    batch.update(bookingRef, {
      status: "cancelled",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: "user",
      cancellationReason: reason || "User requested cancellation",
      refundStatus: wasOnlinePayment ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });
    await batch.commit();

    // Free slot locks
    try {
      const lockSnap = await db
        .collection("slotLocks")
        .where("turfId", "==", booking.turfId)
        .where("dateString", "==", booking.dateString)
        .get();

      const lockDeletePromises = lockSnap.docs
        .filter((lockDoc) => slots.includes(lockDoc.data().slotTime))
        .map((lockDoc) => lockDoc.ref.delete());

      await Promise.all(lockDeletePromises);
    } catch (e) {
      console.warn("Lock cleanup on cancel failed: - server.js:796", e.message);
    }

    // Razorpay refund
    let refundId = null;
    let refundNote = "no_refund";

    if (wasOnlinePayment && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes: { bookingId, reason: reason || "User cancelled booking" },
          speed: "normal",
        });
        refundId = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId,
          refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Refund initiated: ${refundId} for booking: ${bookingId} - server.js:817`);
      } catch (refundError) {
        console.error("Razorpay refund error: - server.js:819", refundError.message);
        await bookingRef.update({
          refundStatus: "failed",
          refundError: refundError.message,
          refundFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        refundNote = "refund_failed";
      }
    }

    // Notifications
    sendPushToUser(
      userId,
      "❌ Booking Cancelled",
      wasOnlinePayment && refundAmount > 0
        ? `Your booking at ${booking.turfName} was cancelled. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your booking at ${booking.turfName} on ${booking.dateString} has been cancelled.`,
      { screen: "bookings", bookingId }
    );

    if (booking.ownerId) {
      sendPushToUser(
        booking.ownerId,
        "🔔 Booking Cancelled",
        `${booking.userName || "A user"} cancelled their slot at ${booking.turfName} on ${booking.dateString}.`,
        { screen: "owner-bookings" }
      );
    }

    return res.json({
      success: true,
      bookingId,
      refundStatus: refundNote,
      refundAmount,
      refundId,
      message:
        wasOnlinePayment && refundAmount > 0
          ? `Booking cancelled. ₹${refundAmount} refund has been initiated and will reflect in 5-7 business days.`
          : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("cancelbooking error: - server.js:860", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Cancellation failed. Please try again.",
    });
  }
});

// =======================================================
// 🔍 REFUND STATUS
// =======================================================
app.get("/refund-status/:bookingId", refundStatusLimiter, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { userId } = req.query;

    if (!bookingId || !userId) {
      return res.status(400).json({ success: false, error: "bookingId and userId required" });
    }

    const bookingDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, error: "Booking not found" });
    }

    const booking = bookingDoc.data();
    if (booking.userId !== userId) {
      return res.status(403).json({ success: false, error: "Unauthorised" });
    }

    if (booking.refundId) {
      try {
        const refund = await razorpay.payments.fetchRefund(booking.paymentId, booking.refundId);
        return res.json({
          success: true,
          refundId: refund.id,
          refundStatus: refund.status,
          refundAmount: refund.amount / 100,
          processedAt: refund.created_at,
        });
      } catch (e) {
        // Fall through to Firestore data
      }
    }

    return res.json({
      success: true,
      refundId: booking.refundId || null,
      refundStatus: booking.refundStatus || "not_applicable",
      refundAmount: booking.refundAmount || 0,
    });
  } catch (err) {
    console.error("refundstatus error: - server.js:912", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =======================================================
// 👤 CREATE OWNER
// FIX ✅: requireAdminSecret middleware added.
// =======================================================
app.post("/create-owner", adminActionLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { name, email, phone, password, businessName, location, description } = req.body;

    const userRecord = await admin.auth().createUser({ email, password, displayName: name });

    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      phone,
      businessName,
      location: location || "",
      description: description || "",
      role: "owner",
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 👤 CREATE OPERATOR
// FIX ✅: requireAdminSecret middleware added.
// NOTE: operator role is "turf-operator" (consistent throughout).
// =======================================================
app.post("/create-operator", adminActionLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { name, email, phone, password, ownerId, turfId, turfName } = req.body;

    const userRecord = await admin.auth().createUser({ email, password, displayName: name });

    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      phone: phone || "",
      role: "turf-operator",
      ownerId: ownerId || null,
      // FIX ✅: save turfId/turfName on creation so operator sees bookings immediately
      turfId: turfId || null,
      turfName: turfName || "",
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 🗑️ DELETE OWNER
// FIX ✅: requireAdminSecret middleware added.
// =======================================================
app.delete("/delete-owner/:uid", adminActionLimiter, requireAdminSecret, async (req, res) => {
  try {
    const { uid } = req.params;

    if (!uid) {
      return res.status(400).json({ success: false, error: "uid is required" });
    }

    // Deactivate turfs
    const turfSnap = await db.collection("turfs").where("ownerId", "==", uid).get();
    if (!turfSnap.empty) {
      const batch = db.batch();
      turfSnap.docs.forEach((d) =>
        batch.update(d.ref, { active: false, deactivatedReason: "owner_deleted" })
      );
      await batch.commit();
      console.log(`Deactivated ${turfSnap.size} turf(s) for owner ${uid} - server.js:995`);
    }

    // Unlink operators
    const operatorSnap = await db
      .collection("users")
      .where("role", "==", "turf-operator")
      .where("ownerId", "==", uid)
      .get();
    if (!operatorSnap.empty) {
      const batch = db.batch();
      operatorSnap.docs.forEach((d) =>
        batch.update(d.ref, { ownerId: null, turfId: null, turfName: "", status: "inactive" })
      );
      await batch.commit();
      console.log(`Unlinked ${operatorSnap.size} operator(s) from owner ${uid} - server.js:1010`);
    }

    await admin.auth().deleteUser(uid);
    await db.collection("users").doc(uid).delete();

    res.json({
      success: true,
      turfsDeactivated: turfSnap.size,
      operatorsUnlinked: operatorSnap.size,
    });
  } catch (e) {
    console.error("deleteowner error: - server.js:1022", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// ⏰ DAY-BEFORE REMINDERS (cron endpoint)
// =======================================================
app.post("/send-reminders", async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toDateString();

    const snap = await db.collection("bookings").where("status", "==", "confirmed").get();
    const tomorrowBookings = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => {
        const d = b.date?.toDate ? b.date.toDate() : new Date(b.dateString);
        return !isNaN(d.getTime()) && d.toDateString() === tomorrowStr;
      });

    let sent = 0;
    await Promise.allSettled(
      tomorrowBookings.map(async (b) => {
        if (!b.userId) return;
        const slots = (b.selectedSlots || []).slice(0, 2).join(", ");
        await sendPushToUser(
          b.userId,
          "⏰ Reminder: Booking Tomorrow",
          `You have a slot at ${b.turfName || "your turf"} tomorrow. Slots: ${slots || "check the app"}.`,
          { screen: "bookings", bookingId: b.id }
        );
        sent++;
      })
    );

    return res.json({ success: true, sent, total: tomorrowBookings.length });
  } catch (e) {
    console.error("sendreminders error: - server.js:1064", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// 📢 ADMIN SEND NOTIFICATION
// FIX ✅: requireAdminSecret middleware used here too.
// NOTE: ADMIN_SECRET stays server-side only — remove EXPO_PUBLIC_ADMIN_SECRET
//       from your .env and from notification-center.tsx in the app.
//       The app should call this endpoint with a Firebase ID token instead,
//       and the server verifies the token's role === "admin".
// =======================================================
app.post("/send-admin-notification", requireAdminSecret, async (req, res) => {
  try {
    const { title, body, userId, role, data, imageUrl } = req.body;
    const image = imageUrl || null;

    if (!title || !body) {
      return res.status(400).json({ success: false, error: "title and body are required" });
    }

    if (userId) {
      await sendPushToUser(userId, title, body, data || {});
      return res.json({ success: true, message: "Notification sent to user" });
    }

    let query = db.collection("users");
    if (role) query = query.where("role", "==", role);

    const snap = await query.get();
    let total = 0;

    await Promise.allSettled(
      snap.docs.map(async (doc) => {
        const u = doc.data();

        // BUG 5 FIX: When imageUrl is provided, use Firebase Admin SDK messaging().send()
        // with the raw FCM token. Expo Push API silently ignores imageUrl — it has no
        // image support. FCM supports android.notification.imageUrl natively and
        // actually delivers the image in the notification.
        //
        // When no image: fall back to Expo Push API (simpler, works for plain notifications).
     if (u.fcmToken) {
  // Always use FCM — supports small icon, large icon (right thumbnail), big picture
  const bigPicture = image || NOTIF_BIG_PICTURE;
  try {
   // AFTER — correct
await admin.messaging().send({
  token: u.fcmToken,
  notification: {
    title,
    body,
    // ✅ NO imageUrl here
  },
  android: {
    priority: "high",
    notification: {
      channelId:  "bookora-default",
      sound:      "default",
      icon:       "notification_icon",   // ✅ small icon always stays
      color:      "#4DB408",
      imageUrl:   bigPicture,            // ✅ big picture only here
    },
  },
  apns: {
    payload: {
      aps: { "mutable-content": 1, sound: "default" },
    },
    fcmOptions: { imageUrl: bigPicture },
  },
  data: { ...data },
});
    total++;
  } catch (e) {
    console.error("FCM send failed for - server.js:1139", doc.id, e.message);
  }
  return;
}

        // No image — use Expo Push API as normal
        if (!u.expoPushToken) return;
        try {
          await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({
              to:        u.expoPushToken,
              sound:     "default",
              title,
              body,
              data:      data || {},
              channelId: "bookora-default",
              priority:  "high",
            }),
          });
          total++;
        } catch (e) {
          console.error("Expo push failed for - server.js:1162", doc.id, e.message);
        }
      })
    );

    return res.json({ success: true, total, message: "Notifications sent" });
  } catch (e) {
    console.error("admin notification error: - server.js:1169", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// ✅ HEALTH CHECK
//
// BUG 7 FIX: Returns JSON with timestamp so UptimeRobot can confirm
// the server is genuinely alive on every 14-minute ping.
// This keeps the Render free-tier server warm and prevents the
// 30-50 second cold start that causes booking/notification failures.
//
// Setup (free): https://uptimerobot.com
//   Monitor type : HTTP(s)
//   URL          : https://bookora-backend-95u4.onrender.com/health
//   Interval     : every 14 minutes  ← must be under Render's 15min sleep threshold
// =======================================================
app.get("/", (req, res) => {
  res.send("Bookora server running ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    server:    "bookora-backend",
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
  });
});

// =======================================================
// ❌ GLOBAL ERROR HANDLER
// =======================================================
app.use((err, req, res, next) => {
  console.error("Global Error: - server.js:1204", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT} ✅ - server.js:1213`);
});