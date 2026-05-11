const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// =======================================================
// 🚦 RATE LIMITING
// Run: npm install express-rate-limit
// =======================================================
const rateLimit = require("express-rate-limit");

const rateLimitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    error: "Too many requests. Please wait a moment and try again.",
  });
};

// /create-order — creates real Razorpay orders (10 per 10 min per IP)
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// /verify-payment — writes booking to Firestore (20 per 10 min per IP)
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// /cancel-booking — triggers Razorpay refunds (5 per 10 min per IP)
const cancelLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// /refund-status — calls Razorpay API (30 per 10 min per IP)
const refundStatusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// /create-owner, /create-operator, /delete-owner — account ops (10 per hour per IP)
const adminActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
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
    await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token, sound: "default",
        title, body, data,
        channelId: "bookora-default",
        priority: "high",
      }),
    });
    console.log(`Push sent ✅ to ${userId} - server.js:88`);
  } catch (e) {
    console.error("sendPushToUser failed (nonfatal): - server.js:90", e.message);
  }
}


// =======================================================
// 🔥 Firebase Admin Init
// =======================================================
const serviceAccount = require("./serviceAccountKey.json");

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("Firebase connected ✅ - server.js:105");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:107", e);
}

const db = admin.firestore();

const app = express();

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
  const startPart =
    slot.split("-")[0].trim();

  const timeParts = startPart.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );

  let hour = 0;

  if (timeParts) {
    hour = parseInt(timeParts[1]);

    const meridiem =
      timeParts[3].toUpperCase();

    if (
      meridiem === "PM" &&
      hour < 12
    ) {
      hour += 12;
    }

    if (
      meridiem === "AM" &&
      hour === 12
    ) {
      hour = 0;
    }
  }

  return hour;
}



