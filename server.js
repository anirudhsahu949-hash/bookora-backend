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

    // --- Validate input ---
    if (!turfId || !dateString) {
      return res.status(400).json({ error: "turfId and dateString are required" });
    }

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: "slots must be a non-empty array" });
    }

    // --- Fetch turf ---
    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) {
      return res.status(404).json({ error: "Turf not found" });
    }
    const turf = turfDoc.data();

    // --- Fetch special prices for this turf + date ---
    const specialSnap = await db
      .collection("specialPrices")
      .where("turfId", "==", turfId)
      .where("date", "==", dateString)
      .get();

    const specialPrices = specialSnap.docs.map((d) => d.data());

    // --- Check already booked slots ---
    const bookingSnap = await db
      .collection("bookings")
      .where("turfId", "==", turfId)
      .where("dateString", "==", dateString)
      .get();

    const bookedSlots = bookingSnap.docs.map((d) => d.data().slotTime);

    for (const slot of slots) {
      if (bookedSlots.includes(slot)) {
        return res.status(400).json({ error: `Slot already booked: ${slot}` });
      }
    }

    // --- Calculate total price ---
    // slotTime format from frontend: "6:00 AM - 7:00 AM"
    // We parse the start time to decide day vs night price
    let totalAmount = 0;

    for (const slot of slots) {
      const special = specialPrices.find(
        (s) => String(s.slotTime).trim() === String(slot).trim()
      );

      if (special) {
        totalAmount += Number(special.price);
      } else {
        // Parse "6:00 AM" from "6:00 AM - 7:00 AM"
        const startPart = slot.split("-")[0].trim();
        const timeParts = startPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);

        let hour = 0;
        if (timeParts) {
          hour = parseInt(timeParts[1]);
          const meridiem = timeParts[3].toUpperCase();
          if (meridiem === "PM" && hour < 12) hour += 12;
          if (meridiem === "AM" && hour === 12) hour = 0;
        }

        if (hour >= 6 && hour < 18) {
          totalAmount += Number(turf.dayPrice || turf.price || 0);
        } else {
          totalAmount += Number(turf.nightPrice || turf.price || 0);
        }
      }
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ error: "Calculated price is invalid" });
    }

    // --- Advance amount ---
    const advanceAmount =
      Number(turf.bookingPrice) > 0
        ? Number(turf.bookingPrice)
        : totalAmount;

    // --- Create Razorpay order ---
    const order = await razorpay.orders.create({
      amount: advanceAmount * 100, // in paise
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    });

    // --- Save pending order ---
    await db.collection("orders").doc(order.id).set({
      turfId,
      slots,
      dateString,               // string — for slot conflict checks
      userId: userId || null,   // ✅ stored so verify-payment can use it
      totalAmount,
      advanceAmount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.KEY_ID,
    });

  } catch (err) {
    console.error("createorder error: - server.js:157", err.message);
    return res.status(500).json({ error: err.message || "Order creation failed" });
  }
});


