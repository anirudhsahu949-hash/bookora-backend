

const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

// 🔥 Firebase Admin Init (ONLY ONCE)
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

const app = express();
app.use(express.json());  
app.use(cors()); // allow all for now

// 🔐 Razorpay
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

// ✅ Health Check
app.get("/success", async (req, res) => {
  const { payment_id, order_id, signature } = req.query;

  // Call your verify-payment logic here OR redirect to frontend
  res.send("Payment successful 🎉 You can close this page.");
});


// =======================================================
// ✅ 1. CREATE ORDER (SECURE)
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

    // 🔥 Fetch turf
    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) {
      return res.status(404).json({ error: "Turf not found" });
    }

    const turf = turfDoc.data();

    // 🔥 Fetch special prices
    const specialSnap = await db
      .collection("specialPrices")
      .where("turfId", "==", turfId)
      .where("date", "==", dateString)
      .get();

    const specialPrices = specialSnap.docs.map((d) => d.data());

    // 🔥 Check booked slots
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

    // 💰 Calculate TOTAL price
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

    // ✅ ADVANCE PAYMENT LOGIC (FIXED)
    const advanceAmount =
      Number(turf.bookingPrice) > 0
        ? Number(turf.bookingPrice)
        : total;

    // 🔥 Create Razorpay Order
    const order = await razorpay.orders.create({
      amount: advanceAmount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // 🔥 Save order
    await db.collection("orders").doc(order.id).set({
      turfId,
      slots,
      dateString,
      totalAmount: total,
      advanceAmount: advanceAmount,
      status: "pending",
      createdAt: new Date(),
    });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});


// =======================================================
// ✅ 2. VERIFY PAYMENT (SECURE)
// =======================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false });
    }

    // 🔐 Verify signature
    const expected = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (expected !== signature) {
      return res.status(400).json({ success: false });
    }

    // 🔥 Fetch order
    const orderRef = db.collection("orders").doc(order_id);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false });
    }

    const orderData = orderDoc.data();

    // ✅ Validate slots
    if (!Array.isArray(orderData.slots) || orderData.slots.length === 0) {
      return res.status(400).json({ success: false });
    }

    // ❌ Prevent duplicate booking
    if (orderData.status === "paid") {
      return res.json({ success: true });
    }

    // 🔥 Re-check slot availability (VERY IMPORTANT)
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

    // 🔥 Verify payment with Razorpay
    const payment = await razorpay.payments.fetch(payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({ success: false });
    }

    if (payment.amount !== orderData.advanceAmount * 100) {
      return res.status(400).json({ success: false });
    }

    // 🔥 Create bookings (atomic)
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

app.get("/pay/:orderId", async (req, res) => {
  const { orderId } = req.params;

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    return res.send("Invalid order");
  }

  const orderData = orderDoc.data();

  res.send(`
    <html>
      <head>
        <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
      </head>
      <body>
        <script>
          var options = {
            key: "${process.env.KEY_ID}",
            amount: "${orderData.advanceAmount * 100}",
            currency: "INR",
            name: "Bookora",
            order_id: "${orderId}",
            handler: function (response) {

              fetch("/verify-payment", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  order_id: response.razorpay_order_id,
                  payment_id: response.razorpay_payment_id,
                  signature: response.razorpay_signature
                })
              })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  document.body.innerHTML = "<h2>✅ Payment Successful 🎉</h2>
                  <p>You can now go back to the app.</p>";
                } else {
                  document.body.innerHTML = "<h2>❌ Payment Verification Failed</h2>";
                }
              });

            },
            theme: { color: "#111111" }
          };

          var rzp = new Razorpay(options);
          rzp.open();
        </script>
      </body>
    </html>
  `);
});



// =======================================================
// 🚀 START SERVER
// =======================================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port - server.js:311" + PORT);
});