// =======================================================
// ✅ CREATE ORDER
// =======================================================
app.post("/create-order", orderLimiter, async (req, res) => {
    try {
      const {
        turfId,
        slots,
        dateString,
        userId,
        bookingType,
      } = req.body;

      // ===================================================
      // ✅ Validation
      // ===================================================

      if (!turfId || !dateString) {
        return res.status(400).json({
          error:
            "turfId and dateString required",
        });
      }

      if (
        !Array.isArray(slots) ||
        slots.length === 0
      ) {
        return res.status(400).json({
          error: "slots required",
        });
      }

      // ===================================================
      // ✅ Fetch Turf
      // ===================================================

      const turfDoc = await db
        .collection("turfs")
        .doc(turfId)
        .get();

      if (!turfDoc.exists) {
        return res.status(404).json({
          error: "Turf not found",
        });
      }

      const turf = turfDoc.data();

      // ===================================================
      // ✅ Special Prices
      // ===================================================

      const specialSnap = await db
        .collection("specialPrices")
        .where("turfId", "==", turfId)
        .where("date", "==", dateString)
        .get();

      const specialPrices =
        specialSnap.docs.map((d) =>
          d.data()
        );

      // ===================================================
      // ✅ Already Booked
      // ===================================================

      const bookingSnap = await db
        .collection("bookings")
        .where("turfId", "==", turfId)
        .where(
          "dateString",
          "==",
          dateString
        )
        .get();

      const bookedSlots =
        bookingSnap.docs
          .map((d) => d.data())
          .filter(
            (b) =>
              b.status !== "cancelled"
          )
          .flatMap(
            (b) =>
              b.selectedSlots || []
          );

          // ===================================================
// ✅ Calculate Total Amount
// ===================================================
// ===================================================
// ✅ Prevent Already Booked Slots
// ===================================================

for (const slot of slots) {
  if (
    bookedSlots
      .map((s) => String(s).trim())
      .includes(String(slot).trim())
  ) {
    return res.status(400).json({
      error: `Slot already booked: ${slot}`,
    });
  }
}

// ===================================================
// ✅ Calculate Total Amount
// ===================================================

let totalAmount = 0;

for (const slot of slots) {
  const special = specialPrices.find(
    (s) =>
      String(s.slotTime).trim() ===
      String(slot).trim()
  );

  if (special) {
    totalAmount += Number(special.price);
  } else {
    const hour = parseHour(slot);

   let hourlyPrice = 0;

if (hour >= 6 && hour < 18) {
  hourlyPrice = parseFloat(
    turf.dayPrice || turf.price || 0
  );
} else {
  hourlyPrice = parseFloat(
    turf.nightPrice || turf.price || 0
  );
}

if (isNaN(hourlyPrice)) {
  hourlyPrice = 0;
}

// 30 minute slot price
totalAmount += hourlyPrice / 2;
  }
}
 if (totalAmount <= 0) {
  return res.status(400).json({
    error: "Invalid amount",
  });
}
      // ===================================================
      // ✅ Booking Type
      // ===================================================

      const finalBookingType =
  String(bookingType).trim().toLowerCase() === "full"
    ? "full"
    : "advance";

      // ===================================================
      // ✅ Advance Amount
      // ===================================================

      let advanceAmount = 0;

      if (finalBookingType === "full") {
  // Full payment
  advanceAmount = Number(totalAmount);
} else {
  // Advance payment only
  const perSlotAdvance = Number(turf.bookingPrice || 0);

  advanceAmount = perSlotAdvance * slots.length;

  // Safety check
  if (advanceAmount > totalAmount) {
    advanceAmount = totalAmount;
  }
}

      const remainingAmount =
        Math.max(
          totalAmount -
            advanceAmount,
          0
        );

      // ===================================================
      // ✅ Razorpay Order
      // ===================================================
      console.log("Booking Type: - server.js:365", finalBookingType);
console.log("Total Amount: - server.js:366", totalAmount);
console.log("Advance Amount: - server.js:367", advanceAmount);     
      
      const order =
        await razorpay.orders.create({
          amount:
            advanceAmount * 100,
          currency: "INR",
          receipt:
            "receipt_" +
            Date.now(),
        });

      // ===================================================
      // ✅ Save Order
      // ===================================================

      await db
        .collection("orders")
        .doc(order.id)
        .set({
          bookingType:
            finalBookingType,

          paymentMode:
            finalBookingType ===
            "full"
              ? "full_payment"
              : "advance_payment",

          turfId,

          turfName:
            turf.name || "",

          turfLocation:
            turf.location || "",

          image:
            Array.isArray(
              turf.images
            ) &&
            turf.images.length > 0
              ? turf.images[0]
              : turf.image || "",

          ownerId:
            turf.ownerId || null,

          ownerName:
            turf.ownerName || "",

          mapLink:
            turf.mapLink || "",

          userId:
            userId || null,

          slots,

          dateString,

          totalAmount,

          paidAmount:
            advanceAmount,

          advanceAmount,

          remainingAmount,

          orderId: order.id,

          orderStatus:
            "created",

          paymentStatus:
            "pending",

          verificationStatus:
            "pending",

          ownerSettlementStatus:
            "pending",

          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });

      return res.json({
        orderId: order.id,
        amount: order.amount,
        currency:
          order.currency,
        key: process.env.KEY_ID,
      });
    } catch (err) {
      console.error(
        "createorder error:",
        err
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);

// =======================================================
// ✅ VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", verifyLimiter, async (req, res) => {
    let order_id = null;

    try {
      const {
        order_id: incomingOrderId,
        payment_id,
        signature,
      } = req.body;

      order_id =
        incomingOrderId;

      // ===================================================
      // ✅ Validation
      // ===================================================

      if (
        !order_id ||
        !payment_id ||
        !signature
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Missing fields",
        });
      }

      // ===================================================
      // ✅ Verify Signature
      // ===================================================

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            process.env.KEY_SECRET
          )
          .update(
            order_id +
              "|" +
              payment_id
          )
          .digest("hex");

      if (
        expectedSignature !==
        signature
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid signature",
        });
      }

      // ===================================================
      // ✅ Fetch Order
      // ===================================================

      const orderRef = db
        .collection("orders")
        .doc(order_id);

      const orderDoc =
        await orderRef.get();

      if (!orderDoc.exists) {
        return res.status(404).json({
          success: false,
          error:
            "Order not found",
        });
      }

      const orderData =
        orderDoc.data();

      // ===================================================
      // ✅ Already Paid
      // ===================================================

      if (
        orderData.orderStatus ===
        "paid"
      ) {
        return res.json({
          success: true,
        });
      }

      // ===================================================
      // ✅ Verify Razorpay Payment
      // ===================================================

      const payment =
        await razorpay.payments.fetch(
          payment_id
        );

      if (
        payment.status !==
        "captured"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Payment not captured",
        });
      }

      // ===================================================
      // ✅ Fetch User
      // ===================================================

      let userName = "";
      let userPhone = "";
      let userEmail = "";

      if (orderData.userId) {
        const userDoc = await db
          .collection("users")
          .doc(orderData.userId)
          .get();

        if (userDoc.exists) {
          const u =
            userDoc.data();

          userName =
            u.name || "";

          userPhone =
            u.phone || "";

          userEmail =
            u.email || "";
        }
      }

      // ===================================================
      // ✅ Payment Status
      // ===================================================

      const paymentStatus =
        orderData.bookingType ===
        "full"
          ? "fully_paid"
          : "advance_paid";

      // ===================================================
      // ✅ Prevent Double Booking
      // ===================================================

      const existingBookingSnap =
        await db
          .collection(
            "bookings"
          )
          .where(
            "turfId",
            "==",
            orderData.turfId
          )
          .where(
            "dateString",
            "==",
            orderData.dateString
          )
          .get();

      const existingSlots =
        existingBookingSnap.docs
          .map((d) => d.data())
          .filter(
            (b) =>
              b.status !==
              "cancelled"
          )
          .flatMap(
            (b) =>
              b.selectedSlots ||
              []
          );

      for (const slot of orderData.slots) {
        if (
          existingSlots.includes(
            slot
          )
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Slot already booked during payment",
          });
        }
      }

      // ===================================================
      // ✅ Booking Date
      // ===================================================

      const parsedDate =
        new Date(
          orderData.dateString
        );

      const bookingDate =
        admin.firestore.Timestamp.fromDate(
          isNaN(
            parsedDate.getTime()
          )
            ? new Date()
            : parsedDate
        );

      // ===================================================
      // ✅ Batch
      // ===================================================

      const batch = db.batch();

      const bookingId = `${orderData.turfId}_${Date.now()}`;

      const bookingRef = db
        .collection(
          "bookings"
        )
        .doc(bookingId);

      batch.set(bookingRef, {

          bookingType:
            orderData.bookingType ||
            "advance",

          paymentMode:
            orderData.paymentMode ||
            "advance_payment",

          turfId:
            orderData.turfId,

          turfName:
            orderData.turfName,

          turfLocation:
            orderData.turfLocation,

          image:
            orderData.image,

          ownerId:
            orderData.ownerId,

          ownerName:
            orderData.ownerName,

          mapLink:
            orderData.mapLink,

          userId:
            orderData.userId ||
            null,

          userName,

          userPhone,

          userEmail,

          date: bookingDate,

          dateString:
            orderData.dateString,

          selectedSlots:
            orderData.slots,

          paymentId:
            payment_id,

          orderId: order_id,

          totalAmount:
            orderData.totalAmount,

          paidAmount:
            orderData.paidAmount,

          advanceAmount:
            orderData.advanceAmount,

          remainingAmount:
            orderData.remainingAmount,

          status:
            "confirmed",

          paymentStatus,

          verificationStatus:
            "verified",

          ownerSettlementStatus:
            "pending",

          refundStatus:
            "not_applicable",

          refundAmount: 0,

          cancelledAt:
            null,

          cancelledBy:
            null,

          cancellationReason:
            null,

          cancellationTimeLeft:
            null,

          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      // ===================================================
      // ✅ Update Order
      // ===================================================

      batch.update(orderRef, {
        orderStatus: "paid",

        paymentId:
          payment_id,

        paymentStatus,

        verificationStatus:
          "verified",

        paidAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

      // ===================================================
      // ✅ Remove Slot Locks
      // ===================================================

      const lockSnap = await db
        .collection(
          "slotLocks"
        )
        .where(
          "turfId",
          "==",
          orderData.turfId
        )
        .where(
  "dateString",
  "==",
  orderData.dateString
)
.where(
  "userId",
  "==",
  orderData.userId
)
        
        .get();

      const deletePromises = [];

      lockSnap.docs.forEach(
        (docSnap) => {
          const data =
            docSnap.data();

          if (
            orderData.slots.includes(
              data.slotTime
            )
          ) {
            deletePromises.push(
              docSnap.ref.delete()
            );
          }
        }
      );

       
      await Promise.all(deletePromises);

      // 🔔 Notify user — booking confirmed
      sendPushToUser(
        orderData.userId,
        "🎉 Booking Confirmed!",
        `Your slot at ${orderData.turfName} on ${orderData.dateString} is confirmed. See you there!`,
        { screen: "bookings", bookingId }
      );
      // 🔔 Notify owner — new booking received
      if (orderData.ownerId) {
        sendPushToUser(
          orderData.ownerId,
          "📅 New Booking",
          `${userName || "A user"} booked ${orderData.slots?.length || 1} slot(s) at ${orderData.turfName} on ${orderData.dateString}.`,
          { screen: "owner-bookings", bookingId }
        );
      }

      return res.json({
        success: true,
      });

    } catch (err) {
  console.error("verifypayment error: - server.js:900", err);

  try {
    if (order_id) {
      const orderRef = db
        .collection("orders")
        .doc(order_id);

      const orderDoc = await orderRef.get();

      if (orderDoc.exists) {
        await orderRef.update({
          orderStatus: "failed",
          paymentStatus: "failed",
          failedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  } catch (e) {
    console.log("Failed order update: - server.js:920", e);
  }

  return res.status(500).json({
    success: false,
    error: err.message || "Verification failed",
  });
}
  }
);

// =======================================================
app.post("/cancel-booking",cancelLimiter, async (req, res) => {
  try {
    const { bookingId, userId, reason } = req.body;
 
    // ── Validation ────────────────────────────────────────────────────────────
    if (!bookingId || !userId) {
      return res.status(400).json({
        success: false,
        error: "bookingId and userId are required",
      });
    }
 
    // ── Fetch booking ─────────────────────────────────────────────────────────
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
 
    if (!bookingDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
      });
    }
 
    const booking = bookingDoc.data();
 
    // ── Ownership check ───────────────────────────────────────────────────────
    // Only the user who made the booking can cancel it
    if (booking.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "You are not authorised to cancel this booking",
      });
    }
 
    // ── Already cancelled check ───────────────────────────────────────────────
    if (booking.status === "cancelled") {
      return res.status(400).json({
        success: false,
        error: "This booking is already cancelled",
      });
    }
 
    // ── Past booking check ────────────────────────────────────────────────────
    const bookingDate = booking.date?.toDate
      ? booking.date.toDate()
      : new Date(booking.dateString);
 
    if (bookingDate < new Date()) {
      return res.status(400).json({
        success: false,
        error: "Cannot cancel a booking that has already passed",
      });
    }
 
    // ── Cancellation window check (2 hours before slot start) ─────────────────
    // Parse the first selected slot to get the start hour
    const slots = booking.selectedSlots || [];
    let slotStartHour = null;
 
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
          slotStartHour = h + min / 60;
        }
      }
    }
 
    // Build the actual slot datetime for the 2-hour window check
    if (slotStartHour !== null) {
      const slotDateTime = new Date(bookingDate);
      slotDateTime.setHours(Math.floor(slotStartHour), Math.round((slotStartHour % 1) * 60), 0, 0);
 
      const hoursUntilSlot = (slotDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
      const CANCEL_WINDOW_HOURS = 2;
 
      if (hoursUntilSlot < CANCEL_WINDOW_HOURS) {
        return res.status(400).json({
          success: false,
          error: `Cancellations are not allowed within ${CANCEL_WINDOW_HOURS} hours of the slot start time`,
          hoursUntilSlot: Math.round(hoursUntilSlot * 10) / 10,
        });
      }
    }
 
    // ── Determine refund amount ────────────────────────────────────────────────
    const paidAmount      = Number(booking.paidAmount      || booking.advanceAmount || 0);
    const totalAmount     = Number(booking.totalAmount     || 0);
    const paymentId       = booking.paymentId || null;
    const wasOnlinePayment = !!paymentId;
 
    // Refund policy:
    // - Full payment → 100% refund
    // - Advance payment → refund the advance amount
    // - No online payment → no refund needed
    const refundAmount = wasOnlinePayment ? paidAmount : 0;
 
    // ── Start batch ───────────────────────────────────────────────────────────
    const batch = db.batch();
 
    // ── Mark booking cancelled ────────────────────────────────────────────────
    batch.update(bookingRef, {
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           "user",
      cancellationReason:    reason || "User requested cancellation",
      refundStatus:          wasOnlinePayment ? "pending" : "not_applicable",
      refundAmount:          refundAmount,
      ownerSettlementStatus: "cancelled",   // owner won't receive settlement for this
    });
 
    await batch.commit();
 
    // ── Delete slot locks for these slots ─────────────────────────────────────
    // This frees the slots so other users can book them immediately
    const lockSnap = await db
      .collection("slotLocks")
      .where("turfId",      "==", booking.turfId)
      .where("dateString",  "==", booking.dateString)
      .get();
 
    const lockDeletePromises = [];
    lockSnap.docs.forEach((lockDoc) => {
      const lockData = lockDoc.data();
      if (slots.includes(lockData.slotTime)) {
        lockDeletePromises.push(lockDoc.ref.delete());
      }
    });
    await Promise.all(lockDeletePromises);
 
    // ── Razorpay refund ───────────────────────────────────────────────────────
    let refundId   = null;
    let refundNote = "no_refund";
 
    if (wasOnlinePayment && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,   // Razorpay needs paise
          notes: {
            bookingId,
            reason: reason || "User cancelled booking",
          },
          speed: "normal",              // "normal" = 5-7 days, "optimum" = instant (higher fee)
        });
 
        refundId   = refund.id;
        refundNote = "refund_initiated";
 
        // Update booking with refund details
        await bookingRef.update({
          refundId,
          refundStatus:    "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
 
        console.log(`Refund initiated: ${refundId} for booking: ${bookingId} - server.js:1094`);
      } catch (refundError) {
        // Refund failed — log it but don't fail the cancellation
        // The booking is still cancelled; refund will need manual processing
        console.error("Razorpay refund error: - server.js:1098", refundError.message);
 
        await bookingRef.update({
          refundStatus:      "failed",
          refundError:       refundError.message,
          refundFailedAt:    admin.firestore.FieldValue.serverTimestamp(),
        });
 
        refundNote = "refund_failed";
      }
    }

    // 🔔 Notify user — booking cancelled
    sendPushToUser(
      userId,
      "❌ Booking Cancelled",
      wasOnlinePayment && refundAmount > 0
        ? `Your booking at ${booking.turfName} was cancelled. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your booking at ${booking.turfName} on ${booking.dateString} has been cancelled.`,
      { screen: "bookings", bookingId }
    );
    // 🔔 Notify owner — their booking was cancelled
    if (booking.ownerId) {
      sendPushToUser(
        booking.ownerId,
        "🔔 Booking Cancelled",
        `${booking.userName || "A user"} cancelled their slot at ${booking.turfName} on ${booking.dateString}.`,
        { screen: "owner-bookings" }
      );
    }
 
    // ── Success response ──────────────────────────────────────────────────────
    return res.json({
      success:       true,
      bookingId,
      refundStatus:  refundNote,
      refundAmount,
      refundId,
      message:
        wasOnlinePayment && refundAmount > 0
          ? `Booking cancelled. ₹${refundAmount} refund has been initiated and will reflect in 5-7 business days.`
          : "Booking cancelled successfully.",
    });
 
  } catch (err) {
    console.error("cancelbooking error: - server.js:1143", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Cancellation failed. Please try again.",
    });
  }
});
 
 
// =======================================================
// 🔍 REFUND STATUS CHECK
// =======================================================
// Optional endpoint — lets the app check if a refund went through
// Call: GET /refund-status/:bookingId
 
