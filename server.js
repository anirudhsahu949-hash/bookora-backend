const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

// 🔥 Firebase Admin Init
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  console.log("Firebase connected ✅ - server.js:17");
} catch (e) {
  console.error("Firebase error ❌ - server.js:19", e);
}

const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

// 🔐 Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});


// =======================================================
// ✅ 1. CREATE ORDER
// =======================================================
app.post("/create-order", async (req, res) => {
  try {
    const { turfId, slots, dateString } = req.body;

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: "Invalid slots" });
    }

    if (!turfId || !dateString) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) {
      return res.status(404).json({ error: "Turf not found" });
    }

    const turf = turfDoc.data();

    // 🔥 Special prices
    const specialSnap = await db
      .collection("specialPrices")
      .where("turfId", "==", turfId)
      .where("date", "==", dateString)
      .get();

    const specialPrices = specialSnap.docs.map((d) => d.data());

    // 🔥 Already booked slots
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", turfId)
      .where("dateString", "==", dateString)
      .get();

    const bookedSlots = bookingSnap.docs.map((d) => d.data().slotTime);

    for (const slot of slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({
          error: `Slot already booked: ${slot}`,
        });
      }
    }

    // 💰 Calculate price
    let total = 0;

    for (const slot of slots) {
      const special = specialPrices.find(
        (s) => String(s.slotTime).trim() === String(slot).trim()
      );

      if (special) {
        total += Number(special.price);
      } else {
        const hour = parseInt(slot.split(":")[0]);

        if (hour >= 6 && hour < 18) {
          total += Number(turf.dayPrice || turf.price || 0);
        } else {
          total += Number(turf.nightPrice || turf.price || 0);
        }
      }
    }

    if (total <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const advanceAmount =
      Number(turf.bookingPrice) > 0
        ? Number(turf.bookingPrice)
        : total;

    // 🔥 Create Razorpay order
    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // 🔥 Save order in DB
    await db.collection("orders").doc(order.id).set({
      turfId,
      slots,
      dateString,
      totalAmount: total,
      advanceAmount,
      status: "pending",
      createdAt: new Date(),
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.KEY_ID, // send key to frontend
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});


// =======================================================
// ✅ 2. VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false });
    }

    // 🔐 Signature verification
    const expected = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (expected !== signature) {
      return res.status(400).json({ success: false });
    }

    const orderRef = db.collection("orders").doc(order_id);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false });
    }

    const orderData = orderDoc.data();

    if (orderData.status === "paid") {
      return res.json({ success: true });
    }

    // 🔥 Re-check slots
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", orderData.turfId)
      .where("dateString", "==", orderData.dateString)
      .get();

    const bookedSlots = bookingSnap.docs.map((d) => d.data().slotTime);

    for (const slot of orderData.slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({
          success: false,
          error: "Slot already booked",
        });
      }
    }

    // 🔥 Fetch payment from Razorpay
    const payment = await razorpay.payments.fetch(payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({ success: false });
    }

    if (payment.amount !== orderData.advanceAmount * 100) {
      return res.status(400).json({ success: false });
    }

    // 🔥 Atomic booking
    const batch = db.batch();

    orderData.slots.forEach((slot) => {
      const ref = db.collection("bookings").doc();

      batch.set(ref, {
        turfId: orderData.turfId,
        slotTime: slot,
        dateString: orderData.dateString,
        paymentId: payment_id,
        status: "confirmed",
        createdAt: new Date(),
      });
    });

    batch.update(orderRef, {
      status: "paid",
      paymentId: payment_id,
    });

    await batch.commit();

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running ✅");
});


// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port - server.js:250" + PORT);
});