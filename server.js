const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

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

  console.log("Firebase connected ✅ - server.js:32");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:34", e);
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
// ✅ CREATE ORDER
// =======================================================
app.post("/create-order", async (req, res) => {
  try {
    const { turfId, slots, dateString, userId } = req.body;

    if (!turfId || !dateString) {
      return res.status(400).json({
        error: "turfId and dateString required",
      });
    }

    if (!Array.isArray(slots) || slots.length === 0) {
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

    const specialPrices = specialSnap.docs.map((d) =>
      d.data()
    );

    // ===================================================
    // ✅ Already Booked
    // ===================================================
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", turfId)
      .where("dateString", "==", dateString)
      .get();

   const bookedSlots = bookingSnap.docs
  .map((d) => d.data())
  .filter(
    (b) => b.status !== "cancelled"
  )
  .map((b) => b.slotTime);

    for (const slot of slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({
          error: `Slot already booked: ${slot}`,
        });
      }
    }

    // ===================================================
    // ✅ Calculate Amount
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
        const startPart = slot.split("-")[0].trim();

        const timeParts = startPart.match(
          /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
        );

        let hour = 0;

        if (timeParts) {
          hour = parseInt(timeParts[1]);

          const meridiem =
            timeParts[3].toUpperCase();

          if (meridiem === "PM" && hour < 12) {
            hour += 12;
          }

          if (meridiem === "AM" && hour === 12) {
            hour = 0;
          }
        }

        if (hour >= 6 && hour < 18) {
          totalAmount += Number(
            turf.dayPrice || turf.price || 0
          );
        } else {
          totalAmount += Number(
            turf.nightPrice || turf.price || 0
          );
        }
      }
    }

    if (totalAmount <= 0) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    // ===================================================
    // ✅ Advance Amount
    // ===================================================
    const advanceAmount =
      Number(turf.bookingPrice) > 0
        ? Number(turf.bookingPrice)
        : totalAmount;

    // ===================================================
    // ✅ Create Razorpay Order
    // ===================================================
    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // ===================================================
    // ✅ Save Order
    // ===================================================
   await db.collection("orders").doc(order.id).set({
  turfId,

  turfName: turf.name || "",

  turfLocation: turf.location || "",

  image:
    Array.isArray(turf.images) &&
    turf.images.length > 0
      ? turf.images[0]
      : turf.image || "",

  ownerId: turf.ownerId || null,

  ownerName: turf.ownerName || "",

  mapLink: turf.mapLink || "",

  userId: userId || null,

  slots,

  dateString,

  totalAmount,

  advanceAmount,

  remainingAmount:
    totalAmount - advanceAmount,

  orderId: order.id,

  orderStatus: "created",

  paymentStatus: "pending",

  createdAt:
    admin.firestore.FieldValue.serverTimestamp(),
});

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.KEY_ID,
    });
  } catch (err) {
    console.error("createorder error: - server.js:256", err);

    return res.status(500).json({
      error: err.message,
    });
  }
});

// =======================================================
// ✅ VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature } =
      req.body;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    // ===================================================
    // ✅ Verify Signature
    // ===================================================
    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    // ===================================================
    // ✅ Fetch Order
    // ===================================================
    const orderRef = db
      .collection("orders")
      .doc(order_id);

    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    const orderData = orderDoc.data();

    // ===================================================
    // ✅ Already Paid
    // ===================================================
    if (orderData.orderStatus === "paid") {
      return res.json({
        success: true,
      });
    }

    // ===================================================
    // ✅ Verify Payment
    // ===================================================
    const payment =
      await razorpay.payments.fetch(payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        error: "Payment not captured",
      });
    }

    // ===================================================
    // ✅ Fetch Turf
    // ===================================================
    const turfDoc = await db
      .collection("turfs")
      .doc(orderData.turfId)
      .get();

    if (!turfDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Turf not found",
      });
    }

    const turfData = turfDoc.data();

    const turfName = turfData.name || "";
    const ownerId = turfData.ownerId || null;

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
        const u = userDoc.data();

        userName = u.name || "";
        userPhone = u.phone || "";
        userEmail = u.email || "";
      }
    }

    // ===================================================
    // ✅ Date
    // ===================================================
    const parsedDate = new Date(
      orderData.dateString
    );

    const bookingDate =
      admin.firestore.Timestamp.fromDate(
        isNaN(parsedDate.getTime())
          ? new Date()
          : parsedDate
      );

    // ===================================================
    // ✅ Payment Status
    // ===================================================
    const paymentStatus =
      orderData.advanceAmount >=
      orderData.totalAmount
        ? "full"
        : "partial";

        
        const existingBookingSnap = await db
  .collection("bookings")
  .where("turfId", "==", orderData.turfId)
  .where("dateString", "==", orderData.dateString)
  .get();

const existingSlots = existingBookingSnap.docs
  .map((d) => d.data())
  .filter(
    (b) => b.status !== "cancelled"
  )
  .map((b) => b.slotTime);

for (const slot of orderData.slots) {
  if (existingSlots.includes(slot)) {
    return res.status(400).json({
      success: false,
      error:
        "Slot already booked during payment",
    });
  }
}

    // ===================================================
    // ✅ Batch
    // ===================================================
    const batch = db.batch();

    for (const slot of orderData.slots) {
      const bookingId =
        `${orderData.turfId}_${orderData.dateString}_${slot}`;

      const bookingRef = db
        .collection("bookings")
        .doc(bookingId);

        

   batch.create(bookingRef, {
  turfId: orderData.turfId,

  turfName: orderData.turfName,

  turfLocation: orderData.turfLocation,

  image: orderData.image,

  ownerId: orderData.ownerId,

  ownerName: orderData.ownerName,

  mapLink: orderData.mapLink,

  userId: orderData.userId || null,

  userName: userName,

  userPhone: userPhone,

  userEmail: userEmail,

  date: bookingDate,

  dateString: orderData.dateString,

  slotTime: slot,

  selectedSlots: orderData.slots,

  paymentId: payment_id,

  orderId: order_id,

  totalAmount: orderData.totalAmount,

  advanceAmount:
    orderData.advanceAmount,

  remainingAmount:
    orderData.remainingAmount,

  status: "confirmed",

  paymentStatus: paymentStatus,

  refundStatus: "not_applicable",

  refundAmount: 0,

  cancelledAt: null,

  cancelledBy: null,

  cancellationReason: null,

  cancellationTimeLeft: null,

  createdAt:
    admin.firestore.FieldValue.serverTimestamp(),
});
    }

    // ===================================================
    // ✅ Update Order
    // ===================================================
    batch.update(orderRef, {
      orderStatus: "paid",
      paymentId: payment_id,

      paidAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // ===================================================
    // ✅ Remove Slot Locks
    // ===================================================
    const lockSnap = await db
      .collection("slotLocks")
      .where("turfId", "==", orderData.turfId)
      .where("dateString", "==", orderData.dateString)
      .get();

    const deletePromises = [];

    lockSnap.docs.forEach((docSnap) => {
      const data = docSnap.data();

      if (orderData.slots.includes(data.slotTime)) {
        deletePromises.push(docSnap.ref.delete());
      }
    });

    await Promise.all(deletePromises);

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error("verifypayment error: - server.js:540", err);

    if (order_id) {
  await db
    .collection("orders")
    .doc(order_id)
    .update({
      orderStatus: "failed",
      failedAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });
}

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// =======================================================
// ✅ HEALTH CHECK
// =======================================================
app.get("/", (req, res) => {
  res.send("Bookora server running ✅");
});

// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT} ✅ - server.js:573`);
});