const express    = require("express");
const Razorpay   = require("razorpay");
const cors       = require("cors");
const crypto     = require("crypto");
const admin      = require("firebase-admin");
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

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const cancelLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const refundStatusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const adminActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const promoLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
// Rate limiter for player profile actions (less strict — creation is a rare event)
const profileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});

// =======================================================
// 🔔 PUSH NOTIFICATIONS (Expo)
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
    console.log(`Push sent to ${userId}: - server.js:77`, result);
  } catch (e) {
    console.error("sendPushToUser failed: - server.js:79", e.message);
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
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  console.log("Firebase connected ✅ - server.js:103");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:105", e);
}

const db = admin.firestore();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(cors());

// =======================================================
// 🔐 Razorpay
// =======================================================
const razorpay = new Razorpay({
  key_id:     process.env.KEY_ID,
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

function parseTimePart(t) {
  const parts = String(t).trim().split(" ");
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

async function getCancellationWindowHours() {
  try {
    const snap = await db.collection("appConfig").doc("booking").get();
    if (!snap.exists) return 2;
    const hours = Number(snap.data()?.cancellationWindowHours);
    if (isNaN(hours) || hours < 0 || hours > 24) return 2;
    return hours;
  } catch (e) {
    console.warn("getCancellationWindowHours fallback to 2: - server.js:192", e.message);
    return 2;
  }
}

// =======================================================
// 🔐 AUTH MIDDLEWARE
// =======================================================
function requireAdminSecret(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

async function requireAdminOrOwner(req, res, next) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ success: false, error: "Missing authorization token" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    if (!userDoc.exists) return res.status(401).json({ success: false, error: "User not found" });
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

async function requireLeagueOwnerOrAdmin(req, res, next) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ success: false, error: "Missing authorization token" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    if (!userDoc.exists) return res.status(401).json({ success: false, error: "User not found" });
    const role = userDoc.data().role;
    if (role !== "admin" && role !== "league-owner" && role !== "user") {
      return res.status(403).json({ success: false, error: "Forbidden — league owner or admin only" });
    }
    req.callerUid  = decoded.uid;
    req.callerRole = role;
    req.callerName = userDoc.data().name || "";
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// Any authenticated Firebase user (used for player profile creation)
async function requireAuth(req, res, next) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ success: false, error: "Missing authorization token" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.callerUid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// =======================================================
// ✅ VALIDATE PROMO
// =======================================================
app.post("/validate-promo", promoLimiter, async (req, res) => {
  try {
    const { code, userId, turfId, onlineAmount, bookingType } = req.body;

    if (!code || !userId || !turfId || onlineAmount === undefined) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const promoSnap = await db
      .collection("promoCodes")
      .where("code", "==", String(code).trim().toUpperCase())
      .where("active", "==", true)
      .limit(1)
      .get();

    if (promoSnap.empty) {
      return res.status(404).json({ success: false, error: "Invalid or expired promo code" });
    }

    const promoDoc = promoSnap.docs[0];
    const promo    = promoDoc.data();
    const promoId  = promoDoc.id;
    const now      = new Date();

    const validFrom = promo.validFrom?.toDate ? promo.validFrom.toDate() : new Date(promo.validFrom);
    const validTo   = promo.validTo?.toDate   ? promo.validTo.toDate()   : new Date(promo.validTo);
    if (now < validFrom) return res.status(400).json({ success: false, error: "This promo code is not active yet" });
    if (now > validTo)   return res.status(400).json({ success: false, error: "This promo code has expired" });

    if (promo.totalUses > 0 && promo.usedCount >= promo.totalUses) {
      return res.status(400).json({ success: false, error: "This promo code has reached its usage limit" });
    }

    if (promo.perUserLimit > 0) {
      const usageSnap = await db.collection("promoUsage")
        .where("promoId", "==", promoId).where("userId", "==", userId).get();
      if (usageSnap.size >= promo.perUserLimit) {
        return res.status(400).json({
          success: false,
          error: promo.perUserLimit === 1
            ? "You have already used this promo code"
            : `You can only use this code ${promo.perUserLimit} times`,
        });
      }
    }

    if (Array.isArray(promo.applicableTurfs) && promo.applicableTurfs.length > 0) {
      if (!promo.applicableTurfs.includes(turfId)) {
        return res.status(400).json({ success: false, error: "This promo code is not valid for this turf" });
      }
    }

    if (promo.paymentType && promo.paymentType !== "both") {
      if (promo.paymentType !== bookingType) {
        const label = promo.paymentType === "full" ? "full payment" : "advance payment";
        return res.status(400).json({ success: false, error: `This promo is only valid for ${label} bookings` });
      }
    }

    if (promo.minBookingAmount > 0 && onlineAmount < promo.minBookingAmount) {
      return res.status(400).json({
        success: false,
        error: `Minimum booking amount of ₹${promo.minBookingAmount} required for this promo`,
      });
    }

    // Target slot check
    if (Array.isArray(promo.targetSlots) && promo.targetSlots.length > 0) {
      const userSlots = Array.isArray(req.body.selectedSlots) ? req.body.selectedSlots : [];
      if (userSlots.length === 0) {
        return res.status(400).json({ success: false, error: "Please select your time slot before applying this promo code." });
      }
      const firstSlotParts     = String(userSlots[0]).split(" - ");
      const userBookingStart   = parseSlotTimeMins(firstSlotParts[0] || "");
      const hasMatch = promo.targetSlots.some((target) => {
        const parts  = String(target).split(" - ");
        const tStart = parseSlotTimeMins(parts[0] || "");
        let   tEnd   = parseSlotTimeMins(parts[1] || "");
        if (tEnd <= tStart) tEnd = 24 * 60;
        return userBookingStart >= tStart && userBookingStart < tEnd;
      });
      if (!hasMatch) {
        const slotList = promo.targetSlots.slice(0, 3).join(", ");
        return res.status(400).json({ success: false, error: `This code is only valid when booking starts in: ${slotList}` });
      }
    }

    let discount = 0;
    if (promo.type === "flat") {
      discount = Number(promo.value);
    } else if (promo.type === "percent") {
      discount = Math.round((onlineAmount * Number(promo.value)) / 100);
      if (promo.maxDiscount > 0) discount = Math.min(discount, promo.maxDiscount);
    }
    discount = Math.min(discount, onlineAmount);
    discount = Math.max(discount, 0);

    const finalOnlineAmount = onlineAmount - discount;

    return res.json({
      success:         true,
      promoId,
      code:            promo.code,
      discount,
      finalOnlineAmount,
      description: promo.type === "flat"
        ? `₹${promo.value} off`
        : `${promo.value}% off${promo.maxDiscount > 0 ? ` (max ₹${promo.maxDiscount})` : ""}`,
    });
  } catch (err) {
    console.error("validatepromo error: - server.js:373", err);
    return res.status(500).json({ success: false, error: err.message || "Validation failed" });
  }
});

// =======================================================
// ✅ CREATE ORDER
// =======================================================
app.post("/create-order", orderLimiter, async (req, res) => {
  try {
    const { turfId, slots, dateString, userId, bookingType, promoId, promoCode, discount } = req.body;

    if (!turfId || !dateString) return res.status(400).json({ error: "turfId and dateString required" });
    if (!Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: "slots required" });

    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) return res.status(404).json({ error: "Turf not found" });
    const turf = turfDoc.data();

    const specialSnap = await db.collection("specialPrices")
      .where("turfId", "==", turfId).where("date", "==", dateString).get();
    const specialPrices = specialSnap.docs.map((d) => d.data());

    const bookingSnap = await db.collection("bookings")
      .where("turfId", "==", turfId).where("dateString", "==", dateString).get();
    const bookedSlots = bookingSnap.docs.map((d) => d.data())
      .filter((b) => b.status !== "cancelled").flatMap((b) => b.selectedSlots || []);

    const blockSnap = await db.collection("blockedSlots")
      .where("turfId", "==", turfId).where("date", "==", dateString).get();
    const blockedSlots = blockSnap.docs.flatMap((d) => d.data().slots || []);

    const lockSnap = await db.collection("slotLocks")
      .where("turfId", "==", turfId).where("dateString", "==", dateString).get();
    const now = new Date();
    const lockedByOthers = lockSnap.docs.map((d) => d.data())
      .filter((l) => {
        const expiry = l.expiresAt?.toDate?.() || new Date(l.expiresAt);
        return l.userId !== userId && expiry > now;
      })
      .map((l) => l.slotTime);

    const taken = [...bookedSlots, ...blockedSlots, ...lockedByOthers].map((s) => String(s).trim());
    for (const slot of slots) {
      if (taken.includes(String(slot).trim())) {
        return res.status(409).json({
          success: false, slotConflict: true,
          error: "This slot is no longer available.",
          message: "Another user has already booked this slot or it has been blocked by the venue. Please select a different slot.",
        });
      }
    }

    let totalAmount = 0;
    for (const slot of slots) {
      const special = specialPrices.find((s) => String(s.slotTime).trim() === String(slot).trim());
      if (special) {
        totalAmount += Number(special.price);
      } else {
        const hour = parseHour(slot);
        let hourlyPrice = hour >= 6 && hour < 18
          ? parseFloat(turf.dayPrice || turf.price || 0)
          : parseFloat(turf.nightPrice || turf.price || 0);
        if (isNaN(hourlyPrice)) hourlyPrice = 0;
        totalAmount += hourlyPrice / 2;
      }
    }
    if (totalAmount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const finalBookingType = String(bookingType).trim().toLowerCase() === "full" ? "full" : "advance";
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

    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    await db.collection("orders").doc(order.id).set({
      bookingType:   finalBookingType,
      paymentMode:   finalBookingType === "full" ? "full_payment" : "advance_payment",
      turfId,
      turfName:      turf.name || "",
      turfLocation:  turf.location || "",
      image:         Array.isArray(turf.images) && turf.images.length > 0 ? turf.images[0] : turf.image || "",
      ownerId:       turf.ownerId || null,
      ownerName:     turf.ownerName || "",
      mapLink:       turf.mapLink || "",
      userId:        userId || null,
      slots,
      dateString,
      totalAmount,
      paidAmount:    advanceAmount,
      advanceAmount,
      remainingAmount,
      orderId:       order.id,
      orderStatus:   "created",
      paymentStatus: "pending",
      verificationStatus:    "pending",
      ownerSettlementStatus: "pending",
      promoId:    promoId    || null,
      promoCode:  promoCode  || null,
      discount:   promoDiscount,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.KEY_ID });
  } catch (err) {
    console.error("createorder error: - server.js:491", err);
    return res.status(500).json({ error: err.message });
  }
});

// =======================================================
// ✅ VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", verifyLimiter, async (req, res) => {
  let order_id = null;
  let payment_id_outer = null;

  try {
    const { order_id: incomingOrderId, payment_id, signature } = req.body;
    order_id         = incomingOrderId;
    payment_id_outer = payment_id;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");
    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    const payment = await razorpay.payments.fetch(payment_id);
    if (payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured" });
    }

    const orderRef   = db.collection("orders").doc(order_id);
    let bookingId    = null;
    let orderData    = null;
    let alreadyPaid  = false;

    await db.runTransaction(async (txn) => {
      const orderDoc = await txn.get(orderRef);
      if (!orderDoc.exists) throw new Error("Order not found");
      orderData = orderDoc.data();

      if (orderData.orderStatus === "paid") { alreadyPaid = true; return; }

      // Promo re-validation inside transaction
      if (orderData.promoId) {
        const promoDoc = await txn.get(db.collection("promoCodes").doc(orderData.promoId));
        if (!promoDoc.exists) throw new Error("PROMO_INVALID: Promo code was deleted");
        const promo = promoDoc.data();
        const now = new Date();
        const validFrom = promo.validFrom?.toDate?.() || new Date(promo.validFrom);
        const validTo   = promo.validTo?.toDate?.()   || new Date(promo.validTo);
        if (now < validFrom || now > validTo) throw new Error("PROMO_EXPIRED: Promo code is no longer valid");
        if (promo.totalUses > 0 && promo.usedCount >= promo.totalUses) throw new Error("PROMO_EXHAUSTED: Promo code limit reached");

        let recalcDiscount = 0;
        if (promo.type === "flat") {
          recalcDiscount = Number(promo.value);
        } else if (promo.type === "percent") {
          recalcDiscount = Math.round((orderData.totalAmount * Number(promo.value)) / 100);
          if (promo.maxDiscount > 0) recalcDiscount = Math.min(recalcDiscount, promo.maxDiscount);
        }
        recalcDiscount = Math.min(recalcDiscount, orderData.totalAmount);
        recalcDiscount = Math.max(recalcDiscount, 0);

        if (Math.abs(recalcDiscount - Number(orderData.discount || 0)) > 1) {
          throw new Error("PROMO_MISMATCH: Discount mismatch - possible fraud");
        }
      }

      // Slot conflict checks
      const existingSnap = await txn.get(
        db.collection("bookings")
          .where("turfId", "==", orderData.turfId)
          .where("dateString", "==", orderData.dateString)
      );
      const existingSlots = existingSnap.docs.map((d) => d.data())
        .filter((b) => b.status !== "cancelled").flatMap((b) => b.selectedSlots || []);
      for (const slot of orderData.slots) {
        if (existingSlots.map((s) => String(s).trim()).includes(String(slot).trim())) {
          throw new Error(`SLOT_CONFLICT: Slot already booked: ${slot}`);
        }
      }

      const blockedSnap = await txn.get(
        db.collection("blockedSlots")
          .where("turfId", "==", orderData.turfId)
          .where("date", "==", orderData.dateString)
      );
      const blockedSlotsList = blockedSnap.docs.flatMap((d) => d.data().slots || []);
      for (const slot of orderData.slots) {
        if (blockedSlotsList.map((s) => String(s).trim()).includes(String(slot).trim())) {
          throw new Error(`SLOT_CONFLICT: Slot blocked by owner: ${slot}`);
        }
      }

      bookingId = `${orderData.turfId}_${Date.now()}`;
      const bookingRef    = db.collection("bookings").doc(bookingId);
      const paymentStatus = orderData.bookingType === "full" ? "fully_paid" : "advance_paid";
      const parsedDate    = new Date(orderData.dateString);
      const bookingDate   = admin.firestore.Timestamp.fromDate(isNaN(parsedDate.getTime()) ? new Date() : parsedDate);

      txn.set(bookingRef, {
        bookingType:           orderData.bookingType || "advance",
        paymentMode:           orderData.paymentMode || "advance_payment",
        turfId:                orderData.turfId,
        turfName:              orderData.turfName,
        turfLocation:          orderData.turfLocation,
        image:                 orderData.image,
        ownerId:               orderData.ownerId,
        ownerName:             orderData.ownerName,
        mapLink:               orderData.mapLink,
        userId:                orderData.userId || null,
        userName:              "",
        userPhone:             "",
        userEmail:             "",
        date:                  bookingDate,
        dateString:            orderData.dateString,
        selectedSlots:         orderData.slots,
        paymentId:             payment_id,
        orderId:               order_id,
        totalAmount:           orderData.totalAmount,
        paidAmount:            orderData.paidAmount,
        advanceAmount:         orderData.advanceAmount,
        remainingAmount:       orderData.remainingAmount,
        status:                "confirmed",
        paymentStatus,
        verificationStatus:    "verified",
        ownerSettlementStatus: "pending",
        refundStatus:          "not_applicable",
        refundAmount:          0,
        cancelledAt:           null,
        cancelledBy:           null,
        cancellationReason:    null,
        promoId:               orderData.promoId   || null,
        promoCode:             orderData.promoCode || null,
        discount:              orderData.discount  || 0,
        createdAt:             admin.firestore.FieldValue.serverTimestamp(),
      });

      txn.update(orderRef, {
        orderStatus:        "paid",
        paymentId:          payment_id,
        paymentStatus,
        verificationStatus: "verified",
        paidAt:             admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    if (alreadyPaid) {
      try {
        const existingBooking = await db.collection("bookings")
          .where("orderId", "==", order_id).limit(1).get();
        return res.json({ success: true, bookingId: existingBooking.empty ? null : existingBooking.docs[0].id });
      } catch {
        return res.json({ success: true, bookingId: null });
      }
    }

    // Post-transaction: user info, locks, promo, notifications
    let userName = "", userPhone = "", userEmail = "";
    if (orderData.userId) {
      try {
        const userDoc = await db.collection("users").doc(orderData.userId).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          userName = u.name || ""; userPhone = u.phone || ""; userEmail = u.email || "";
        }
      } catch (e) { console.warn("Could not fetch user: - server.js:661", e.message); }

      if (userName && bookingId) {
        db.collection("bookings").doc(bookingId)
          .update({ userName, userPhone, userEmail })
          .catch((e) => console.warn("Name update failed: - server.js:666", e.message));
      }
    }

    try {
      const lockSnap = await db.collection("slotLocks")
        .where("turfId", "==", orderData.turfId)
        .where("dateString", "==", orderData.dateString)
        .where("userId", "==", orderData.userId)
        .get();
      await Promise.all(
        lockSnap.docs
          .filter((d) => orderData.slots.includes(d.data().slotTime))
          .map((d) => d.ref.delete())
      );
    } catch (e) { console.warn("Lock cleanup failed: - server.js:681", e.message); }

    if (orderData.promoId && bookingId) {
      try {
        await db.collection("promoUsage").add({
          promoId: orderData.promoId, promoCode: orderData.promoCode || "",
          userId: orderData.userId, bookingId, turfId: orderData.turfId,
          discountApplied: orderData.discount || 0,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection("promoCodes").doc(orderData.promoId).update({
          usedCount: admin.firestore.FieldValue.increment(1),
        });
      } catch (e) { console.warn("Promo usage recording failed: - server.js:694", e.message); }
    }

    const slotSummary = getProfessionalSlotRange(orderData.slots);
    const dateOnly    = orderData.dateString?.split(" ").slice(0, 3).join(" ") || orderData.dateString;

    sendPushToUser(orderData.userId, "🎉 Booking Confirmed!",
      `Your booking at ${orderData.turfName} on ${dateOnly} from ${slotSummary} is confirmed.`,
      { screen: "bookings", bookingId }
    );
    if (orderData.ownerId) {
      sendPushToUser(orderData.ownerId, "📅 New Booking",
        `${userName || "A user"} booked ${orderData.turfName} on ${dateOnly} from ${slotSummary}.`,
        { screen: "owner-bookings", bookingId }
      );
    }

    return res.json({ success: true, bookingId });

  } catch (err) {
    console.error("verifypayment error: - server.js:714", err);

    if (err.message?.startsWith("SLOT_CONFLICT") && payment_id_outer) {
      try {
        const payment = await razorpay.payments.fetch(payment_id_outer);
        if (payment.status === "captured") {
          const refund = await razorpay.payments.refund(payment_id_outer, {
            amount: payment.amount, notes: { reason: err.message }, speed: "normal",
          });
          console.log("Autorefund initiated: - server.js:723", refund.id);
          if (order_id) {
            await db.collection("orders").doc(order_id).update({
              orderStatus: "refunded", paymentStatus: "refunded",
              refundId: refund.id, refundReason: err.message,
              refundedAt: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
          }
          return res.status(409).json({
            success: false, error: err.message.replace("SLOT_CONFLICT: ", ""),
            autoRefunded: true, refundId: refund.id,
            message: "This slot is no longer available. Your payment has been refunded automatically. It will reflect in 5–7 business days.",
          });
        }
      } catch (refundErr) {
        console.error("Autorefund failed: - server.js:738", refundErr.message);
        return res.status(409).json({
          success: false, error: err.message.replace("SLOT_CONFLICT: ", ""),
          autoRefunded: false,
          message: "Slot unavailable. Refund could not be processed automatically — please contact support.",
        });
      }
    }

    try {
      if (order_id) {
        const orderDoc = await db.collection("orders").doc(order_id).get();
        if (orderDoc.exists && orderDoc.data().orderStatus !== "paid") {
          await db.collection("orders").doc(order_id).update({
            orderStatus: "failed", paymentStatus: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (e) { console.warn("Failed order update: - server.js:757", e.message); }

    return res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});

// =======================================================
// ✅ CANCEL BOOKING
// =======================================================
app.post("/cancel-booking", cancelLimiter, async (req, res) => {
  try {
    const { bookingId, userId, reason } = req.body;
    if (!bookingId || !userId) {
      return res.status(400).json({ success: false, error: "bookingId and userId are required" });
    }

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();

    if (booking.userId !== userId) {
      return res.status(403).json({ success: false, error: "You are not authorised to cancel this booking" });
    }
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "This booking is already cancelled" });
    }

    const bookingDate = booking.date?.toDate ? booking.date.toDate() : new Date(booking.dateString);
    const bookingDay  = new Date(bookingDate); bookingDay.setHours(0, 0, 0, 0);
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    if (bookingDay < today) {
      return res.status(400).json({ success: false, error: "Cannot cancel a booking that has already passed" });
    }

    const cancellationWindowHours = await getCancellationWindowHours();
    const slots = booking.selectedSlots || [];
    if (slots.length > 0 && cancellationWindowHours > 0) {
      const firstSlot = String(slots[0]);
      const startPart = firstSlot.split(" - ")[0]?.trim();
      if (startPart) {
        const match = startPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (match) {
          let h = parseInt(match[1]);
          const min    = parseInt(match[2] || "0");
          const period = match[3].toUpperCase();
          if (period === "PM" && h !== 12) h += 12;
          if (period === "AM" && h === 12) h = 0;
          const slotStartHour = h + min / 60;
          const slotDateTime  = new Date(bookingDate);
          slotDateTime.setHours(Math.floor(slotStartHour), Math.round((slotStartHour % 1) * 60), 0, 0);
          const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
          if (hoursUntilSlot < cancellationWindowHours) {
            return res.status(400).json({
              success: false,
              error: `Cancellations are not allowed within ${cancellationWindowHours} hours of the slot start time`,
              hoursUntilSlot: Math.round(hoursUntilSlot * 10) / 10,
              requiredHours: cancellationWindowHours,
            });
          }
        }
      }
    }

    const paidAmount        = Number(booking.paidAmount || booking.advanceAmount || 0);
    const paymentId         = booking.paymentId || null;
    const wasOnlinePayment  = !!paymentId;
    const refundAmount      = wasOnlinePayment ? paidAmount : 0;

    const batch = db.batch();
    batch.update(bookingRef, {
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           "user",
      cancellationReason:    reason || "User requested cancellation",
      refundStatus:          wasOnlinePayment ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });
    await batch.commit();

    try {
      const lockSnap = await db.collection("slotLocks")
        .where("turfId", "==", booking.turfId)
        .where("dateString", "==", booking.dateString).get();
      await Promise.all(
        lockSnap.docs.filter((ld) => slots.includes(ld.data().slotTime)).map((ld) => ld.ref.delete())
      );
    } catch (e) { console.warn("Lock cleanup on cancel failed: - server.js:845", e.message); }

    let refundId   = null;
    let refundNote = "no_refund";
    if (wasOnlinePayment && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes:  { bookingId, reason: reason || "User cancelled booking" },
          speed:  "normal",
        });
        refundId   = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId, refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (refundError) {
        console.error("Razorpay refund error: - server.js:863", refundError.message);
        await bookingRef.update({
          refundStatus: "failed", refundError: refundError.message,
          refundFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        refundNote = "refund_failed";
      }
    }

    sendPushToUser(userId, "❌ Booking Cancelled",
      wasOnlinePayment && refundAmount > 0
        ? `Your booking at ${booking.turfName} was cancelled. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your booking at ${booking.turfName} on ${booking.dateString} has been cancelled.`,
      { screen: "bookings", bookingId }
    );
    if (booking.ownerId) {
      sendPushToUser(booking.ownerId, "🔔 Booking Cancelled",
        `${booking.userName || "A user"} cancelled their slot at ${booking.turfName} on ${booking.dateString}.`,
        { screen: "owner-bookings" }
      );
    }

    return res.json({
      success: true, bookingId, refundStatus: refundNote, refundAmount, refundId,
      message: wasOnlinePayment && refundAmount > 0
        ? `Booking cancelled. ₹${refundAmount} refund has been initiated and will reflect in 5-7 business days.`
        : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("cancelbooking error: - server.js:892", err);
    return res.status(500).json({ success: false, error: err.message || "Cancellation failed. Please try again." });
  }
});

// =======================================================
// ✅ ADMIN CANCEL BOOKING
// =======================================================
app.post("/admin-cancel-booking", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { bookingId, reason, note } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: "bookingId is required" });

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();
    if (booking.status === "cancelled") return res.status(400).json({ success: false, error: "Already cancelled" });

    const paidAmount   = Number(booking.paidAmount || booking.advanceAmount || 0);
    const paymentId    = booking.paymentId || null;
    const wasOnline    = !!paymentId;
    const refundAmount = wasOnline ? paidAmount : 0;

    await bookingRef.update({
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           "admin",
      cancellationReason:    reason || "Cancelled by admin",
      adminCancelNote:       note   || "",
      refundStatus:          wasOnline ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });

    let refundId = null, refundNote = "no_refund";
    if (wasOnline && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes:  { bookingId, reason: reason || "Admin cancelled" },
          speed:  "normal",
        });
        refundId   = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId, refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (refundErr) {
        console.error("Admin refund failed: - server.js:942", refundErr.message);
        await bookingRef.update({ refundStatus: "failed", refundError: refundErr.message });
        refundNote = "refund_failed";
      }
    }

    sendPushToUser(booking.userId, "❌ Booking Cancelled by Venue",
      wasOnline && refundAmount > 0
        ? `Your booking at ${booking.turfName} on ${booking.dateString} was cancelled. Reason: ${reason}. ₹${refundAmount} refund initiated (5–7 days).`
        : `Your booking at ${booking.turfName} on ${booking.dateString} was cancelled. Reason: ${reason}.`,
      { screen: "bookings", bookingId }
    );
    if (booking.ownerId) {
      sendPushToUser(booking.ownerId, "🔔 Booking Cancelled by Admin",
        `Admin cancelled a booking at ${booking.turfName} on ${booking.dateString}. Reason: ${reason}.`,
        { screen: "owner-bookings" }
      );
    }

    return res.json({
      success: true, bookingId, refundStatus: refundNote, refundAmount, refundId,
      message: wasOnline && refundAmount > 0 ? `Booking cancelled. ₹${refundAmount} refund initiated.` : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("admincancelbooking error: - server.js:966", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =======================================================
// 🔍 REFUND STATUS
// =======================================================
app.get("/refund-status/:bookingId", refundStatusLimiter, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { userId }   = req.query;
    if (!bookingId || !userId) return res.status(400).json({ success: false, error: "bookingId and userId required" });

    const bookingDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();
    if (booking.userId !== userId) return res.status(403).json({ success: false, error: "Unauthorised" });

    if (booking.refundId) {
      try {
        const refund = await razorpay.payments.fetchRefund(booking.paymentId, booking.refundId);
        return res.json({
          success: true, refundId: refund.id, refundStatus: refund.status,
          refundAmount: refund.amount / 100, processedAt: refund.created_at,
        });
      } catch (e) { /* fall through to Firestore data */ }
    }

    return res.json({
      success: true, refundId: booking.refundId || null,
      refundStatus: booking.refundStatus || "not_applicable",
      refundAmount: booking.refundAmount || 0,
    });
  } catch (err) {
    console.error("refundstatus error: - server.js:1001", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =======================================================
// 👤 CREATE OWNER
// =======================================================
app.post("/create-owner", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { name, email, phone, password, businessName, location, description,
            bankAccountNo, bankIfsc, bankName, bankUpi } = req.body;

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
      name, email, phone, businessName,
      location: location || "", description: description || "",
      role: "owner", status: "active",
      banking: {
        accountNo: String(bankAccountNo).trim(),
        ifsc:      ifscClean,
        name:      String(bankName).trim(),
        upi:       bankUpi ? String(bankUpi).trim() : null,
        verified:  false,
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
// =======================================================
app.post("/create-operator", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { name, email, phone, password, ownerId, turfId, turfName } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    await db.collection("users").doc(userRecord.uid).set({
      name, email, phone: phone || "", role: "turf-operator",
      ownerId: ownerId || null, turfId: turfId || null, turfName: turfName || "",
      status: "active", createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 🏆 CREATE LEAGUE OWNER
// =======================================================
app.post("/create-league-owner", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    if (req.callerRole !== "admin") {
      return res.status(403).json({ success: false, error: "Only admins can create league owners." });
    }
    const { name, email, phone, password, organizationName, city, description,
            bankAccountNo, bankIfsc, bankName, bankUpi } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: "Name is required." });
    if (!email || !String(email).trim()) return res.status(400).json({ success: false, error: "Email is required." });
    if (!password || String(password).length < 6) return res.status(400).json({ success: false, error: "Password must be at least 6 characters." });
    if (!city || !String(city).trim()) return res.status(400).json({ success: false, error: "City is required." });

    let banking = null;
    if (bankAccountNo || bankIfsc || bankName) {
      const ifscClean = String(bankIfsc || "").trim().toUpperCase();
      if (!bankAccountNo || String(bankAccountNo).trim().length < 9)
        return res.status(400).json({ success: false, error: "Bank account number looks invalid." });
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscClean))
        return res.status(400).json({ success: false, error: "Valid IFSC code is required (e.g. SBIN0001234)." });
      banking = {
        accountNo: String(bankAccountNo).trim(), ifsc: ifscClean,
        name:      String(bankName || name).trim(),
        upi:       bankUpi ? String(bankUpi).trim() : null,
        verified:  false, addedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    }

    const userRecord = await admin.auth().createUser({
      email: String(email).trim(), password, displayName: name,
    });
    await db.collection("users").doc(userRecord.uid).set({
      name:             String(name).trim(),
      email:            String(email).trim(),
      phone:            phone ? String(phone).trim() : "",
      organizationName: organizationName ? String(organizationName).trim() : "",
      city:             String(city).trim(),
      description:      description ? String(description).trim() : "",
      role:             "league-owner",
      status:           "active",
      banking,
      createdAt:        admin.firestore.FieldValue.serverTimestamp(),
      createdBy:        req.callerUid,
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    console.error("createleagueowner error: - server.js:1115", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 🗑️ DELETE OWNER
// =======================================================
app.delete("/delete-owner/:uid", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, error: "uid is required" });

    const turfSnap = await db.collection("turfs").where("ownerId", "==", uid).get();
    if (!turfSnap.empty) {
      const batch = db.batch();
      turfSnap.docs.forEach((d) => batch.update(d.ref, { active: false, deactivatedReason: "owner_deleted" }));
      await batch.commit();
    }

    const operatorSnap = await db.collection("users")
      .where("role", "==", "turf-operator").where("ownerId", "==", uid).get();
    if (!operatorSnap.empty) {
      const batch = db.batch();
      operatorSnap.docs.forEach((d) =>
        batch.update(d.ref, { ownerId: null, turfId: null, turfName: "", status: "inactive" })
      );
      await batch.commit();
    }

    await admin.auth().deleteUser(uid);
    await db.collection("users").doc(uid).delete();

    res.json({ success: true, turfsDeactivated: turfSnap.size, operatorsUnlinked: operatorSnap.size });
  } catch (e) {
    console.error("deleteowner error: - server.js:1150", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 🏋️ CREATE GYM MEMBERSHIP ORDER
// =======================================================
app.post("/create-gym-order", orderLimiter, async (req, res) => {
  try {
    const { gymId, planId, userId, customerName, customerPhone, batch, promoId, promoCode } = req.body;
    if (!gymId || !planId) return res.status(400).json({ error: "gymId and planId are required" });

    const gymDoc = await db.collection("gyms").doc(gymId).get();
    if (!gymDoc.exists) return res.status(404).json({ error: "Gym not found" });
    const gym = gymDoc.data();
    if (gym.active === false) return res.status(400).json({ error: "This gym is not currently available" });

    const maxMembers = Number(gym.maxMembers || 0);
    if (maxMembers > 0) {
      const now        = new Date();
      const activeSnap = await db.collection("memberships")
        .where("gymId", "==", gymId)
        .where("endDate", ">", admin.firestore.Timestamp.fromDate(now))
        .get();
      if (activeSnap.size >= maxMembers) {
        return res.status(409).json({ error: "This gym is full right now. No slots left." });
      }
    }

    const plans = Array.isArray(gym.plans) ? gym.plans : [];
    const plan  = plans.find((p) => p.id === planId);
    if (!plan) return res.status(400).json({ error: "Invalid membership plan" });

    const fullPrice = Number(plan.price);
    const months    = Number(plan.months || 1);
    if (!fullPrice || fullPrice <= 0) return res.status(400).json({ error: "Invalid plan amount" });

    let discount = 0;
    if (promoId) {
      const pSnap = await db.collection("promoCodes").doc(promoId).get();
      if (pSnap.exists && pSnap.data().active) {
        const promo = pSnap.data();
        const now  = new Date();
        const from = promo.validFrom?.toDate ? promo.validFrom.toDate() : new Date(promo.validFrom);
        const to   = promo.validTo?.toDate   ? promo.validTo.toDate()   : new Date(promo.validTo);
        const okWindow = (!from || now >= from) && (!to || now <= to);
        const okUses   = !(promo.totalUses > 0 && promo.usedCount >= promo.totalUses);
        if (okWindow && okUses) {
          if (promo.type === "flat") discount = Number(promo.value);
          else if (promo.type === "percent") {
            discount = Math.round((fullPrice * Number(promo.value)) / 100);
            if (promo.maxDiscount > 0) discount = Math.min(discount, promo.maxDiscount);
          }
          discount = Math.max(0, Math.min(discount, fullPrice));
        }
      }
    }
    const amount = Math.max(fullPrice - discount, 1);

    const order = await razorpay.orders.create({ amount: amount * 100, currency: "INR", receipt: "gym_" + Date.now() });

    await db.collection("gymOrders").doc(order.id).set({
      gymId, gymName: gym.name || "", gymLocation: gym.location || "",
      image: (Array.isArray(gym.images) && gym.images[0]) || gym.image || "",
      ownerId: gym.ownerId || null, ownerName: gym.ownerName || "",
      userId: userId || null,
      planId: plan.id, planLabel: plan.label, months,
      fullPrice, discount, amount,
      promoId: promoId || null, promoCode: promoCode || null,
      customerName: customerName || "", customerPhone: customerPhone || "", batch: batch || "",
      orderId: order.id, orderStatus: "created", paymentStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.KEY_ID });
  } catch (err) {
    console.error("creategymorder error: - server.js:1227", err);
    return res.status(500).json({ error: err.message });
  }
});

// =======================================================
// 🏋️ VERIFY GYM PAYMENT
// =======================================================
app.post("/verify-gym-payment", verifyLimiter, async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;
    if (!order_id || !payment_id || !signature) return res.status(400).json({ success: false, error: "Missing fields" });

    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");
    if (expectedSignature !== signature) return res.status(400).json({ success: false, error: "Invalid signature" });

    const payment = await razorpay.payments.fetch(payment_id);
    if (payment.status !== "captured") return res.status(400).json({ success: false, error: "Payment not captured" });

    const orderRef = db.collection("gymOrders").doc(order_id);
    let membershipId = null, alreadyPaid = false, orderData = null;

    await db.runTransaction(async (txn) => {
      const orderDoc = await txn.get(orderRef);
      if (!orderDoc.exists) throw new Error("Order not found");
      orderData = orderDoc.data();
      if (orderData.orderStatus === "paid") { alreadyPaid = true; return; }

      const start = new Date();
      const end   = new Date(start);
      end.setMonth(end.getMonth() + Number(orderData.months || 1));

      const memRef = db.collection("memberships").doc();
      membershipId = memRef.id;

      txn.set(memRef, {
        userId: orderData.userId || null,
        gymId: orderData.gymId, gymName: orderData.gymName,
        ownerId: orderData.ownerId || null,
        planId: orderData.planId, planLabel: orderData.planLabel, months: orderData.months,
        amount: orderData.amount, fullPrice: orderData.fullPrice || orderData.amount,
        discount: orderData.discount || 0,
        promoId: orderData.promoId || null, promoCode: orderData.promoCode || null,
        customerName: orderData.customerName || "", phone: orderData.customerPhone || "",
        batch: orderData.batch || "", source: "app",
        startDate: admin.firestore.Timestamp.fromDate(start),
        endDate:   admin.firestore.Timestamp.fromDate(end),
        paymentId: payment_id, orderId: order_id, status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      txn.update(orderRef, {
        orderStatus: "paid", paymentStatus: "paid", paymentId: payment_id,
        membershipId, paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    if (alreadyPaid) {
      const existing = await db.collection("memberships").where("orderId", "==", order_id).limit(1).get();
      return res.json({ success: true, membershipId: existing.empty ? null : existing.docs[0].id });
    }

    if (orderData.promoId && membershipId) {
      try {
        await db.collection("promoUsage").add({
          promoId: orderData.promoId, promoCode: orderData.promoCode || "",
          userId: orderData.userId, bookingId: membershipId, gymId: orderData.gymId,
          discountApplied: orderData.discount || 0,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection("promoCodes").doc(orderData.promoId).update({
          usedCount: admin.firestore.FieldValue.increment(1),
        });
      } catch (e) { console.warn("gym promo usage failed: - server.js:1303", e.message); }
    }

    sendPushToUser(orderData.userId, "🎉 Membership Active!",
      `Your ${orderData.planLabel} membership at ${orderData.gymName} is now active.`,
      { screen: "memberships", membershipId }
    );
    if (orderData.ownerId) {
      sendPushToUser(orderData.ownerId, "💪 New Member",
        `Someone just bought a ${orderData.planLabel} plan at ${orderData.gymName}.`,
        { screen: "owner-gym", membershipId }
      );
    }

    return res.json({ success: true, membershipId });
  } catch (err) {
    console.error("verifygympayment error: - server.js:1319", err);
    return res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});

// =======================================================
// 🏆 LEAGUES
// =======================================================
const LEAGUE_FORMATS = ["round_robin", "knockout", "groups_knockout"];

app.post("/create-league", adminActionLimiter, requireLeagueOwnerOrAdmin, async (req, res) => {
  try {
    const { name, sport, format, city, venue, description, startDate, registrationDeadline,
            entryFee, maxTeams, prizePoolPercent, hostType } = req.body;
    const ht = hostType === "open" ? "open" : "managed";

    if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: "League name is required." });
    if (!sport || !String(sport).trim()) return res.status(400).json({ success: false, error: "Sport is required." });
    if (!LEAGUE_FORMATS.includes(format)) return res.status(400).json({ success: false, error: "Invalid league format." });
    if (!city || !String(city).trim()) return res.status(400).json({ success: false, error: "City is required." });

    let fee   = Number(entryFee || 0);
    let teams = Number(maxTeams || 0);
    const prize = Number(prizePoolPercent || 0);

    if (ht === "open") {
      if (isNaN(fee) || fee < 0) return res.status(400).json({ success: false, error: "Entry fee must be 0 or more." });
      if (isNaN(teams) || teams < 2) return res.status(400).json({ success: false, error: "Max teams must be at least 2." });
    } else {
      if (isNaN(fee) || fee < 0) fee = 0;
      if (isNaN(teams) || teams < 0) teams = 0;
    }
    if (isNaN(prize) || prize < 0 || prize > 100) return res.status(400).json({ success: false, error: "Prize pool % must be 0–100." });

    const ref = db.collection("leagues").doc();
    await ref.set({
      name: String(name).trim(), sport: String(sport).trim(), format, hostType: ht,
      city: String(city).trim(), venue: venue ? String(venue).trim() : "",
      description: description ? String(description).trim() : "",
      startDate: startDate ? String(startDate).trim() : "",
      registrationDeadline: ht === "open" && registrationDeadline ? String(registrationDeadline).trim() : "",
      entryFee: fee, maxTeams: teams, prizePoolPercent: prize,
      teamCount: 0, status: ht === "open" ? "registration_open" : "ongoing",
      organizerId: req.callerUid, organizerName: req.callerName || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, leagueId: ref.id });
  } catch (e) {
    console.error("createleague error: - server.js:1368", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /add-team  — league owner adds a team with optional player UID linking
// REPLACE your existing /add-team handler with this entire block
// ─────────────────────────────────────────────────────────────────────────────
app.post("/add-team", requireLeagueOwnerOrAdmin, async (req, res) => {
  try {
    const { leagueId, name, captainName, players } = req.body;

    if (!leagueId) return res.status(400).json({ error: "leagueId required" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Team name required" });

    // Validate league exists
    const leagueRef = db.collection("leagues").doc(leagueId);
    const leagueSnap = await leagueRef.get();
    if (!leagueSnap.exists) return res.status(404).json({ error: "League not found" });
    if (req.callerRole !== "admin" && leagueSnap.data().organizerId !== req.callerUid) {
  return res.status(403).json({ error: "You don't manage this league" });
}

    // ── Build clean player list ───────────────────────────────────────────────
    // players is an array of: { name, uid?, playonId? }
    // uid and playonId are optional — players without a Playon ID are still accepted
    const cleanPlayers = Array.isArray(players)
      ? players
          .filter((p) => p && String(p.name || "").trim())
          .map((p) => ({
            name: String(p.name).trim(),
            ...(p.uid      ? { uid: String(p.uid).trim() }           : {}),
            ...(p.playonId ? { playonId: String(p.playonId).trim() } : {}),
          }))
      : [];

    // ── Extract playerUids[] — top-level array for easy querying ─────────────
    // This is what "My Leagues" and "Stats" screens query later:
    //   query(collection(db, "leagueTeams"), where("playerUids", "array-contains", uid))
    const playerUids = cleanPlayers
      .filter((p) => p.uid)
      .map((p) => p.uid);

    // ── Write the team document ───────────────────────────────────────────────
    const teamRef = db.collection("leagueTeams").doc();
    await teamRef.set({
      leagueId,
      name:        String(name).trim(),
      captainName: captainName ? String(captainName).trim() : "",
      players:     cleanPlayers,
      playerUids,               // ← new field — uids of linked players only
      playerCount: cleanPlayers.length,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── Increment league teamCount ────────────────────────────────────────────
    await leagueRef.update({
      teamCount: admin.firestore.FieldValue.increment(1),
    });

    return res.json({
      success: true,
      teamId:  teamRef.id,
      playerCount: cleanPlayers.length,
      linkedCount: playerUids.length,
    });
  } catch (err) {
    console.error("addteam error: - server.js:1436", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/add-match", adminActionLimiter, requireLeagueOwnerOrAdmin, async (req, res) => {
  try {
    const { leagueId, teamAId, teamBId, date, startTime, endTime, venue } = req.body;
    if (!leagueId) return res.status(400).json({ success: false, error: "leagueId is required." });
    if (!teamAId || !teamBId) return res.status(400).json({ success: false, error: "Both teams are required." });
    if (teamAId === teamBId) return res.status(400).json({ success: false, error: "A team cannot play itself." });

    const leagueSnap = await db.collection("leagues").doc(leagueId).get();
    if (!leagueSnap.exists) return res.status(404).json({ success: false, error: "League not found." });
    const league = leagueSnap.data();
    if (req.callerRole !== "admin" && league.organizerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You don't manage this league." });
    }

    const [aSnap, bSnap] = await Promise.all([
      db.collection("leagueTeams").doc(teamAId).get(),
      db.collection("leagueTeams").doc(teamBId).get(),
    ]);
    if (!aSnap.exists || !bSnap.exists) return res.status(404).json({ success: false, error: "One of the teams was not found." });
    const a = aSnap.data(), b = bSnap.data();
    if (a.leagueId !== leagueId || b.leagueId !== leagueId) {
      return res.status(400).json({ success: false, error: "Both teams must belong to this league." });
    }

    const ref = db.collection("leagueMatches").doc();
    await ref.set({
      leagueId,
      teamAId, teamAName: a.name || "Team A",
      teamBId, teamBName: b.name || "Team B",
      date: date ? String(date).trim() : "",
      startTime: startTime ? String(startTime).trim() : "",
      endTime:   endTime   ? String(endTime).trim()   : "",
      venue:     venue     ? String(venue).trim()     : "",
      status: "scheduled", scoreA: 0, scoreB: 0, winnerId: null,
      organizerId: league.organizerId || null, sport: league.sport || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, matchId: ref.id });
  } catch (e) {
    console.error("addmatch error: - server.js:1481", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 📊 UPDATE MATCH SCORE + AUTO PLAYER STATS ENGINE
// When status = "completed": writes wins/losses/draws to
// every playerProfiles/{uid} for players in both teams.
// Players without a uid (unregistered walk-ins) are skipped.
// =======================================================
app.post("/update-match-score", adminActionLimiter, requireLeagueOwnerOrAdmin, async (req, res) => {
  try {
    const { matchId, scoreA, scoreB, status, liveSummary } = req.body;
    if (!matchId) return res.status(400).json({ success: false, error: "matchId is required." });

    const matchRef  = db.collection("leagueMatches").doc(matchId);
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists) return res.status(404).json({ success: false, error: "Match not found." });
    const match = matchSnap.data();

    if (req.callerRole !== "admin" && match.organizerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You don't manage this match's league." });
    }

    const sA = Number(scoreA ?? match.scoreA ?? 0);
    const sB = Number(scoreB ?? match.scoreB ?? 0);
    const newStatus = status || match.status;

    await matchRef.update({
      scoreA:      sA,
      scoreB:      sB,
      status:      newStatus,
      liveSummary: liveSummary !== undefined ? String(liveSummary) : (match.liveSummary || ""),
      winnerId:    newStatus === "completed"
        ? (sA > sB ? match.teamAId : sA < sB ? match.teamBId : null)
        : match.winnerId || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── Stats engine: only runs on completion ─────────────────────────────
    if (newStatus === "completed" && match.status !== "completed") {
      const resultA = sA > sB ? "win" : sA < sB ? "loss" : "draw";
      const resultB = sA > sB ? "loss" : sA < sB ? "win" : "draw";

      const [teamASnap, teamBSnap] = await Promise.all([
        db.collection("leagueTeams").doc(match.teamAId).get(),
        db.collection("leagueTeams").doc(match.teamBId).get(),
      ]);

      // Helper: update one team's players
      const updateTeamPlayers = async (teamSnap, result) => {
        if (!teamSnap.exists) return;
        const players = teamSnap.data().players || [];
        await Promise.allSettled(
          players
            .filter((p) => !!p.uid)   // only registered players with a Playon ID
            .map(async (player) => {
              try {
                const profileRef  = db.collection("playerProfiles").doc(player.uid);
                const profileSnap = await profileRef.get();
                if (!profileSnap.exists) return; // no profile yet — skip silently

                const s = profileSnap.data().stats || { matches: 0, wins: 0, losses: 0, draws: 0 };
                await profileRef.update({
                  "stats.matches": (Number(s.matches) || 0) + 1,
                  "stats.wins":    (Number(s.wins)    || 0) + (result === "win"  ? 1 : 0),
                  "stats.losses":  (Number(s.losses)  || 0) + (result === "loss" ? 1 : 0),
                  "stats.draws":   (Number(s.draws)   || 0) + (result === "draw" ? 1 : 0),
                });
                console.log(`Stats updated: uid=${player.uid} result=${result} - server.js:1551`);
              } catch (e) {
                console.error(`Stats update failed for uid=${player.uid}: - server.js:1553`, e.message);
              }
            })
        );
      };

      await Promise.all([
        updateTeamPlayers(teamASnap, resultA),
        updateTeamPlayers(teamBSnap, resultB),
      ]);

      console.log(`Match ${matchId} completed. Stats engine done. A:${sA} B:${sB} - server.js:1564`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error("updatematchscore error: - server.js:1569", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// =======================================================
// 👤 PLAYER PROFILE — CREATE ORDER (fee > 0 path)
// Reads fee from appConfig/playerProfile.
// Guards: uid uniqueness, playonId uniqueness, fee validation.
// =======================================================
app.post("/create-player-profile-order", profileLimiter, requireAuth, async (req, res) => {
  try {
    const { playonId, sports, bio, age, playerRole, battingHand, bowlingStyle, isRenewal } = req.body;
    const uid = req.callerUid;

    // Read admin config first (needed for both new + renewal)
    const configSnap = await db.collection("appConfig").doc("playerProfile").get();
    const fee        = configSnap.exists ? Number(configSnap.data().fee ?? 0) : 0;
    const enabled    = configSnap.exists ? configSnap.data().enabled !== false : true;

    if (!enabled) {
      return res.status(400).json({ success: false, error: "Player profile creation is currently disabled." });
    }
    if (fee <= 0) {
      return res.status(400).json({ success: false, error: "Profile creation is free — use the free endpoint instead." });
    }

    const existingProfile = await db.collection("playerProfiles").doc(uid).get();

    if (isRenewal) {
      // ── RENEWAL: profile must already exist ──────────────────────────────
      if (!existingProfile.exists) {
        return res.status(400).json({ success: false, error: "No profile found to renew." });
      }
    } else {
      // ── NEW PROFILE ───────────────────────────────────────────────────────
      if (existingProfile.exists) {
        return res.status(400).json({ success: false, error: "You already have a Playon ID." });
      }

      const cleanId = String(playonId || "").trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(cleanId)) {
        return res.status(400).json({ success: false, error: "Playon ID must be 3–24 chars: lowercase letters, numbers, underscore only." });
      }

      const idSnap = await db.collection("playerProfiles")
        .where("playonId", "==", cleanId).limit(1).get();
      if (!idSnap.empty) {
        return res.status(400).json({ success: false, error: "This Playon ID is already taken. Try another one." });
      }
    }

    // Fetch user display name
    let displayName = "Player";
    try {
      const uSnap = await db.collection("users").doc(uid).get();
      if (uSnap.exists) displayName = uSnap.data().name || "Player";
    } catch {}

    const cleanId = isRenewal
      ? (existingProfile.data().playonId || "")
      : String(playonId || "").trim().toLowerCase();

    const order = await razorpay.orders.create({
      amount:   Math.round(fee * 100),
      currency: "INR",
      receipt:  `profile_${Date.now()}`,
      notes:    { uid, playonId: cleanId, type: isRenewal ? "profile_renewal" : "player_profile" },
    });

    // Store metadata for verify step
    await db.collection("pendingProfileOrders").doc(order.id).set({
      uid,
      playonId:    cleanId,
      displayName,
      sports:      Array.isArray(sports) ? sports : (isRenewal ? (existingProfile.data().sports || []) : []),
      bio:         isRenewal ? (existingProfile.data().bio || "") : String(bio || "").slice(0, 120),
      age:         age || null,
      playerRole:  playerRole || null,
      battingHand: battingHand || null,
      bowlingStyle:bowlingStyle || null,
      fee,
      isRenewal:   !!isRenewal,
      orderCreatedAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // pending order TTL
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.KEY_ID,
    });
  } catch (err) {
    console.error("createplayerprofileorder error: - server.js:1663", err);
    return res.status(500).json({ success: false, error: err.message || "Could not create order." });
  }
});

// =======================================================
// 👤 PLAYER PROFILE — VERIFY PAYMENT
// Works for both new profile creation AND yearly renewal.
// p.isRenewal === true  → merge-update expiresAt only, keep all stats intact
// p.isRenewal === false → create full profile doc from scratch
// Race-condition guard on new creation: ID taken between order & payment → auto-refund
// =======================================================
app.post("/verify-player-profile-payment", verifyLimiter, async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;
    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false, error: "Missing payment fields." });
    }

    // Signature check
    const expected = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(`${order_id}|${payment_id}`)
      .digest("hex");
    if (expected !== signature) {
      return res.status(400).json({ success: false, error: "Invalid payment signature." });
    }

    // Confirm captured at Razorpay
    const payment = await razorpay.payments.fetch(payment_id);
    if (payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured." });
    }

    // Load pending order metadata
    const pendingSnap = await db.collection("pendingProfileOrders").doc(order_id).get();
    if (!pendingSnap.exists) {
      return res.status(404).json({ success: false, error: "Order not found or already used." });
    }
    const p = pendingSnap.data();

    // Calculate new expiry: 1 year from now
    const newExpiresAt = new Date();
    newExpiresAt.setFullYear(newExpiresAt.getFullYear() + 1);
    const expiresAtTimestamp = admin.firestore.Timestamp.fromDate(newExpiresAt);

    if (p.isRenewal) {
      // ── RENEWAL: only update expiry fields, keep all stats/playonId/sports intact ──
      const profileRef = db.collection("playerProfiles").doc(p.uid);
      const profileSnap = await profileRef.get();
      if (!profileSnap.exists) {
        // Edge case: profile deleted after renewal order was created
        await db.collection("pendingProfileOrders").doc(order_id).delete().catch(() => {});
        return res.status(404).json({ success: false, error: "Profile not found. Cannot renew." });
      }

      await profileRef.update({
        expiresAt:      expiresAtTimestamp,
        lastRenewedAt:  admin.firestore.FieldValue.serverTimestamp(),
        lastPaymentId:  payment_id,
        lastOrderId:    order_id,
        feePaid:        p.fee,
        isExpired:      false,
      });

      await db.collection("pendingProfileOrders").doc(order_id).delete().catch(() => {});

      sendPushToUser(p.uid, "✅ Playon Pro Renewed!",
        `Your @${p.playonId} profile is active for another year. Keep playing!`,
        { screen: "profile" }
      );

      return res.json({ success: true, isRenewal: true, expiresAt: newExpiresAt.toISOString() });
    }

    // ── NEW PROFILE ───────────────────────────────────────────────────────────

    // Idempotency: already created (e.g. duplicate verify call)
    const existingProfile = await db.collection("playerProfiles").doc(p.uid).get();
    if (existingProfile.exists && !existingProfile.data().isExpired) {
      await db.collection("pendingProfileOrders").doc(order_id).delete().catch(() => {});
      return res.json({ success: true, alreadyExists: true });
    }

    // Race-condition guard: ID taken between order creation and payment
    const idSnap = await db.collection("playerProfiles")
      .where("playonId", "==", p.playonId).limit(1).get();
    if (!idSnap.empty) {
      try {
        await razorpay.payments.refund(payment_id, {
          amount: Math.round(p.fee * 100),
          notes:  { reason: "Playon ID was taken by another user during checkout." },
          speed:  "normal",
        });
        console.log(`Autorefund issued for profile order ${order_id}  ID taken - server.js:1757`);
      } catch (refundErr) {
        console.error("Profile order refund failed: - server.js:1759", refundErr.message);
      }
      await db.collection("pendingProfileOrders").doc(order_id).delete().catch(() => {});
      return res.status(409).json({
        success:      false,
        autoRefunded: true,
        error:        "This Playon ID was just taken by someone else. Your payment has been refunded.",
      });
    }

    // Write full profile
    await db.collection("playerProfiles").doc(p.uid).set({
      playonId:    p.playonId,
      displayName: p.displayName,
      sports:      p.sports      || [],
      bio:         p.bio         || "",
      age:         p.age         || null,
      playerRole:  p.playerRole  || null,
      battingHand: p.battingHand || null,
      bowlingStyle:p.bowlingStyle|| null,
      stats: {
        matches: 0, wins: 0, losses: 0, draws: 0,
        runs: 0, wickets: 0, fifties: 0, hundreds: 0,
        goals: 0, assists: 0, points: 0,
      },
      rating:         0,
      isProPlayer:    false,
      isExpired:      false,
      expiresAt:      expiresAtTimestamp,
      orderId:        order_id,
      paymentId:      payment_id,
      lastPaymentId:  payment_id,
      lastOrderId:    order_id,
      feePaid:        p.fee,
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("pendingProfileOrders").doc(order_id).delete().catch(() => {});

    sendPushToUser(p.uid, "🎉 Playon ID Created!",
      `Welcome @${p.playonId}! Your profile is live for 1 year. Join a league to start tracking your stats.`,
      { screen: "profile" }
    );

    return res.json({ success: true, isRenewal: false, expiresAt: newExpiresAt.toISOString() });
  } catch (err) {
    console.error("verifyplayerprofilepayment error: - server.js:1805", err);
    return res.status(500).json({ success: false, error: err.message || "Verification failed." });
  }
});

// =======================================================
// ⏰ DAY-BEFORE REMINDERS (cron)
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
        await sendPushToUser(b.userId, "⏰ Reminder: Booking Tomorrow",
          `You have a slot at ${b.turfName || "your turf"} tomorrow. Slots: ${slots || "check the app"}.`,
          { screen: "bookings", bookingId: b.id }
        );
        sent++;
      })
    );

    return res.json({ success: true, sent, total: tomorrowBookings.length });
  } catch (e) {
    console.error("sendreminders error: - server.js:1845", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// 📢 ADMIN SEND NOTIFICATION
// =======================================================
app.post("/send-admin-notification", requireAdminOrOwner, async (req, res) => {
  try {
    const { title, body, userId, role, data, imageUrl } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, error: "title and body are required" });

    if (userId) {
      await sendPushToUser(userId, title, body, data || {});
      return res.json({ success: true, message: "Notification sent to user" });
    }

    let q = db.collection("users");
    if (role) q = q.where("role", "==", role);
    const snap = await q.get();
    let total = 0;

    await Promise.allSettled(
      snap.docs.map(async (docSnap) => {
        const u = docSnap.data();
        if (!u.expoPushToken) return;
        await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            to: u.expoPushToken, sound: "default", title, body, data: data || {},
            channelId: "bookora-default", priority: "high",
            ...(imageUrl ? { richContent: { image: imageUrl } } : {}),
          }),
        });
        total++;
      })
    );

    return res.json({ success: true, total, message: "Notifications sent" });
  } catch (e) {
    console.error("sendadminnotification error: - server.js:1887", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// 📋 BOOKING RULES (public)
// =======================================================
app.get("/booking-rules", async (req, res) => {
  try {
    const hours = await getCancellationWindowHours();
    return res.json({ success: true, cancellationWindowHours: hours });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// ✅ HEALTH CHECK
// =======================================================
app.get("/", (req, res) => res.send("Bookora server running ✅"));

// =======================================================
// ❌ GLOBAL ERROR HANDLER
// =======================================================
app.use((err, req, res, next) => {
  console.error("Global Error: - server.js:1913", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// =======================================================
// 🚀 START
// =======================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT} ✅ - server.js:1921`));