app.get("/refund-status/:bookingId",refundStatusLimiter, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { userId }    = req.query;
 
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
 
    // If we have a Razorpay refund ID, fetch live status from Razorpay
    if (booking.refundId) {
      try {
        const refund = await razorpay.payments.fetchRefund(booking.paymentId, booking.refundId);
        return res.json({
          success:      true,
          refundId:     refund.id,
          refundStatus: refund.status,       // "pending" | "processed" | "failed"
          refundAmount: refund.amount / 100, // back to rupees
          processedAt:  refund.created_at,
        });
      } catch (e) {
        // Fall through to Firestore status
      }
    }
 
    return res.json({
      success:      true,
      refundId:     booking.refundId     || null,
      refundStatus: booking.refundStatus || "not_applicable",
      refundAmount: booking.refundAmount || 0,
    });
 
  } catch (err) {
    console.error("refundstatus error: - server.js:1203", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/create-owner",adminActionLimiter, async (req, res) => {
  try {
    const { name, email, phone, password, businessName, location, description } = req.body;
    
    const userRecord = await admin.auth().createUser({ 
      email, 
      password, 
      displayName: name 
    });
    
    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      phone,
      businessName,
      location: location || "",
      description: description || "",   // ← fix: fallback to empty string
      role: "owner",
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post("/create-operator",adminActionLimiter, async (req, res) => {
  try {
    const { name, email, phone, password, ownerId } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    await db.collection("users").doc(userRecord.uid).set({
      name,
      email,
      phone: phone || "",        // ← fallback
      role: "turf-operator",
      ownerId: ownerId || null,
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, uid: userRecord.uid });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.delete("/delete-owner/:uid", adminActionLimiter, async (req, res) => {
  try {
    const { uid } = req.params;
    
    // Delete Firebase Auth account
    await admin.auth().deleteUser(uid);
    
    // Delete Firestore doc
    await db.collection("users").doc(uid).delete();

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});
// =======================================================




// ✅ HEALTH CHECK
// =======================================================
// =======================================================
// 📅 DAY-BEFORE REMINDER — call daily at 9 AM via cron-job.org (free)
// POST /send-reminders  with header  x-cron-secret: <your secret>
// Add to .env:  CRON_SECRET=some_long_random_string
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
    console.error("sendreminders error: - server.js:1315", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// =======================================================
// 📢 ADMIN SEND NOTIFICATION
// =======================================================
app.post("/send-admin-notification", async (req, res) => {
  try {
    const {
      title,
      body,
      userId,
      role,
      image,
      data,
    } = req.body;

    // ===================================================
    // ✅ Send to Single User
    // ===================================================

    if (userId) {
      await sendPushToUser(
        userId,
        title || "Notification",
        body || "",
        data || {}
      );

      return res.json({
        success: true,
        message: "Notification sent to user",
      });
    }

    // ===================================================
    // ✅ Send by Role
    // role = user / owner / turf-operator
    // ===================================================

    let query = db.collection("users");

    if (role) {
      query = query.where("role", "==", role);
    }

    const snap = await query.get();

    let total = 0;

    await Promise.allSettled(
      snap.docs.map(async (doc) => {
        const u = doc.data();

        if (!u.expoPushToken) return;

        await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: u.expoPushToken,
            sound: "default",
            title: title || "Notification",
            body: body || "",
            data: data || {},
            channelId: "bookora-default",
            priority: "high",
          }),
        });

        total++;
      })
    );

    return res.json({
      success: true,
      total,
      message: "Notifications sent",
    });

  } catch (e) {
    console.error("admin notification error: - server.js:1401", e);

    return res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});


app.get("/", (req, res) => {
  res.send(
    "Bookora server running ✅"
  );
});

// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT =
  process.env.PORT || 5000;

  // =======================================================
// ❌ GLOBAL ERROR HANDLER
// =======================================================
app.use((err, req, res, next) => {
  console.error("Global Error: - server.js:1427", err);

  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(
    `Server running on ${PORT} ✅`
  );
});