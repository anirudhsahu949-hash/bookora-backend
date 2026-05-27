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

const promoLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// =======================================================
// 🔔 PUSH NOTIFICATIONS
// =======================================================
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendPushToUser(userId, title, body, data = {}) {
  try {
    if (!userId) return;
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;
    const token = userDoc.data()?.expoPushToken;
    if (!token || !token.startsWith("ExponentPushToken[")) return;

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title,
        body,
        data,
        channelId: "bookora-default",
        priority: "high",
      }),
    });

    const result = await response.json();
    console.log(`Push sent to ${userId}: - server.js:99`, result);
  } catch (e) {
    console.error("sendPushToUser failed: - server.js:101", e.message);
  }
}

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
  console.log("Firebase connected ✅ - server.js:128");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:130", e);
}

const db = admin.firestore();

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
// FIX ✅: Centralized admin secret check so it can be reused.
// Also added Firebase ID token verification option.
// =======================================================
function requireAdminSecret(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

// ── NEW: Firebase token-based auth middleware ─────────────────────────────
async function requireAdminOrOwner(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({ success: false, error: "Missing authorization token" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection("users").doc(decoded.uid).get();

    if (!userDoc.exists) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    const role = userDoc.data().role;
    if (role !== "admin" && role !== "owner") {
      return res.status(403).json({ success: false, error: "Forbidden — admin or owner only" });
    }

    req.callerUid  = decoded.uid;
    req.callerRole = role;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// ── Shared slot time parser (module-level, not inside if block) ──
function parseSlotTimeMins(t) {
  const parts = String(t).trim().split(" ");
  const [hStr, mStr] = (parts[0] || "0:0").split(":");
  let h = Number(hStr);
  const mins = Number(mStr || 0);
  const period = (parts[1] || "").toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + mins;
}

// Called before payment — checks all rules and returns discount
// =======================================================
app.post("/validate-promo", promoLimiter, async (req, res) => {
  try {
    const { code, userId, turfId, onlineAmount, bookingType } = req.body;
 
    if (!code || !userId || !turfId || onlineAmount === undefined) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
 
    // Find promo by code (case-insensitive)
    const promoSnap = await db
      .collection("promoCodes")
      .where("code", "==", String(code).trim().toUpperCase())
      .where("active", "==", true)
      .limit(1)
      .get();
 
    if (promoSnap.empty) {
      return res.status(404).json({ success: false, error: "Invalid or expired promo code" });
    }
 
    const promoDoc  = promoSnap.docs[0];
    const promo     = promoDoc.data();
    const promoId   = promoDoc.id;
    const now       = new Date();
 
    // ── Expiry check ─────────────────────────────────────────────────────────
    const validFrom = promo.validFrom?.toDate ? promo.validFrom.toDate() : new Date(promo.validFrom);
    const validTo   = promo.validTo?.toDate   ? promo.validTo.toDate()   : new Date(promo.validTo);
 
    if (now < validFrom) {
      return res.status(400).json({ success: false, error: "This promo code is not active yet" });
    }
    if (now > validTo) {
      return res.status(400).json({ success: false, error: "This promo code has expired" });
    }
 
    // ── Total uses check ─────────────────────────────────────────────────────
    if (promo.totalUses > 0 && promo.usedCount >= promo.totalUses) {
      return res.status(400).json({ success: false, error: "This promo code has reached its usage limit" });
    }
 
    // ── Per-user usage check ─────────────────────────────────────────────────
    if (promo.perUserLimit > 0) {
      const usageSnap = await db
        .collection("promoUsage")
        .where("promoId", "==", promoId)
        .where("userId", "==", userId)
        .get();
 
      if (usageSnap.size >= promo.perUserLimit) {
        return res.status(400).json({
          success: false,
          error: promo.perUserLimit === 1
            ? "You have already used this promo code"
            : `You can only use this code ${promo.perUserLimit} times`,
        });
      }
    }
 
    // ── Turf restriction check ───────────────────────────────────────────────
    if (Array.isArray(promo.applicableTurfs) && promo.applicableTurfs.length > 0) {
      if (!promo.applicableTurfs.includes(turfId)) {
        return res.status(400).json({ success: false, error: "This promo code is not valid for this turf" });
      }
    }
 
    // ── Payment type check ───────────────────────────────────────────────────
    if (promo.paymentType && promo.paymentType !== "both") {
      if (promo.paymentType !== bookingType) {
        const label = promo.paymentType === "full" ? "full payment" : "advance payment";
        return res.status(400).json({ success: false, error: `This promo is only valid for ${label} bookings` });
      }
    }
 
    // ── Minimum booking amount check ─────────────────────────────────────────
    if (promo.minBookingAmount > 0 && onlineAmount < promo.minBookingAmount) {
      return res.status(400).json({
        success: false,
        error: `Minimum booking amount of ₹${promo.minBookingAmount} required for this promo`,
      });
    }
    
   
// ── Target slot check ──
if (Array.isArray(promo.targetSlots) && promo.targetSlots.length > 0) {
  const userSlots = Array.isArray(req.body.selectedSlots) ? req.body.selectedSlots : [];

  console.log("TARGET CHECK  promo.targetSlots: - server.js:356", JSON.stringify(promo.targetSlots));
  console.log("TARGET CHECK  userSlots: - server.js:357", JSON.stringify(userSlots));

  if (userSlots.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Please select your time slot before applying this promo code.",
    });
  }

  // Get user booking start time in minutes
  const firstSlotParts = String(userSlots[0]).split(" - ");
  const userBookingStart = parseSlotTimeMins(firstSlotParts[0] || "");

  console.log("userBookingStart mins: - server.js:370", userBookingStart);

  // Check if booking start falls within ANY target slot window
  const hasMatch = promo.targetSlots.some(target => {
    const parts = String(target).split(" - ");
    const tStart = parseSlotTimeMins(parts[0] || "");
    const tEnd   = parseSlotTimeMins(parts[1] || "");
    console.log(`Checking target: ${target} → ${tStart}${tEnd} mins vs user: ${userBookingStart} - server.js:377`);
    return userBookingStart >= tStart && userBookingStart < tEnd;
  });

  if (!hasMatch) {
    const slotList = promo.targetSlots.slice(0, 3).join(", ");
    return res.status(400).json({
      success: false,
      error: `This code is only valid when booking starts in: ${slotList}`,
    });
  }
}
 
    // ── Calculate discount ───────────────────────────────────────────────────
    // Discount applies ONLY on the online (Razorpay) amount
    let discount = 0;
 
    if (promo.type === "flat") {
      discount = Number(promo.value);
    } else if (promo.type === "percent") {
      discount = Math.round((onlineAmount * Number(promo.value)) / 100);
      // Apply max discount cap if set
      if (promo.maxDiscount > 0) {
        discount = Math.min(discount, promo.maxDiscount);
      }
    }
    
 
    // Discount cannot exceed the online amount
    discount = Math.min(discount, onlineAmount);
    discount = Math.max(discount, 0);
 
    const finalOnlineAmount = onlineAmount - discount;
 
    return res.json({
      success:          true,
      promoId,
      code:             promo.code,
      discount,
      finalOnlineAmount,
      description:      promo.type === "flat"
        ? `₹${promo.value} off`
        : `${promo.value}% off${promo.maxDiscount > 0 ? ` (max ₹${promo.maxDiscount})` : ""}`,
    });
 
  } catch (err) {
    console.error("validatepromo error: - server.js:423", err);
    return res.status(500).json({ success: false, error: err.message || "Validation failed" });
  }
});

// =======================================================
// ✅ CREATE ORDER
// =======================================================
app.post("/create-order", orderLimiter, async (req, res) => {
  try {
    const { turfId, slots, dateString, userId, bookingType,
        promoId, promoCode, discount } = req.body;

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

   const promoDiscount = Math.max(Number(discount || 0), 0);

let advanceAmount = 0;
if (finalBookingType === "full") {
  advanceAmount = Math.max(Number(totalAmount) - promoDiscount, 1);
} else {
  advanceAmount = Number(turf.bookingPrice || 0);
  if (advanceAmount > totalAmount) advanceAmount = totalAmount;
  advanceAmount = Math.max(advanceAmount - promoDiscount, 1);
}

const remainingAmount = Math.max(totalAmount - advanceAmount - promoDiscount, 0);

    console.log("Booking Type: - server.js:518", finalBookingType);
    console.log("Total Amount: - server.js:519", totalAmount);
    console.log("Advance Amount: - server.js:520", advanceAmount);

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
     promoId:    promoId    || null,
      promoCode:  promoCode  || null,
      discount:   promoDiscount,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.KEY_ID,
    });
  } catch (err) {
    console.error("createorder error: - server.js:566", err);
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
  let payment_id_outer = null;

  try {
    const { order_id: incomingOrderId, payment_id, signature } = req.body;
    order_id = incomingOrderId;
    payment_id_outer = payment_id;

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

    // Verify payment captured at Razorpay
    const payment = await razorpay.payments.fetch(payment_id);
    if (payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured" });
    }

    const orderRef = db.collection("orders").doc(order_id);

    let bookingId = null;
    let orderData = null;
    let alreadyPaid = false;

    await db.runTransaction(async (txn) => {
      const orderDoc = await txn.get(orderRef);

      if (!orderDoc.exists) {
        throw new Error("Order not found");
      }

      orderData = orderDoc.data();

      // Idempotency check
      if (orderData.orderStatus === "paid") {
        alreadyPaid = true;
        return;
      }

      // ── Check 1: existing online bookings ──────────────────────────────────
      const existingSnap = await txn.get(
        db.collection("bookings")
          .where("turfId", "==", orderData.turfId)
          .where("dateString", "==", orderData.dateString)
      );

      const existingSlots = existingSnap.docs
        .map((d) => d.data())
        .filter((b) => b.status !== "cancelled")
        .flatMap((b) => b.selectedSlots || []);

      for (const slot of orderData.slots) {
        if (existingSlots.map(s => String(s).trim()).includes(String(slot).trim())) {
          throw new Error(`SLOT_CONFLICT: Slot already booked: ${slot}`);
        }
      }

      // ── Check 2: owner blocked slots ───────────────────────────────────────
      const blockedSnap = await txn.get(
        db.collection("blockedSlots")
          .where("turfId", "==", orderData.turfId)
          .where("date", "==", orderData.dateString)
      );

      const blockedSlotsList = blockedSnap.docs
        .flatMap((d) => d.data().slots || []);

      for (const slot of orderData.slots) {
        if (blockedSlotsList.map(s => String(s).trim()).includes(String(slot).trim())) {
          throw new Error(`SLOT_CONFLICT: Slot blocked by owner: ${slot}`);
        }
      }

      // ── All clear — create booking ─────────────────────────────────────────
      bookingId = `${orderData.turfId}_${Date.now()}`;
      const bookingRef = db.collection("bookings").doc(bookingId);
      const paymentStatus = orderData.bookingType === "full" ? "fully_paid" : "advance_paid";

      const parsedDate = new Date(orderData.dateString);
      const bookingDate = admin.firestore.Timestamp.fromDate(
        isNaN(parsedDate.getTime()) ? new Date() : parsedDate
      );

      txn.set(bookingRef, {
        bookingType:         orderData.bookingType || "advance",
        paymentMode:         orderData.paymentMode || "advance_payment",
        turfId:              orderData.turfId,
        turfName:            orderData.turfName,
        turfLocation:        orderData.turfLocation,
        image:               orderData.image,
        ownerId:             orderData.ownerId,
        ownerName:           orderData.ownerName,
        mapLink:             orderData.mapLink,
        userId:              orderData.userId || null,
        userName:            "",
        userPhone:           "",
        userEmail:           "",
        date:                bookingDate,
        dateString:          orderData.dateString,
        selectedSlots:       orderData.slots,
        paymentId:           payment_id,
        orderId:             order_id,
        totalAmount:         orderData.totalAmount,
        paidAmount:          orderData.paidAmount,
        advanceAmount:       orderData.advanceAmount,
        remainingAmount:     orderData.remainingAmount,
        status:              "confirmed",
        paymentStatus,
        verificationStatus:  "verified",
        ownerSettlementStatus: "pending",
        refundStatus:        "not_applicable",
        refundAmount:        0,
        cancelledAt:         null,
        cancelledBy:         null,
        cancellationReason:  null,
        promoId:             orderData.promoId   || null,
        promoCode:           orderData.promoCode || null,
        discount:            orderData.discount  || 0,
        createdAt:           admin.firestore.FieldValue.serverTimestamp(),
      });

      txn.update(orderRef, {
        orderStatus:         "paid",
        paymentId:           payment_id,
        paymentStatus,
        verificationStatus:  "verified",
        paidAt:              admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Already paid on a previous request
    if (alreadyPaid) {
      // Find the existing bookingId and return it
      try {
        const existingBooking = await db.collection("bookings")
          .where("orderId", "==", order_id)
          .limit(1)
          .get();
        const existingId = existingBooking.empty ? null : existingBooking.docs[0].id;
        return res.json({ success: true, bookingId: existingId });
      } catch {
        return res.json({ success: true, bookingId: null });
      }
    }

    // ── Post-transaction: user info, locks, promo, notifications ─────────────
    let userName = "";
    let userPhone = "";
    let userEmail = "";

    if (orderData.userId) {
      try {
        const userDoc = await db.collection("users").doc(orderData.userId).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          userName  = u.name  || "";
          userPhone = u.phone || "";
          userEmail = u.email || "";
        }
      } catch (e) {
        console.warn("Could not fetch user: - server.js:757", e.message);
      }

      if (userName && bookingId) {
        db.collection("bookings").doc(bookingId)
          .update({ userName, userPhone, userEmail })
          .catch((e) => console.warn("Name update failed: - server.js:763", e.message));
      }
    }

    // Delete slot locks
    try {
      const lockSnap = await db.collection("slotLocks")
        .where("turfId",     "==", orderData.turfId)
        .where("dateString", "==", orderData.dateString)
        .where("userId",     "==", orderData.userId)
        .get();

      const deletePromises = lockSnap.docs
        .filter((d) => orderData.slots.includes(d.data().slotTime))
        .map((d) => d.ref.delete());

      await Promise.all(deletePromises);
    } catch (e) {
      console.warn("Lock cleanup failed: - server.js:781", e.message);
    }

    // Record promo usage
    if (orderData.promoId && bookingId) {
      try {
        await db.collection("promoUsage").add({
          promoId:         orderData.promoId,
          promoCode:       orderData.promoCode || "",
          userId:          orderData.userId,
          bookingId,
          turfId:          orderData.turfId,
          discountApplied: orderData.discount || 0,
          usedAt:          admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection("promoCodes").doc(orderData.promoId).update({
          usedCount: admin.firestore.FieldValue.increment(1),
        });
      } catch (e) {
        console.warn("Promo usage recording failed: - server.js:800", e.message);
      }
    }

    // Notifications
    const slotSummary = getProfessionalSlotRange(orderData.slots);
    const dateOnly = orderData.dateString?.split(" ").slice(0, 3).join(" ") || orderData.dateString;

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
    console.error("verifypayment error: - server.js:827", err);

    // ── AUTO REFUND if slot conflict after payment was captured ───────────────
    if (err.message?.startsWith("SLOT_CONFLICT") && payment_id_outer) {
      try {
        const payment = await razorpay.payments.fetch(payment_id_outer);
        if (payment.status === "captured") {
          const refund = await razorpay.payments.refund(payment_id_outer, {
            amount: payment.amount, // full refund
            notes: { reason: err.message },
            speed: "normal",
          });
          console.log("Autorefund initiated: - server.js:839", refund.id);

          // Mark order as refunded
          if (order_id) {
            await db.collection("orders").doc(order_id).update({
              orderStatus:    "refunded",
              paymentStatus:  "refunded",
              refundId:       refund.id,
              refundReason:   err.message,
              refundedAt:     admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
          }

          return res.status(409).json({
            success:      false,
            error:        err.message.replace("SLOT_CONFLICT: ", ""),
            autoRefunded: true,
            refundId:     refund.id,
            message:      "This slot is no longer available. Your payment has been refunded automatically. It will reflect in 5–7 business days.",
          });
        }
      } catch (refundErr) {
        console.error("Autorefund failed: - server.js:861", refundErr.message);
        return res.status(409).json({
          success:      false,
          error:        err.message.replace("SLOT_CONFLICT: ", ""),
          autoRefunded: false,
          message:      "Slot unavailable. Refund could not be processed automatically — please contact support.",
        });
      }
    }

    // Mark order failed for non-conflict errors
    try {
      if (order_id) {
        const orderDoc = await db.collection("orders").doc(order_id).get();
        if (orderDoc.exists && orderDoc.data().orderStatus !== "paid") {
          await db.collection("orders").doc(order_id).update({
            orderStatus:  "failed",
            paymentStatus: "failed",
            failedAt:     admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (e) {
      console.warn("Failed order update: - server.js:884", e.message);
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
      console.warn("Lock cleanup on cancel failed: - server.js:1007", e.message);
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
        console.log(`Refund initiated: ${refundId} for booking: ${bookingId} - server.js:1028`);
      } catch (refundError) {
        console.error("Razorpay refund error: - server.js:1030", refundError.message);
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
    console.error("cancelbooking error: - server.js:1071", err);
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
    console.error("refundstatus error: - server.js:1123", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =======================================================
// 👤 CREATE OWNER
// FIX ✅: requireAdminSecret middleware added.
// =======================================================
app.post("/create-owner",  adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const {
      name, email, phone, password, businessName, location, description,
      // ✅ banking details sent from add-turf.tsx
      bankAccountNo, bankIfsc, bankName, bankUpi,
    } = req.body;

    // ✅ Validate required banking fields server-side too
    if (!bankAccountNo || String(bankAccountNo).trim().length < 9) {
      return res.status(400).json({ success: false, error: "Valid bank account number is required." });
    }
    const ifscClean = String(bankIfsc || "").trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscClean)) {
      return res.status(400).json({ success: false, error: "Valid IFSC code is required (e.g. SBIN0001234)." });
    }
    if (!bankName || !String(bankName).trim()) {
      return res.status(400).json({ success: false, error: "Account holder name is required." });
    }

    const userRecord = await admin.auth().createUser({ email, password, displayName: name });

    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      phone,
      businessName,
      location:    location    || "",
      description: description || "",
      role:   "owner",
      status: "active",
      // ✅ banking details — stored on owner's Firestore doc for settlement payouts
      banking: {
        accountNo: String(bankAccountNo).trim(),
        ifsc:      ifscClean,
        name:      String(bankName).trim(),
        upi:       bankUpi ? String(bankUpi).trim() : null,
        verified:  false,   // admin can manually verify later
        addedAt:   admin.firestore.FieldValue.serverTimestamp(),
      },
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
app.post("/create-operator", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
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
app.delete("/delete-owner/:uid", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
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
      console.log(`Deactivated ${turfSnap.size} turf(s) for owner ${uid} - server.js:1231`);
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
      console.log(`Unlinked ${operatorSnap.size} operator(s) from owner ${uid} - server.js:1246`);
    }

    await admin.auth().deleteUser(uid);
    await db.collection("users").doc(uid).delete();

    res.json({
      success: true,
      turfsDeactivated: turfSnap.size,
      operatorsUnlinked: operatorSnap.size,
    });
  } catch (e) {
    console.error("deleteowner error: - server.js:1258", e);
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
    console.error("sendreminders error: - server.js:1300", e);
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
        if (!u.expoPushToken) return;
        await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            to: u.expoPushToken,
            sound: "default",
            title,
            body,
            data: data || {},
            channelId: "bookora-default",
            priority: "high",
            ...(image ? { richContent: { image } } : {}),
          }),
        });
        total++;
      })
    );

    return res.json({ success: true, total, message: "Notifications sent" });
  } catch (e) {
    console.error("admin notification error: - server.js:1357", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// ✅ HEALTH CHECK
// =======================================================
app.get("/", (req, res) => {
  res.send("Bookora server running ✅");
});

// =======================================================
// ❌ GLOBAL ERROR HANDLER
// =======================================================
app.use((err, req, res, next) => {
  console.error("Global Error: - server.js:1373", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT} ✅ - server.js:1382`);
});