// =======================================================
// ✅ 2. VERIFY PAYMENT
// =======================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    // --- Verify Razorpay signature ---
    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    // --- Fetch order ---
    const orderRef = db.collection("orders").doc(order_id);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const orderData = orderDoc.data();

    // --- Idempotency: already paid ---
    if (orderData.status === "paid") {
      return res.json({ success: true });
    }

    // --- Re-check slots to prevent race condition ---
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
          error: `Slot just got booked by someone else: ${slot}`,
        });
      }
    }

    // --- Verify payment from Razorpay ---
    const payment = await razorpay.payments.fetch(payment_id);

    if (payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured" });
    }

    if (payment.amount !== orderData.advanceAmount * 100) {
      return res.status(400).json({ success: false, error: "Payment amount mismatch" });
    }

    // --- Fetch turf for ownerId + turfName ---
    const turfDoc = await db.collection("turfs").doc(orderData.turfId).get();
    if (!turfDoc.exists) {
      return res.status(404).json({ success: false, error: "Turf not found" });
    }

    const turfData = turfDoc.data();
    const turfName  = turfData.name    || "";
    const ownerId   = turfData.ownerId || null;

    // --- Fetch user for userName, phone, email ---
    let userName  = "";
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
        // Non-critical — booking still proceeds
        console.warn("User fetch failed (noncritical): - server.js:254", e.message);
      }
    }

    // --- Build real Firestore Timestamp from dateString ---
    // dateString example: "Mon Apr 28 2026"
    // Stored as Timestamp so owner screens can:
    //   - sort history newest-first
    //   - filter today / upcoming correctly
    //   - display formatted dates properly
    const parsedDate  = new Date(orderData.dateString);
    const bookingDate = admin.firestore.Timestamp.fromDate(
      isNaN(parsedDate.getTime()) ? new Date() : parsedDate
    );

    // --- Determine payment status ---
    const paymentStatus =
      orderData.advanceAmount >= orderData.totalAmount ? "full" : "partial";

    // --- Atomic batch: one booking doc per slot + mark order paid ---
    const batch = db.batch();

    orderData.slots.forEach((slot) => {
      const bookingRef = db.collection("bookings").doc();

      batch.set(bookingRef, {
        // ── IDs ──────────────────────────────────────────────────────────
        turfId:   orderData.turfId,
        userId:   orderData.userId || null,
        ownerId:  ownerId,            // ✅ owner queries: where("ownerId","==",uid)

        // ── Display names (denormalized) ─────────────────────────────────
        turfName:   turfName,         // ✅ shown in owner booking cards
        userName:   userName,         // ✅ shown in owner booking cards
        userPhone:  userPhone,        // ✅ owner contact info
        userEmail:  userEmail,        // ✅ owner contact info

        // ── Date ─────────────────────────────────────────────────────────
        date:       bookingDate,      // ✅ Firestore Timestamp — for sorting & filtering
        dateString: orderData.dateString, // ✅ plain string — for slot conflict checks only

        // ── Slot ─────────────────────────────────────────────────────────
        slotTime: slot,               // e.g. "6:00 AM - 7:00 AM"

        // ── Payment ──────────────────────────────────────────────────────
        paymentId:       payment_id,
        totalAmount:     orderData.totalAmount,    // ✅ full price
        advanceAmount:   orderData.advanceAmount,  // ✅ paid online
        remainingAmount: orderData.totalAmount - orderData.advanceAmount, // ✅ collect at turf

        // ── Status ───────────────────────────────────────────────────────
        status:        "confirmed",   // confirmed → completed / cancelled by owner
        paymentStatus: paymentStatus, // "partial" or "full"

        // ── Metadata ─────────────────────────────────────────────────────
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    batch.update(orderRef, {
      status:    "paid",
      paymentId: payment_id,
      paidAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.json({ success: true });

  } catch (err) {
    console.error("verifypayment error: - server.js:324", err.message);
    return res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});


// =======================================================
// ✅ 3. HOSTED PAYMENT PAGE
// =======================================================
app.get("/pay", (req, res) => {
  const { order_id } = req.query;

  if (!order_id) {
    return res.status(400).send("Invalid order");
  }

  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Bookora Payment</title>
        <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: #f5f7fa;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            font-family: sans-serif;
          }
          .loader { text-align: center; color: #6b7280; }
          .loader p { margin-top: 16px; font-size: 16px; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="loader">
          <div style="font-size:52px;">⏳</div>
          <p>Opening payment...</p>
        </div>

        <script>
          var options = {
            key: "${process.env.KEY_ID}",
            order_id: "${order_id}",
            name: "Bookora",
            description: "Turf Booking",
            method: {
      upi: true,
      card: true,
       netbanking: true,
       wallet: true,
    },
            theme: { color: "#111111" },
            
            console.log("VERIFY BODY: - server.js:380", req.body);

            handler: function (response) {
              fetch("https://bookora-backend-95u4.onrender.com//verify-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  order_id:   response.razorpay_order_id,
                  payment_id: response.razorpay_payment_id,
                  signature:  response.razorpay_signature,
                }),
              })
              .then((res) => res.json())
              .then((data) => {
                window.location.href = data.success ? "/success" : "/failed";
              })
              .catch(() => {
                window.location.href = "/failed";
              });
            },

            modal: {
              ondismiss: function () {
                // User closed Razorpay modal without paying
                window.location.href = "/failed";
              },
            },
          };

          var rzp = new Razorpay(options);
          rzp.open();
        </script>
      </body>
    </html>
  `);
});


// =======================================================
// ✅ 4. SUCCESS PAGE
// =======================================================
app.get("/success", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Payment Successful</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: #f5f7fa;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            padding: 20px;
          }
          .card {
            background: #fff;
            border-radius: 24px;
            padding: 40px 28px;
            text-align: center;
            max-width: 360px;
            width: 100%;
            border: 1px solid #e5e7eb;
          }
          .icon { font-size: 64px; }
          h2 { margin-top: 20px; font-size: 22px; font-weight: 800; color: #111; }
          p  { margin-top: 10px; color: #6b7280; font-size: 15px; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h2>Booking Confirmed!</h2>
          <p>Your payment was successful and your slot is booked. You can close this and return to the app.</p>
        </div>
      </body>
    </html>
  `);
});


// =======================================================
// ✅ 5. FAILED PAGE
// =======================================================
app.get("/failed", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>Payment Failed</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: #f5f7fa;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            padding: 20px;
          }
          .card {
            background: #fff;
            border-radius: 24px;
            padding: 40px 28px;
            text-align: center;
            max-width: 360px;
            width: 100%;
            border: 1px solid #e5e7eb;
          }
          .icon { font-size: 64px; }
          h2 { margin-top: 20px; font-size: 22px; font-weight: 800; color: #111; }
          p  { margin-top: 10px; color: #6b7280; font-size: 15px; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">❌</div>
          <h2>Payment Failed</h2>
          <p>Something went wrong or payment was cancelled. Please go back to the app and try again.</p>
        </div>
      </body>
    </html>
  `);
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
  console.log(`Server running on port ${PORT} - server.js:523`);
});