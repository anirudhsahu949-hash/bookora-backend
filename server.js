const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// =======================================================
// 🔥 Firebase Admin Init
// =======================================================
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  console.log("Firebase connected ✅ - server.js:20");
} catch (e) {
  console.error("Firebase init error ❌ - server.js:22", e);
}

const db = admin.firestore();

const app = express();

app.use(express.json());
app.use(cors());

// =======================================================
// 🔐 Razorpay Instance
// =======================================================
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

// =======================================================
// ✅ 1. CREATE ORDER
// =======================================================
app.post("/create-order", async (req, res) => {
  try {
    const { turfId, slots, dateString, userId } = req.body;

    // =======================================================
    // ✅ Validate Input
    // =======================================================
    if (!turfId || !dateString) {
      return res.status(400).json({
        error: "turfId and dateString are required",
      });
    }

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({
        error: "slots must be a non-empty array",
      });
    }

    // =======================================================
    // ✅ Fetch Turf
    // =======================================================
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

    // =======================================================
    // ✅ Fetch Special Prices
    // =======================================================
    const specialSnap = await db
      .collection("specialPrices")
      .where("turfId", "==", turfId)
      .where("date", "==", dateString)
      .get();

    const specialPrices = specialSnap.docs.map((d) =>
      d.data()
    );

    // =======================================================
    // ✅ Check Already Booked Slots
    // =======================================================
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", turfId)
      .where("dateString", "==", dateString)
      .get();

    const bookedSlots = bookingSnap.docs.map(
      (d) => d.data().slotTime
    );

    for (const slot of slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({
          error: `Slot already booked: ${slot}`,
        });
      }
    }

    // =======================================================
    // ✅ Calculate Total Amount
    // =======================================================
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
        const startPart = slot
          .split("-")[0]
          .trim();

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
        error: "Calculated price is invalid",
      });
    }

    // =======================================================
    // ✅ Advance Amount
    // =======================================================
    const advanceAmount =
      Number(turf.bookingPrice) > 0
        ? Number(turf.bookingPrice)
        : totalAmount;

    // =======================================================
    // ✅ Create Razorpay Order
    // =======================================================
    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // =======================================================
    // ✅ Save Pending Order
    // =======================================================
    await db.collection("orders").doc(order.id).set({
      turfId,
      slots,
      dateString,
      userId: userId || null,

      totalAmount,
      advanceAmount,

      status: "pending",

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
    console.error(
      "create-order error:",
      err.message
    );

    return res.status(500).json({
      error:
        err.message || "Order creation failed",
    });
  }
});

// =======================================================
// ✅ 2. VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", async (req, res) => {
  try {
    // ✅ Receive payment data from frontend
    const { order_id, payment_id, signature } =
      req.body;

    // ✅ Validate fields
    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    // =======================================================
    // ✅ Verify Razorpay Signature
    // =======================================================
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

    // =======================================================
    // ✅ Fetch Order
    // =======================================================
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

    // =======================================================
    // ✅ Prevent Duplicate Booking
    // =======================================================
    if (orderData.status === "paid") {
      return res.json({
        success: true,
      });
    }

    // =======================================================
    // ✅ Re-check Slots
    // =======================================================
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", orderData.turfId)
      .where(
        "dateString",
        "==",
        orderData.dateString
      )
      .get();

    const bookedSlots = bookingSnap.docs.map(
      (d) => d.data().slotTime
    );

    for (const slot of orderData.slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({
          success: false,
          error: `Slot already booked: ${slot}`,
        });
      }
    }

    // =======================================================
    // ✅ Verify Payment From Razorpay
    // =======================================================
    const payment =
      await razorpay.payments.fetch(payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        error: "Payment not captured",
      });
    }

    // =======================================================
    // ✅ Verify Payment Amount
    // =======================================================
    if (
      payment.amount !==
      orderData.advanceAmount * 100
    ) {
      return res.status(400).json({
        success: false,
        error: "Payment amount mismatch",
      });
    }

    // =======================================================
    // ✅ Fetch Turf
    // =======================================================
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

    // =======================================================
    // ✅ Fetch User
    // =======================================================
    let userName = "";
    let userPhone = "";
    let userEmail = "";

    if (orderData.userId) {
      try {
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
      } catch (e) {
        console.log(
          "User fetch failed:",
          e.message
        );
      }
    }

    // =======================================================
    // ✅ Create Timestamp
    // =======================================================
    const parsedDate = new Date(
      orderData.dateString
    );

    const bookingDate =
      admin.firestore.Timestamp.fromDate(
        isNaN(parsedDate.getTime())
          ? new Date()
          : parsedDate
      );

    // =======================================================
    // ✅ Payment Status
    // =======================================================
    const paymentStatus =
      orderData.advanceAmount >=
      orderData.totalAmount
        ? "full"
        : "partial";

    // =======================================================
    // ✅ Atomic Batch
    // =======================================================
    const batch = db.batch();

    orderData.slots.forEach((slot) => {
      const bookingRef = db
        .collection("bookings")
        .doc();

      batch.set(bookingRef, {
        turfId: orderData.turfId,
        userId: orderData.userId || null,
        ownerId: ownerId,

        turfName: turfName,
        userName: userName,
        userPhone: userPhone,
        userEmail: userEmail,

        date: bookingDate,
        dateString: orderData.dateString,

        slotTime: slot,

        paymentId: payment_id,

        totalAmount: orderData.totalAmount,
        advanceAmount:
          orderData.advanceAmount,

        remainingAmount:
          orderData.totalAmount -
          orderData.advanceAmount,

        status: "confirmed",
        paymentStatus: paymentStatus,

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // =======================================================
    // ✅ Update Order
    // =======================================================
    batch.update(orderRef, {
      status: "paid",
      paymentId: payment_id,

      paidAt:
        admin.firestore.FieldValue.serverTimestamp(),
    });

    // =======================================================
    // ✅ Commit Batch
    // =======================================================
    await batch.commit();

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error(
      "verify-payment error:",
      err.message
    );

    return res.status(500).json({
      success: false,
      error:
        err.message || "Verification failed",
    });
  }
});

// =======================================================
// ✅ Health Check
// =======================================================
app.get("/", (req, res) => {
  res.send("Bookora server running ✅");
});

// =======================================================
// 🚀 Start Server
// =======================================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} ✅`
  );
});