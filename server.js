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
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(
        /\\n/g,
        "\n"
      ),
    }),
  });

  console.log(
    "Firebase connected ✅"
  );
} catch (e) {
  console.error(
    "Firebase init error ❌",
    e
  );
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
app.post(
  "/create-order",
  async (req, res) => {
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
 {
        return res.status(400).json({
          error: "Invalid amount",
        });
      }

      // ===================================================
      // ✅ Booking Type
      // ===================================================

      const finalBookingType =
        bookingType === "full"
          ? "full"
          : "advance";

      // ===================================================
      // ✅ Advance Amount
      // ===================================================

      let advanceAmount = 0;

      if (
        finalBookingType === "full"
      ) {
        advanceAmount =
          totalAmount;
      } else {
        advanceAmount = Math.min(
          Number(
            turf.bookingPrice || 0
          ) * slots.length,
          totalAmount
        );
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
app.post(
  "/verify-payment",
  async (req, res) => {
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

      return res.json({
        success: true,
      });

    } catch (err) {
      console.error("verifypayment error: - server.js:816", err);

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
        console.log("Failed order update: - server.js:836", e);
      }

      
    }
  }
);

// =======================================================
// ✅ HEALTH CHECK
// =======================================================
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

app.listen(PORT, () => {
  console.log(
    `Server running on ${PORT} ✅`
  );
});