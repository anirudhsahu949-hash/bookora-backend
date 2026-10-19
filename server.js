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

  const coachLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});

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

   const leagueHostLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 60,
    standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
  });
 
const offerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
  
  // Live scoring — frequent by nature (ball-by-ball updates)
  const scoringLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 300,
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
      console.log(`Push sent to ${userId}: - server.js:98`, result);
    } catch (e) {
      console.error("sendPushToUser failed: - server.js:100", e.message);
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
    console.log("Firebase connected ✅ - server.js:124");
  } catch (e) {
    console.error("Firebase init error ❌ - server.js:126", e);
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

  // ── Advance Pricing: weekday/weekend detection + rate lookup ─────────────
  // Falls back to legacy dayPrice/nightPrice whenever advancePricingEnabled
  // is false, or when no time slot in priceSlabs covers the given hour.
  function getDayType(dateString) {
    try {
      const d = new Date(dateString);
      if (isNaN(d.getTime())) return "weekday";
      const day = d.getDay(); // 0 = Sun, 6 = Sat
      return (day === 0 || day === 6) ? "weekend" : "weekday";
    } catch {
      return "weekday";
    }
  }

  function getHourlyRate(turf, hour, dayType) {
    const advancePricingOn = turf?.advancePricingEnabled === true;
    const slabs = advancePricingOn ? turf?.priceSlabs?.[dayType] : null;
    if (Array.isArray(slabs) && slabs.length > 0) {
      const match = slabs.find((s) => hour >= Number(s.start) && hour < Number(s.end));
      if (match) {
        const rate = Number(match.rate);
        if (!isNaN(rate) && rate >= 0) return rate;
      }
    }
    const fallback = hour >= 6 && hour < 18
      ? parseFloat(turf?.dayPrice || turf?.price || 0)
      : parseFloat(turf?.nightPrice || turf?.price || 0);
    return isNaN(fallback) ? 0 : fallback;
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
      console.warn("getCancellationWindowHours fallback to 2: - server.js:243", e.message);
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
      console.error("validatepromo error: - server.js:424", err);
      return res.status(500).json({ success: false, error: err.message || "Validation failed" });
    }
  });


  
   const SELF_SERVE_MAX_PERCENT = 25;
  const SELF_SERVE_MAX_RUPEES  = 300;
 
  function isWithinSelfServe(type, value, maxDiscount) {
    if (type === "flat") return value <= SELF_SERVE_MAX_RUPEES;
    // A % offer needs a cap too, or 20% off a ₹4000 booking is ₹800.
    return value <= SELF_SERVE_MAX_PERCENT
        && maxDiscount > 0
        && maxDiscount <= SELF_SERVE_MAX_RUPEES;
  }
 
  // Validates and normalises an offer payload. Returns { error } or { data }.
  function buildOfferData(body, { partial = false } = {}) {
    const out = {};
 
    // ── title ──
    if (body.title !== undefined || !partial) {
      const title = String(body.title || "").trim();
      if (!title) return { error: "Offer name is required." };
      if (title.length > 60) return { error: "Offer name must be 60 characters or less." };
      out.title = title;
    }
 
    // ── type + value + cap (these three move together) ──
    const touchesDiscount =
      body.type !== undefined || body.value !== undefined || body.maxDiscount !== undefined;
 
    if (touchesDiscount || !partial) {
      const type = String(body.type || "").trim();
      if (type !== "flat" && type !== "percent") {
        return { error: "Discount type must be 'flat' or 'percent'." };
      }
 
      const value = Number(body.value);
      if (!Number.isFinite(value) || value <= 0) {
        return { error: "Discount must be a number greater than 0." };
      }
      if (type === "percent" && value > 100) {
        return { error: "Percentage cannot be more than 100." };
      }
      if (type === "flat" && value > 100000) {
        return { error: "That discount amount looks wrong." };
      }
 
      // Blank cap on a % offer defaults to the self-serve ceiling.
      const maxDiscount =
        type === "percent"
          ? (Number(body.maxDiscount) > 0 ? Number(body.maxDiscount) : SELF_SERVE_MAX_RUPEES)
          : 0;
      if (!Number.isFinite(maxDiscount) || maxDiscount < 0) {
        return { error: "Maximum discount cap is not a valid number." };
      }
 
      out.type = type;
      out.value = Math.round(value);
      out.maxDiscount = Math.round(maxDiscount);
    }
 
    // ── minimum booking amount ──
    if (body.minBookingAmount !== undefined || !partial) {
      const min = Number(body.minBookingAmount) || 0;
      if (min < 0) return { error: "Minimum booking amount cannot be negative." };
      out.minBookingAmount = Math.round(min);
    }
 
    // ── days of week ──
    if (body.allowedDays !== undefined || !partial) {
      const days = Array.isArray(body.allowedDays) ? body.allowedDays : [];
      const clean = [...new Set(days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      if (clean.length !== days.length) {
        return { error: "Days of the week are not valid." };
      }
      out.allowedDays = clean.sort((a, b) => a - b);   // [] = every day
    }
 
    // ── time windows ──
    if (body.targetSlots !== undefined || !partial) {
      const slots = Array.isArray(body.targetSlots) ? body.targetSlots : [];
      if (slots.length > 12) return { error: "That's too many time windows (max 12)." };
      const clean = slots.map((sv) => String(sv).trim()).filter(Boolean);
      // Must look like "6:00 AM - 10:00 AM" — same shape promoCodes.targetSlots uses.
      const shape = /^\d{1,2}:\d{2}\s*(AM|PM)\s*-\s*\d{1,2}:\d{2}\s*(AM|PM)$/i;
      for (const sv of clean) {
        if (!shape.test(sv)) return { error: `Time window "${sv}" is not in a format we understand.` };
      }
      out.targetSlots = clean;                          // [] = all slots
    }
 
    // ── dates — client sends "YYYY-MM-DD", server owns the conversion ──
    if (body.validFrom !== undefined || body.validTo !== undefined || !partial) {
      const vf = new Date(String(body.validFrom) + "T00:00:00");
      const vt = new Date(String(body.validTo) + "T23:59:59");
      if (isNaN(vf.getTime())) return { error: "Start date is not valid." };
      if (isNaN(vt.getTime())) return { error: "End date is not valid." };
      if (vt <= vf) return { error: "End date must be after the start date." };
 
      const TWO_YEARS = 1000 * 60 * 60 * 24 * 730;
      if (vt.getTime() - vf.getTime() > TWO_YEARS) {
        return { error: "An offer can run for two years at most." };
      }
      out.validFrom = admin.firestore.Timestamp.fromDate(vf);
      out.validTo   = admin.firestore.Timestamp.fromDate(vt);
    }
 
    // ── total redemptions ──
    if (body.totalUses !== undefined || !partial) {
      const total = Number(body.totalUses) || 0;      // 0 = unlimited
      if (total < 0) return { error: "Redemption limit cannot be negative." };
      out.totalUses = Math.round(total);
    }
 
    // ── on/off ──
    if (body.active !== undefined) {
      out.active = !!body.active;
    }
 
    return { data: out };
  }
 
  // Confirms the caller is allowed to touch this turf's offers.
  // Admins can touch any; an owner only their own.
  async function assertTurfAccess(turfId, callerUid, callerRole) {
    if (!turfId) return { error: "turfId is required." };
    const turfDoc = await db.collection("turfs").doc(String(turfId)).get();
    if (!turfDoc.exists) return { error: "That turf does not exist." };
    const turf = turfDoc.data();
    if (callerRole !== "admin" && turf.ownerId !== callerUid) {
      return { error: "You don't manage this turf." };
    }
    return { turf, ownerId: turf.ownerId || callerUid };
  }
 
  // ===========================================================================
  // ➕ CREATE OFFER
  // ===========================================================================
  app.post("/create-offer", offerLimiter, requireAdminOrOwner, async (req, res) => {
    try {
      const { turfId } = req.body;
 
      const access = await assertTurfAccess(turfId, req.callerUid, req.callerRole);
      if (access.error) return res.status(403).json({ success: false, error: access.error });
 
      const built = buildOfferData(req.body, { partial: false });
      if (built.error) return res.status(400).json({ success: false, error: built.error });
      const data = built.data;
 
      // One turf shouldn't accumulate hundreds of stale offers.
      const existing = await db.collection("offers")
        .where("turfId", "==", String(turfId))
        .where("active", "==", true)
        .get();
      if (existing.size >= 20) {
        return res.status(400).json({
          success: false,
          error: "This turf already has 20 active offers. Delete or pause some first.",
        });
      }
 
      // ⬇️ THE GATE. The client never sends status — the server decides.
      // An admin creating an offer can publish any size.
      const status =
        req.callerRole === "admin"
          ? "approved"
          : isWithinSelfServe(data.type, data.value, data.maxDiscount)
          ? "approved"
          : "pending";
 
      const ref = await db.collection("offers").add({
        ...data,
        ownerId:   access.ownerId,
        turfId:    String(turfId),
        turfName:  access.turf.name || "",
        active:    data.active !== undefined ? data.active : true,
        status,
        usedCount: 0,
        createdBy: req.callerRole === "admin" ? "admin" : "owner",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
 
      return res.json({ success: true, offerId: ref.id, status });
    } catch (e) {
      console.error("createoffer error: - server.js:613", e);
      return res.status(400).json({ success: false, error: e.message || "Could not create the offer." });
    }
  });
 
  // ===========================================================================
  // ✏️  UPDATE OFFER  (also handles the pause / resume switch)
  //     POST rather than PATCH — matches the rest of your API surface and
  //     avoids CORS method surprises.
  // ===========================================================================
  app.post("/update-offer/:offerId", offerLimiter, requireAdminOrOwner, async (req, res) => {
    try {
      const { offerId } = req.params;
      if (!offerId) return res.status(400).json({ success: false, error: "offerId is required." });
 
      const ref  = db.collection("offers").doc(String(offerId));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Offer not found." });
 
      const current = snap.data();
      if (req.callerRole !== "admin" && current.ownerId !== req.callerUid) {
        return res.status(403).json({ success: false, error: "This is not your offer." });
      }
 
      // A pause/resume is just { active: bool } — nothing else to validate.
      const onlyToggling =
        Object.keys(req.body).length === 1 && req.body.active !== undefined;
 
      const built = buildOfferData(req.body, { partial: true });
      if (built.error) return res.status(400).json({ success: false, error: built.error });
      const data = built.data;
 
      // Recompute the gate whenever the discount changed. An owner editing an
      // approved 15% offer up to 40% drops straight back to pending.
      let status = current.status;
      if (!onlyToggling) {
        const type = data.type ?? current.type;
        const value = data.value ?? current.value;
        const maxDiscount = data.maxDiscount ?? current.maxDiscount ?? 0;
        status =
          req.callerRole === "admin"
            ? (req.body.status === "rejected" ? "rejected" : "approved")
            : isWithinSelfServe(type, value, maxDiscount)
            ? "approved"
            : "pending";
      } else if (req.callerRole !== "admin" && current.status === "pending") {
        return res.status(400).json({
          success: false,
          error: "This offer is waiting for approval and can't be switched on yet.",
        });
      }
 
      // Fields the client can NEVER set, whatever it sends.
      delete data.ownerId;
      delete data.turfId;
      delete data.usedCount;
      delete data.createdAt;
      delete data.createdBy;
 
      // An admin rejecting an offer can attach a reason the owner will see.
           const extra = {};
      if (req.callerRole === "admin" && req.body.rejectionReason !== undefined) {
        extra.rejectionReason = String(req.body.rejectionReason || "").slice(0, 300);
      } else if (status !== "rejected" && current.rejectionReason) {
        extra.rejectionReason = admin.firestore.FieldValue.delete();
      }
 
      await ref.update({
        ...data,
        ...extra,
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
 
      return res.json({ success: true, offerId: String(offerId), status });
    } catch (e) {
      console.error("updateoffer error: - server.js:689", e);
      return res.status(400).json({ success: false, error: e.message || "Could not update the offer." });
    }
  });
 
  // ===========================================================================
  // 🗑️  DELETE OFFER
  // ===========================================================================
  app.delete("/delete-offer/:offerId", offerLimiter, requireAdminOrOwner, async (req, res) => {
    try {
      const { offerId } = req.params;
      if (!offerId) return res.status(400).json({ success: false, error: "offerId is required." });
 
      const ref  = db.collection("offers").doc(String(offerId));
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Offer not found." });
 
      const current = snap.data();
      if (req.callerRole !== "admin" && current.ownerId !== req.callerUid) {
        return res.status(403).json({ success: false, error: "This is not your offer." });
      }
 
      await ref.delete();
      return res.json({ success: true, offerId: String(offerId) });
    } catch (e) {
      console.error("deleteoffer error: - server.js:714", e);
      return res.status(400).json({ success: false, error: e.message || "Could not delete the offer." });
    }
  });

  // =======================================================
  // ✅ CREATE ORDER
  // =======================================================
  app.post("/create-order", orderLimiter, async (req, res) => {
    try {
      const { turfId, slots, dateString, userId, bookingType, promoId, promoCode, discount, usePcoins, useVcoins } = req.body;

      if (!turfId || !dateString) return res.status(400).json({ error: "turfId and dateString required" });
      if (!Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: "slots required" });

           const turfDoc = await db.collection("turfs").doc(turfId).get();
      if (!turfDoc.exists) return res.status(404).json({ error: "Turf not found" });
      const turf = turfDoc.data();

      // ── Phone-only turfs take no online bookings (protects old app versions) ──
      if (turf.bookingMode === "phone") {
        return res.status(403).json({
          success: false,
          phoneOnly: true,
          error: "This turf takes bookings by phone only. Please update the app and call the turf to book.",
        });
      }

      // ── Paused turfs can't be booked either ──
      if (turf.active === false) {
        return res.status(403).json({
          success: false,
          error: "This turf is not taking bookings right now.",
        });
      }

            // ── Quick-slots-only turfs: booking must sit exactly on the slot grid ──
      if (turf.flexibleSlotsEnabled === false) {
        const dur      = Number(turf.slotDuration || 60);              // minutes
        const openMin  = Number(turf.openingTime || 0) * 60;
        const toMin    = (t) => parseTimePart(t);                      // existing helper
        const ranges   = slots.map((sl) => {
          const [a, b] = String(sl).split(" - ");
          const start  = toMin(a);
          let   end    = toMin(b);
          if (end <= start) end = 24 * 60;                             // "12:00 AM" end
          return { start, end };
        });
        const startMin = Math.min(...ranges.map((r) => r.start));
        const endMin   = Math.max(...ranges.map((r) => r.end));
        const onGrid   = (startMin - openMin) % dur === 0 && (endMin - startMin) % dur === 0;
        if (!onGrid) {
          return res.status(400).json({
            success: false,
            error: `This turf only takes fixed ${dur}-minute slots. Please update the app and pick a Quick Slot.`,
          });
        }
      }

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

      const dayType = getDayType(dateString);
      let totalAmount = 0;
      for (const slot of slots) {
        const special = specialPrices.find((s) => String(s.slotTime).trim() === String(slot).trim());
        if (special) {
          totalAmount += Number(special.price);
        } else {
          const hour = parseHour(slot);
          const hourlyPrice = getHourlyRate(turf, hour, dayType);
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

// ── Coin discount (PCoin + VCoin) ────────────────────────────────────────────
  // 🔒 SECURITY FIX: usePcoins/useVcoins come straight from the client and
  // must NEVER be trusted at face value — always clamp to the user's REAL
  // wallet balance (pcoinWallets / vcoinWallets) before letting them reduce
  // the amount charged. Without this, anyone could request usePcoins:999999
  // and get a free discount regardless of what they've actually earned.
  const requestedPcoins = Math.max(Number(usePcoins || 0), 0);
  const requestedVcoins = Math.max(Number(useVcoins || 0), 0);

  let pcoinsToUse = 0;
  let vcoinsToUse = 0;

  if ((requestedPcoins > 0 || requestedVcoins > 0) && userId) {
    const [pcWalletSnap, vcWalletSnap] = await Promise.all([
      requestedPcoins > 0
        ? db.collection("pcoinWallets").doc(userId).get()
        : Promise.resolve(null),
      requestedVcoins > 0
        ? db.collection("vcoinWallets").doc(`${userId}_${turfId}`).get()
        : Promise.resolve(null),
    ]);

    const actualPcoinBalance = pcWalletSnap?.exists ? Number(pcWalletSnap.data().balance || 0) : 0;
    const actualVcoinBalance = vcWalletSnap?.exists ? Number(vcWalletSnap.data().balance || 0) : 0;

    // Never let the client spend more than they actually have
    pcoinsToUse = Math.min(requestedPcoins, actualPcoinBalance);
    vcoinsToUse = Math.min(requestedVcoins, actualVcoinBalance);
  }

  const coinDiscount = pcoinsToUse + vcoinsToUse;
  let appliedCoinDiscount = 0;              // NEW — tracks what was ACTUALLY deducted
  if (coinDiscount > 0) {
    const preCoinAdvance = advanceAmount;
    advanceAmount = Math.max(advanceAmount - coinDiscount, 1);
    appliedCoinDiscount = preCoinAdvance - advanceAmount;   // NEW
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const remainingAmount = Math.max(totalAmount - advanceAmount - promoDiscount - appliedCoinDiscount, 0);

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
      discount:       promoDiscount,
        pcoinsRedeemed: pcoinsToUse,
        vcoinsRedeemed: vcoinsToUse,
        coinDiscount:   coinDiscount,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.KEY_ID });
    } catch (err) {
      console.error("createorder error: - server.js:913", err);
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
        } catch (e) { console.warn("Could not fetch user: - server.js:1083", e.message); }

        if (userName && bookingId) {
          db.collection("bookings").doc(bookingId)
            .update({ userName, userPhone, userEmail })
            .catch((e) => console.warn("Name update failed: - server.js:1088", e.message));
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
      } catch (e) { console.warn("Lock cleanup failed: - server.js:1103", e.message); }

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
        } catch (e) { console.warn("Promo usage recording failed: - server.js:1116", e.message); }
      }

      // =======================================================
      // 🪙 COIN EARN — PENDING (credited after slot completes)
      // PCoin: rate from settings/pcoinConfig
      // VCoin: rate from turf doc (vcoinEnabled + vcoinRate)
      // Both stored as PENDING — actual credit happens via
      // /credit-completed-coins cron after the slot ends
      // =======================================================
      let pcoinPending = 0;
      let vcoinPending = 0;

      if (orderData.userId && bookingId) {
        try {
        // ── Booking hours from slots (each slot = 30 min, 2 slots = 1 hr)
  const totalSlots   = Array.isArray(orderData.slots) ? orderData.slots.length : 0;
  const bookingHours = totalSlots > 0 ? totalSlots / 2 : 0;

  // ── PCoin: ratePerHour from admin config ─────────────────────────
  const pcoinConfigSnap = await db.collection("settings").doc("pcoinConfig").get();
  if (pcoinConfigSnap.exists) {
    const cfg = pcoinConfigSnap.data();
    if (cfg.enabled !== false && Number(cfg.ratePerHour || 0) > 0 && bookingHours > 0) {
      pcoinPending = Math.floor(bookingHours * Number(cfg.ratePerHour));
    }
  }

  // ── VCoin: vcoinRatePerHour from turf doc ────────────────────────
  const turfSnap = await db.collection("turfs").doc(orderData.turfId).get();
  if (turfSnap.exists) {
    const turfData = turfSnap.data();
    if (turfData.vcoinEnabled === true && Number(turfData.vcoinRatePerHour || 0) > 0 && bookingHours > 0) {
      vcoinPending = Math.floor(bookingHours * Number(turfData.vcoinRatePerHour));
    }
  }

          // ── Write pending coins to booking doc ───────────────────────────
          const coinUpdate = {};
          if (pcoinPending > 0) coinUpdate.pcoinPending = pcoinPending;
          if (vcoinPending > 0) coinUpdate.vcoinPending = vcoinPending;
          coinUpdate.coinStatus = "pending"; // pending → credited after slot ends

        await db.collection("bookings").doc(bookingId).update(coinUpdate)
    .catch((e) => console.warn("Coin booking update failed: - server.js:1160", e.message));

          // ── PCoin: increment pendingBalance in wallet ────────────────────
          if (pcoinPending > 0) {
            const pcWalletRef = db.collection("pcoinWallets").doc(orderData.userId);
            await db.runTransaction(async (txn) => {
              const snap = await txn.get(pcWalletRef);
              if (snap.exists) {
                txn.update(pcWalletRef, {
                  pendingBalance: admin.firestore.FieldValue.increment(pcoinPending),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              } else {
                txn.set(pcWalletRef, {
                  uid:            orderData.userId,
                  balance:        0,
                  pendingBalance: pcoinPending,
                  totalEarned:    0,
                  totalRedeemed:  0,
                  createdAt:      admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });

            // Ledger entry
            await db.collection("pcoinLedger").add({
              uid:          orderData.userId,
              type:         "pcoin_earn_pending",
              coins:        pcoinPending,
              bookingId,
              turfId:       orderData.turfId,
              turfName:     orderData.turfName || "",
              note:         `Pending — will credit after slot completes`,
              createdAt:    admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // ── VCoin: increment pendingBalance in turf-specific wallet ──────
          if (vcoinPending > 0) {
            const vcWalletKey = `${orderData.userId}_${orderData.turfId}`;
            const vcWalletRef = db.collection("vcoinWallets").doc(vcWalletKey);
            await db.runTransaction(async (txn) => {
              const snap = await txn.get(vcWalletRef);
              if (snap.exists) {
                txn.update(vcWalletRef, {
                  pendingBalance: admin.firestore.FieldValue.increment(vcoinPending),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              } else {
                txn.set(vcWalletRef, {
                  uid:            orderData.userId,
                  turfId:         orderData.turfId,
                  turfName:       orderData.turfName || "",
                  balance:        0,
                  pendingBalance: vcoinPending,
                  totalEarned:    0,
                  totalRedeemed:  0,
                  createdAt:      admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });

            // Ledger entry
            await db.collection("vcoinLedger").add({
              uid:       orderData.userId,
              type:      "vcoin_earn_pending",
              coins:     vcoinPending,
              bookingId,
              turfId:    orderData.turfId,
              turfName:  orderData.turfName || "",
              note:      `Pending — will credit after slot completes`,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          console.log(`🪙 Coins pending: pcoin=${pcoinPending} vcoin=${vcoinPending} bookingId=${bookingId} - server.js:1237`);
        } catch (coinErr) {
          // Coin errors must NEVER block booking confirmation
          console.warn("Coin pending earn failed (nonfatal): - server.js:1240", coinErr.message);
        }
      }
      // =======================================================
      // END COIN EARN
      // =======================================================


      // =======================================================
      // 🪙 COIN REDEEM — Deduct coins from wallets after payment
      // =======================================================
      try {
        const pcoinsRequested = Number(orderData.pcoinsRedeemed || 0);
        const vcoinsRequested = Number(orderData.vcoinsRedeemed || 0);

        // 🔒 SECURITY FIX: re-check the REAL balance here too (not just at
        // create-order time) and only ever deduct min(requested, current).
        // This closes the race where two bookings are created back-to-back
        // before either one is paid — without this, both could "redeem"
        // the same coins. `totalRedeemed` is also incremented by the
        // actual amount taken, never by the requested amount, so the
        // ledger can never show more redeemed than was ever earned.
        let pcoinsActuallyRedeemed = 0;
        let vcoinsActuallyRedeemed = 0;

        // ── Deduct PCoin ─────────────────────────────────────
        if (pcoinsRequested > 0 && orderData.userId) {
          const pcWalletRef = db.collection("pcoinWallets").doc(orderData.userId);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            if (!snap.exists) return;
            const current = Number(snap.data().balance || 0);
            pcoinsActuallyRedeemed = Math.min(current, pcoinsRequested);
            if (pcoinsActuallyRedeemed <= 0) return;
            txn.update(pcWalletRef, {
              balance:        admin.firestore.FieldValue.increment(-pcoinsActuallyRedeemed),
              totalRedeemed:  admin.firestore.FieldValue.increment(pcoinsActuallyRedeemed),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          if (pcoinsActuallyRedeemed > 0) {
            await db.collection("pcoinLedger").add({
              uid:       orderData.userId,
              type:      "pcoin_redeem",
              coins:     pcoinsActuallyRedeemed,
              bookingId,
              turfId:    orderData.turfId,
              turfName:  orderData.turfName || "",
              note:      `Used ${pcoinsActuallyRedeemed} PCoin as discount`,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        // ── Deduct VCoin ─────────────────────────────────────
        if (vcoinsRequested > 0 && orderData.userId && orderData.turfId) {
          const vcKey    = `${orderData.userId}_${orderData.turfId}`;
          const vcWalRef = db.collection("vcoinWallets").doc(vcKey);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalRef);
            if (!snap.exists) return;
            const current = Number(snap.data().balance || 0);
            vcoinsActuallyRedeemed = Math.min(current, vcoinsRequested);
            if (vcoinsActuallyRedeemed <= 0) return;
            txn.update(vcWalRef, {
              balance:        admin.firestore.FieldValue.increment(-vcoinsActuallyRedeemed),
              totalRedeemed:  admin.firestore.FieldValue.increment(vcoinsActuallyRedeemed),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          if (vcoinsActuallyRedeemed > 0) {
            await db.collection("vcoinLedger").add({
              uid:       orderData.userId,
              type:      "vcoin_redeem",
              coins:     vcoinsActuallyRedeemed,
              bookingId,
              turfId:    orderData.turfId,
              turfName:  orderData.turfName || "",
              note:      `Used ${vcoinsActuallyRedeemed} VCoin as discount at this turf`,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        // ── Save ACTUAL redeemed coins to booking doc ────────
        // (may be less than what create-order applied as a discount, in the
        // rare race case above — logged so it's easy to spot in the console)
        if ((pcoinsActuallyRedeemed > 0 || vcoinsActuallyRedeemed > 0) && bookingId) {
          await db.collection("bookings").doc(bookingId).update({
            pcoinsRedeemed: pcoinsActuallyRedeemed,
            vcoinsRedeemed: vcoinsActuallyRedeemed,
          }).catch(() => {});
          console.log(`🪙 Coins redeemed: pcoin=${pcoinsActuallyRedeemed} vcoin=${vcoinsActuallyRedeemed} bookingId=${bookingId} - server.js:1332`);
        }
        if (pcoinsActuallyRedeemed < pcoinsRequested || vcoinsActuallyRedeemed < vcoinsRequested) {
          console.warn(`🪙 Coin redeem shortfall: requested pcoin=${pcoinsRequested}/vcoin=${vcoinsRequested}, actually redeemed pcoin=${pcoinsActuallyRedeemed}/vcoin=${vcoinsActuallyRedeemed}, bookingId=${bookingId} - server.js:1335`);
        }
      } catch (redeemErr) {
        console.warn("Coin redeem failed (nonfatal): - server.js:1338", redeemErr.message);
      }
      // =======================================================
      // END COIN REDEEM
      // =======================================================

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

      return res.json({ success: true, bookingId, pcoinPending, vcoinPending });

    } catch (err) {
      console.error("verifypayment error: - server.js:1361", err);

      if (err.message?.startsWith("SLOT_CONFLICT") && payment_id_outer) {
        try {
          const payment = await razorpay.payments.fetch(payment_id_outer);
          if (payment.status === "captured") {
            const refund = await razorpay.payments.refund(payment_id_outer, {
              amount: payment.amount, notes: { reason: err.message }, speed: "normal",
            });
            console.log("Autorefund initiated: - server.js:1370", refund.id);
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
          console.error("Autorefund failed: - server.js:1385", refundErr.message);
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
      } catch (e) { console.warn("Failed order update: - server.js:1404", e.message); }

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
      } catch (e) { console.warn("Lock cleanup on cancel failed: - server.js:1492", e.message); }

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
          console.error("Razorpay refund error: - server.js:1510", refundError.message);
          await bookingRef.update({
            refundStatus: "failed", refundError: refundError.message,
            refundFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          refundNote = "refund_failed";
        }
      }

      // =======================================================
      // 🪙 COIN REVERSAL — Cancel booking clears pending coins
      // AND refunds any coins the user REDEEMED as a discount on this
      // booking. Two separate things can be true on one booking:
      //   1. pcoinPending/vcoinPending = coins they would have EARNED
      //      (not yet credited — just clear the pending amount)
      //   2. pcoinsRedeemed/vcoinsRedeemed = coins they already SPENT as
      //      a discount to pay for this booking — these must be credited
      //      BACK to their wallet, same as the ₹ refund above, or the
      //      coins are just gone with nothing to show for it.
      // =======================================================
      try {
        const pcoinPending = Number(booking.pcoinPending || 0);
        const vcoinPending = Number(booking.vcoinPending || 0);
        const pcoinsRedeemed = Number(booking.pcoinsRedeemed || 0);   // NEW
        const vcoinsRedeemed = Number(booking.vcoinsRedeemed || 0);   // NEW

        // ── Reverse PCoin pending ────────────────────────────────────────────
        if (pcoinPending > 0 && userId) {
          const pcWalletRef = db.collection("pcoinWallets").doc(userId);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            if (!snap.exists) return;
            const current = Number(snap.data().pendingBalance || 0);
            txn.update(pcWalletRef, {
              pendingBalance: Math.max(current - pcoinPending, 0),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          await db.collection("pcoinLedger").add({
            uid:       userId,
            type:      "pcoin_earn_reversed",
            coins:     pcoinPending,
            bookingId,
            turfId:    booking.turfId || "",
            turfName:  booking.turfName || "",
            note:      "Booking cancelled — pending coins reversed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // ── Reverse VCoin pending ────────────────────────────────────────────
        if (vcoinPending > 0 && userId && booking.turfId) {
          const vcWalletKey = `${userId}_${booking.turfId}`;
          const vcWalletRef = db.collection("vcoinWallets").doc(vcWalletKey);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalletRef);
            if (!snap.exists) return;
            const current = Number(snap.data().pendingBalance || 0);
            txn.update(vcWalletRef, {
              pendingBalance: Math.max(current - vcoinPending, 0),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          await db.collection("vcoinLedger").add({
            uid:       userId,
            type:      "vcoin_earn_reversed",
            coins:     vcoinPending,
            bookingId,
            turfId:    booking.turfId,
            turfName:  booking.turfName || "",
            note:      "Booking cancelled — pending coins reversed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // ── NEW: Refund PCoin that was REDEEMED (spent) on this booking ─────
        if (pcoinsRedeemed > 0 && userId) {
          const pcWalletRef = db.collection("pcoinWallets").doc(userId);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            const current = snap.exists ? Number(snap.data().balance || 0) : 0;
            const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
            if (snap.exists) {
              txn.update(pcWalletRef, {
                balance:       current + pcoinsRedeemed,
                totalRedeemed: Math.max(currentRedeemed - pcoinsRedeemed, 0),
                updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(pcWalletRef, {
                uid: userId, balance: pcoinsRedeemed, pendingBalance: 0,
                totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("pcoinLedger").add({
            uid: userId, type: "pcoin_redeem_reversed", coins: pcoinsRedeemed,
            bookingId, turfId: booking.turfId || "", turfName: booking.turfName || "",
            note: "Booking cancelled — PCoin used as discount refunded to wallet",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // ── NEW: Refund VCoin that was REDEEMED (spent) on this booking ─────
        if (vcoinsRedeemed > 0 && userId && booking.turfId) {
          const vcWalletKey = `${userId}_${booking.turfId}`;
          const vcWalletRef = db.collection("vcoinWallets").doc(vcWalletKey);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalletRef);
            const current = snap.exists ? Number(snap.data().balance || 0) : 0;
            const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
            if (snap.exists) {
              txn.update(vcWalletRef, {
                balance:       current + vcoinsRedeemed,
                totalRedeemed: Math.max(currentRedeemed - vcoinsRedeemed, 0),
                updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(vcWalletRef, {
                uid: userId, turfId: booking.turfId, turfName: booking.turfName || "",
                balance: vcoinsRedeemed, pendingBalance: 0, totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("vcoinLedger").add({
            uid: userId, type: "vcoin_redeem_reversed", coins: vcoinsRedeemed,
            bookingId, turfId: booking.turfId, turfName: booking.turfName || "",
            note: "Booking cancelled — VCoin used as discount refunded to wallet",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // ── Mark booking coins as cancelled ─────────────────────────────────
        if (pcoinPending > 0 || vcoinPending > 0 || pcoinsRedeemed > 0 || vcoinsRedeemed > 0) {
          await bookingRef.update({
            pcoinPending: 0,
            vcoinPending: 0,
            pcoinsRedeemed: 0,   // NEW — zeroed so this can't be double-refunded
            vcoinsRedeemed: 0,   // NEW
            coinStatus:   "cancelled",
          }).catch(() => {});
          console.log(`🪙 Coins reversed: pcoin=${pcoinPending} vcoin=${vcoinPending} pcoinRefunded=${pcoinsRedeemed} vcoinRefunded=${vcoinsRedeemed} bookingId=${bookingId} - server.js:1655`);
        }
      } catch (coinErr) {
        // Coin reversal errors must NEVER block cancellation response
        console.warn("Coin reversal failed (nonfatal): - server.js:1659", coinErr.message);
      }
      // =======================================================
      // END COIN REVERSAL
      // =======================================================

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
      console.error("cancelbooking error: - server.js:1685", err);
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
          console.error("Admin refund failed: - server.js:1735", refundErr.message);
          await bookingRef.update({ refundStatus: "failed", refundError: refundErr.message });
          refundNote = "refund_failed";
        }
      }

      // =======================================================
      // 🪙 COIN REVERSAL — this endpoint had NO coin handling at all before.
      // Same as /cancel-booking and /owner-cancel-booking: clear any pending
      // (not-yet-earned) coins, AND refund any coins the user REDEEMED
      // (spent) as a discount on this booking back into their wallet.
      // =======================================================
      try {
        const pcoinPending   = Number(booking.pcoinPending || 0);
        const vcoinPending   = Number(booking.vcoinPending || 0);
        const pcoinsRedeemed = Number(booking.pcoinsRedeemed || 0);
        const vcoinsRedeemed = Number(booking.vcoinsRedeemed || 0);
        const uid = booking.userId;

        if (pcoinPending > 0 && uid) {
          const pcWalletRef = db.collection("pcoinWallets").doc(uid);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            if (!snap.exists) return;
            const current = Number(snap.data().pendingBalance || 0);
            txn.update(pcWalletRef, {
              pendingBalance: Math.max(current - pcoinPending, 0),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          await db.collection("pcoinLedger").add({
            uid, type: "pcoin_earn_reversed", coins: pcoinPending, bookingId,
            turfId: booking.turfId || "", turfName: booking.turfName || "",
            note: "Booking cancelled by admin — pending coins reversed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (vcoinPending > 0 && uid && booking.turfId) {
          const vcWalletRef = db.collection("vcoinWallets").doc(`${uid}_${booking.turfId}`);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalletRef);
            if (!snap.exists) return;
            const current = Number(snap.data().pendingBalance || 0);
            txn.update(vcWalletRef, {
              pendingBalance: Math.max(current - vcoinPending, 0),
              updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
            });
          });
          await db.collection("vcoinLedger").add({
            uid, type: "vcoin_earn_reversed", coins: vcoinPending, bookingId,
            turfId: booking.turfId, turfName: booking.turfName || "",
            note: "Booking cancelled by admin — pending coins reversed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (pcoinsRedeemed > 0 && uid) {
          const pcWalletRef = db.collection("pcoinWallets").doc(uid);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            const current = snap.exists ? Number(snap.data().balance || 0) : 0;
            const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
            if (snap.exists) {
              txn.update(pcWalletRef, {
                balance:       current + pcoinsRedeemed,
                totalRedeemed: Math.max(currentRedeemed - pcoinsRedeemed, 0),
                updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(pcWalletRef, {
                uid, balance: pcoinsRedeemed, pendingBalance: 0, totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("pcoinLedger").add({
            uid, type: "pcoin_redeem_reversed", coins: pcoinsRedeemed, bookingId,
            turfId: booking.turfId || "", turfName: booking.turfName || "",
            note: "Booking cancelled by admin — PCoin used as discount refunded to wallet",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (vcoinsRedeemed > 0 && uid && booking.turfId) {
          const vcWalletRef = db.collection("vcoinWallets").doc(`${uid}_${booking.turfId}`);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalletRef);
            const current = snap.exists ? Number(snap.data().balance || 0) : 0;
            const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
            if (snap.exists) {
              txn.update(vcWalletRef, {
                balance:       current + vcoinsRedeemed,
                totalRedeemed: Math.max(currentRedeemed - vcoinsRedeemed, 0),
                updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(vcWalletRef, {
                uid, turfId: booking.turfId, turfName: booking.turfName || "",
                balance: vcoinsRedeemed, pendingBalance: 0, totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("vcoinLedger").add({
            uid, type: "vcoin_redeem_reversed", coins: vcoinsRedeemed, bookingId,
            turfId: booking.turfId, turfName: booking.turfName || "",
            note: "Booking cancelled by admin — VCoin used as discount refunded to wallet",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (pcoinPending > 0 || vcoinPending > 0 || pcoinsRedeemed > 0 || vcoinsRedeemed > 0) {
          await bookingRef.update({
            pcoinPending: 0, vcoinPending: 0,
            pcoinsRedeemed: 0, vcoinsRedeemed: 0,
            coinStatus: "cancelled",
          }).catch(() => {});
        }
      } catch (coinErr) {
        console.warn("Admin cancel coin reversal failed (nonfatal): - server.js:1857", coinErr.message);
      }
      // =======================================================
      // END COIN REVERSAL
      // =======================================================

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
      console.error("admincancelbooking error: - server.js:1881", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });



  app.post("/owner-cancel-booking", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { bookingId, reason, note } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: "bookingId is required" });
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: "A cancellation reason is required." });
    }
 
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();
 
    // ── Ownership guard: owners can only touch their own turf's bookings ──
    if (req.callerRole !== "admin" && booking.ownerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You can only cancel bookings on your own turfs." });
    }
 
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "This booking is already cancelled." });
    }
 
    // ── Block cancelling bookings that already finished ──
    const bookingDate = booking.date?.toDate ? booking.date.toDate() : new Date(booking.dateString);
    const bookingDay  = new Date(bookingDate); bookingDay.setHours(0, 0, 0, 0);
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    if (!isNaN(bookingDay.getTime()) && bookingDay < today) {
      return res.status(400).json({ success: false, error: "Cannot cancel a booking that has already passed." });
    }
 
    const paidAmount   = Number(booking.paidAmount || booking.advanceAmount || 0);
    const paymentId    = booking.paymentId || null;
    const wasOnline    = !!paymentId;
    const refundAmount = wasOnline ? paidAmount : 0;
 
    await bookingRef.update({
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           req.callerRole === "admin" ? "admin" : "owner",
      cancellationReason:    String(reason).trim(),
      ownerCancelNote:       note ? String(note).trim() : "",
      refundStatus:          wasOnline ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });
 
    // ── Auto refund the full online amount ──
    let refundId = null, refundNote = "no_refund";
    if (wasOnline && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes:  { bookingId, reason: `Owner cancelled: ${reason}` },
          speed:  "normal",
        });
        refundId   = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId, refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (refundErr) {
        console.error("Owner cancel refund failed: - server.js:1950", refundErr.message);
        await bookingRef.update({ refundStatus: "failed", refundError: refundErr.message });
        refundNote = "refund_failed";
      }
    }
 
    // ── Reverse pending coins + refund redeemed coins (never blocks the response) ──
    try {
      const pcoinPending = Number(booking.pcoinPending || 0);
      const vcoinPending = Number(booking.vcoinPending || 0);
      const pcoinsRedeemed = Number(booking.pcoinsRedeemed || 0);   // NEW
      const vcoinsRedeemed = Number(booking.vcoinsRedeemed || 0);   // NEW
      const uid = booking.userId;
 
      if (pcoinPending > 0 && uid) {
        const pcWalletRef = db.collection("pcoinWallets").doc(uid);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(pcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(pcWalletRef, {
            pendingBalance: Math.max(current - pcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("pcoinLedger").add({
          uid, type: "pcoin_earn_reversed", coins: pcoinPending, bookingId,
          turfId: booking.turfId || "", turfName: booking.turfName || "",
          note: "Booking cancelled by venue — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
 
      if (vcoinPending > 0 && uid && booking.turfId) {
        const vcWalletRef = db.collection("vcoinWallets").doc(`${uid}_${booking.turfId}`);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(vcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(vcWalletRef, {
            pendingBalance: Math.max(current - vcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("vcoinLedger").add({
          uid, type: "vcoin_earn_reversed", coins: vcoinPending, bookingId,
          turfId: booking.turfId, turfName: booking.turfName || "",
          note: "Booking cancelled by venue — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // ── NEW: refund PCoin the user REDEEMED (spent) on this booking ──
      if (pcoinsRedeemed > 0 && uid) {
        const pcWalletRef = db.collection("pcoinWallets").doc(uid);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(pcWalletRef);
          const current = snap.exists ? Number(snap.data().balance || 0) : 0;
          const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
          if (snap.exists) {
            txn.update(pcWalletRef, {
              balance:       current + pcoinsRedeemed,
              totalRedeemed: Math.max(currentRedeemed - pcoinsRedeemed, 0),
              updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
            });
          } else {
            txn.set(pcWalletRef, {
              uid, balance: pcoinsRedeemed, pendingBalance: 0, totalEarned: 0, totalRedeemed: 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        });
        await db.collection("pcoinLedger").add({
          uid, type: "pcoin_redeem_reversed", coins: pcoinsRedeemed, bookingId,
          turfId: booking.turfId || "", turfName: booking.turfName || "",
          note: "Booking cancelled by venue — PCoin used as discount refunded to wallet",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // ── NEW: refund VCoin the user REDEEMED (spent) on this booking ──
      if (vcoinsRedeemed > 0 && uid && booking.turfId) {
        const vcWalletRef = db.collection("vcoinWallets").doc(`${uid}_${booking.turfId}`);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(vcWalletRef);
          const current = snap.exists ? Number(snap.data().balance || 0) : 0;
          const currentRedeemed = snap.exists ? Number(snap.data().totalRedeemed || 0) : 0;
          if (snap.exists) {
            txn.update(vcWalletRef, {
              balance:       current + vcoinsRedeemed,
              totalRedeemed: Math.max(currentRedeemed - vcoinsRedeemed, 0),
              updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
            });
          } else {
            txn.set(vcWalletRef, {
              uid, turfId: booking.turfId, turfName: booking.turfName || "",
              balance: vcoinsRedeemed, pendingBalance: 0, totalEarned: 0, totalRedeemed: 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        });
        await db.collection("vcoinLedger").add({
          uid, type: "vcoin_redeem_reversed", coins: vcoinsRedeemed, bookingId,
          turfId: booking.turfId, turfName: booking.turfName || "",
          note: "Booking cancelled by venue — VCoin used as discount refunded to wallet",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
 
      if (pcoinPending > 0 || vcoinPending > 0 || pcoinsRedeemed > 0 || vcoinsRedeemed > 0) {
        await bookingRef.update({
          pcoinPending: 0, vcoinPending: 0,
          pcoinsRedeemed: 0, vcoinsRedeemed: 0,   // NEW — zeroed so this can't be double-refunded
          coinStatus: "cancelled",
        }).catch(() => {});
      }
    } catch (coinErr) {
      console.warn("Owner cancel coin reversal failed (nonfatal): - server.js:2069", coinErr.message);
    }
 
    // ── Notify the user ──
    sendPushToUser(booking.userId, "❌ Booking Cancelled by Venue",
      wasOnline && refundAmount > 0
        ? `Your booking at ${booking.turfName} on ${booking.dateString} was cancelled by the venue. Reason: ${reason}. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your booking at ${booking.turfName} on ${booking.dateString} was cancelled by the venue. Reason: ${reason}.`,
      { screen: "bookings", bookingId }
    );
 
    return res.json({
      success: true, bookingId, refundStatus: refundNote, refundAmount, refundId,
      message: wasOnline && refundAmount > 0
        ? `Booking cancelled. ₹${refundAmount} refund initiated to the customer.`
        : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("ownercancelbooking error: - server.js:2087", err);
    return res.status(500).json({ success: false, error: err.message || "Cancellation failed." });
  }
});
 
// =======================================================
// 🔁 OWNER RESCHEDULE BOOKING (online/app bookings)
// - Owner can only reschedule bookings on THEIR OWN turfs
// - Validates the new date + slots against existing bookings,
//   blocked slots, and active slot locks (excluding itself)
// - Keeps all payment amounts unchanged (same duration)
// - Stores a reschedule history trail + notifies the user
// =======================================================
app.post("/owner-reschedule-booking", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { bookingId, newDateString, newSlots, reason } = req.body;
 
    if (!bookingId) return res.status(400).json({ success: false, error: "bookingId is required" });
    if (!newDateString || !String(newDateString).trim()) {
      return res.status(400).json({ success: false, error: "newDateString is required" });
    }
    if (!Array.isArray(newSlots) || newSlots.length === 0) {
      return res.status(400).json({ success: false, error: "newSlots array is required" });
    }
 
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();
 
    // ── Ownership guard ──
    if (req.callerRole !== "admin" && booking.ownerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You can only reschedule bookings on your own turfs." });
    }
 
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "Cannot reschedule a cancelled booking." });
    }
 
    // ── New date must not be in the past ──
    const newDate = new Date(newDateString);
    if (isNaN(newDate.getTime())) {
      return res.status(400).json({ success: false, error: "Invalid new date." });
    }
    const newDay = new Date(newDate); newDay.setHours(0, 0, 0, 0);
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    if (newDay < today) {
      return res.status(400).json({ success: false, error: "Cannot reschedule to a past date." });
    }
 
    // ── Duration must match the original booking (keeps pricing intact) ──
    const oldSlots = Array.isArray(booking.selectedSlots) ? booking.selectedSlots : [];
    if (oldSlots.length > 0 && newSlots.length !== oldSlots.length) {
      return res.status(400).json({
        success: false,
        error: `New slot selection must have the same duration as the original booking (${oldSlots.length} segments).`,
      });
    }
 
    // ── Conflict checks in a transaction ──
    const cleanNewSlots = newSlots.map((s) => String(s).trim());
 
    await db.runTransaction(async (txn) => {
      // Existing bookings on the new date (excluding this booking)
      const existingSnap = await txn.get(
        db.collection("bookings")
          .where("turfId", "==", booking.turfId)
          .where("dateString", "==", newDateString)
      );
      const existingSlots = existingSnap.docs
        .filter((d) => d.id !== bookingId)
        .map((d) => d.data())
        .filter((b) => b.status !== "cancelled")
        .flatMap((b) => b.selectedSlots || [])
        .map((s) => String(s).trim());
 
      for (const slot of cleanNewSlots) {
        if (existingSlots.includes(slot)) {
          throw new Error(`SLOT_CONFLICT: Slot already booked: ${slot}`);
        }
      }
 
      // Blocked slots on the new date
      const blockedSnap = await txn.get(
        db.collection("blockedSlots")
          .where("turfId", "==", booking.turfId)
          .where("date", "==", newDateString)
      );
      const blockedList = blockedSnap.docs
        .flatMap((d) => (Array.isArray(d.data().slots) ? d.data().slots : [d.data().slotTime]).filter(Boolean))
        .map((s) => String(s).trim());
 
      for (const slot of cleanNewSlots) {
        if (blockedList.includes(slot)) {
          throw new Error(`SLOT_CONFLICT: Slot is blocked: ${slot}`);
        }
      }
 
      // Active slot locks by other users on the new date
      const lockSnap = await txn.get(
        db.collection("slotLocks")
          .where("turfId", "==", booking.turfId)
          .where("dateString", "==", newDateString)
      );
      const now = new Date();
      const lockedByOthers = lockSnap.docs.map((d) => d.data())
        .filter((l) => {
          const expiry = l.expiresAt?.toDate?.() || new Date(l.expiresAt);
          return l.userId !== booking.userId && expiry > now;
        })
        .map((l) => String(l.slotTime).trim());
 
      for (const slot of cleanNewSlots) {
        if (lockedByOthers.includes(slot)) {
          throw new Error(`SLOT_CONFLICT: Slot is being booked by another user: ${slot}`);
        }
      }
 
      // ── All clear — apply the reschedule ──
      const parsedDate = new Date(newDateString);
      txn.update(bookingRef, {
        dateString:    newDateString,
        date:          admin.firestore.Timestamp.fromDate(isNaN(parsedDate.getTime()) ? new Date() : parsedDate),
        selectedSlots: cleanNewSlots,
        rescheduled:   true,
        rescheduleCount: admin.firestore.FieldValue.increment(1),
        rescheduleHistory: admin.firestore.FieldValue.arrayUnion({
          fromDate:  booking.dateString || "",
          fromSlots: oldSlots,
          toDate:    newDateString,
          toSlots:   cleanNewSlots,
          by:        req.callerRole === "admin" ? "admin" : "owner",
          reason:    reason ? String(reason).trim() : "",
          at:        new Date().toISOString(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
 
    // ── Notify the user of the new time ──
    const slotSummary = getProfessionalSlotRange(cleanNewSlots);
    const dateOnly    = newDateString.split(" ").slice(0, 3).join(" ") || newDateString;
    sendPushToUser(booking.userId, "🔁 Booking Rescheduled",
      `Your booking at ${booking.turfName} has been moved to ${dateOnly}, ${slotSummary}.${reason ? ` Reason: ${reason}` : ""}`,
      { screen: "bookings", bookingId }
    );
 
    return res.json({
      success: true, bookingId,
      newDateString, newSlots: cleanNewSlots,
      message: "Booking rescheduled successfully. The customer has been notified.",
    });
  } catch (err) {
    console.error("ownerreschedulebooking error: - server.js:2240", err);
    if (err.message?.startsWith("SLOT_CONFLICT")) {
      return res.status(409).json({
        success: false,
        slotConflict: true,
        error: err.message.replace("SLOT_CONFLICT: ", ""),
      });
    }
    return res.status(500).json({ success: false, error: err.message || "Reschedule failed." });
  }
});

 //new settlement section
app.post("/mark-settlement-paid", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    // Only real admins can mark payouts as sent — not owners themselves.
    if (req.callerRole !== "admin") {
      return res.status(403).json({ success: false, error: "Only admins can mark settlements as paid." });
    }
 
    const { key, turfId, turfName, ownerId, dateKey, date, amount, bookingIds, reference, note } = req.body;
 
    if (!key || !turfId || !ownerId || !dateKey || amount === undefined) {
      return res.status(400).json({ success: false, error: "Missing required settlement fields." });
    }
 
    const settlementRef = db.collection("settlements").doc(key);
 
    // Idempotency guard: if this turf-day was already marked paid, don't
    // re-write it (and don't send a duplicate notification) on a retry/double-tap.
    const existing = await settlementRef.get();
    if (existing.exists && existing.data().status === "paid") {
      return res.json({ success: true, key, alreadyPaid: true });
    }
 
    await settlementRef.set({
      turfId,
      turfName:   turfName || "",
      ownerId,
      dateKey,
      date:       date ? new Date(date) : new Date(dateKey),
      amount:     Number(amount),
      bookingIds: Array.isArray(bookingIds) ? bookingIds : [],
      status:     "paid",
      paidBy:     req.callerUid,
      reference:  reference || null,
      note:       note || null,
      paidAt:     admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
 
    // ── Notify the owner ──────────────────────────────────────────────────
    const amountFmt = `₹${Math.round(Number(amount)).toLocaleString("en-IN")}`;
    sendPushToUser(
      ownerId,
      "💰 Settlement Paid",
      `${turfName || "Your turf"} · ${dateKey} settlement of ${amountFmt} has been transferred to your bank account.`,
      { screen: "owner-settlement", settlementKey: key }
    );
 
    return res.json({ success: true, key });
  } catch (err) {
    console.error("marksettlementpaid error: - server.js:2301", err);
    return res.status(500).json({ success: false, error: err.message || "Could not mark settlement as paid." });
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
      console.error("refundstatus error: - server.js:2336", err);
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
      console.error("createleagueowner error: - server.js:2450", e);
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
      console.error("deleteowner error: - server.js:2485", e);
      res.status(400).json({ success: false, error: e.message });
    }
  });


  //delete user setion button //

  app.delete("/delete-my-account", async (req, res) => {
    try {
      // 1) Verify Firebase ID token from the Authorization header
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) {
        return res.status(401).json({ success: false, error: "Missing auth token." });
      }
  
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(token);
      } catch {
        return res.status(401).json({ success: false, error: "Invalid or expired token." });
      }
  
      const uid = decoded.uid;
  
      // 2) Load the user doc and check role — only regular users self-delete
      const userRef  = db.collection("users").doc(uid);
      const userSnap = await userRef.get();
  
      if (userSnap.exists) {
        const role = userSnap.data().role;
        if (role === "owner" || role === "turf-operator" || role === "operator" || role === "admin") {
          return res.status(403).json({
            success: false,
            error: "Business accounts cannot be self-deleted. Please contact support at playonsport03@gmail.com.",
          });
        }
      }
  
      // 3) Delete related personal data (best-effort, never blocks deletion)
      //    Player profile (Playon Pro), if one exists
      await db.collection("playerProfiles").doc(uid).delete().catch(() => {});
  
      // 4) Delete the Firestore user document
      await userRef.delete().catch(() => {});
  
      // 5) Delete the Firebase Auth account (this signs them out everywhere)
      await admin.auth().deleteUser(uid);
  
      console.log(`🗑️ Account selfdeleted: ${uid} - server.js:2535`);
      return res.json({ success: true });
    } catch (err) {
      console.error("deletemyaccount error: - server.js:2538", err);
      return res.status(500).json({ success: false, error: err.message || "Could not delete account." });
    }
  });

    // =======================================================
  // 📞 CALL LEAD — user tapped Call / WhatsApp on a phone turf
  // POST /call-lead
  // Body: { turfId, channel: "call" | "whatsapp" }
  // Auth: Firebase token of the user
  // Logs the lead (no customer name/number) + pushes owner & operator
  // (max 1 push per user+turf every 10 minutes)
  // =======================================================
  const callLeadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
  });

  app.post("/call-lead", callLeadLimiter, async (req, res) => {
    try {
      const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(token); }
      catch { return res.status(401).json({ success: false, error: "Invalid or expired token" }); }
      const uid = decoded.uid;

      const turfId  = String(req.body.turfId || "").trim();
      const channel = req.body.channel === "whatsapp" ? "whatsapp" : "call";
      if (!turfId) return res.status(400).json({ success: false, error: "turfId is required" });

      const turfSnap = await db.collection("turfs").doc(turfId).get();
      if (!turfSnap.exists) return res.status(404).json({ success: false, error: "Turf not found" });
      const turf = turfSnap.data();
      if ((turf.bookingMode || "online") === "online") {
        return res.status(400).json({ success: false, error: "This turf does not take phone bookings" });
      }

      // 1) Always log the lead — owners only ever see COUNTS, never who called.
      //    userId is kept for admin use only.
      await db.collection("callLeads").add({
        turfId,
        turfName:   turf.name || "",
        ownerId:    turf.ownerId || "",
        operatorId: turf.operatorId || "",
        userId:     uid,
        channel,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2) Push owner + operator — throttled so repeated taps don't spam them
      const throttleRef  = db.collection("callLeadThrottle").doc(`${uid}_${turfId}`);
      const throttleSnap = await throttleRef.get();
      const lastAt       = throttleSnap.exists ? throttleSnap.data().lastAt?.toMillis?.() || 0 : 0;

      if (Date.now() - lastAt > 10 * 60 * 1000) {
        await throttleRef.set({ lastAt: admin.firestore.FieldValue.serverTimestamp() });

        const title = "📞 New customer from PlayOn";
        const body  = channel === "call"
          ? `A PlayOn customer is calling you about ${turf.name}.`
          : `A PlayOn customer is messaging you on WhatsApp about ${turf.name}.`;
        const data  = { type: "call_lead", turfId };

        await Promise.all([
          sendPushToUser(turf.ownerId, title, body, data),
          turf.operatorId ? sendPushToUser(turf.operatorId, title, body, data) : null,
        ]);
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("callLead error: - server.js:2611", err);
      return res.status(500).json({ success: false, error: err.message });
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
      console.error("creategymorder error: - server.js:2687", err);
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
        } catch (e) { console.warn("gym promo usage failed: - server.js:2763", e.message); }
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
      console.error("verifygympayment error: - server.js:2779", err);
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
      console.error("createleague error: - server.js:2828", e);
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // /add-team  — league owner adds a team with optional player UID linking
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/add-team", requireLeagueOwnerOrAdmin, async (req, res) => {
    try {
      const { leagueId, name, captainName, players, iconName, iconColor } = req.body;

      if (!leagueId) return res.status(400).json({ error: "leagueId required" });
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Team name required" });

      // ── Optional team badge (icon + color) — whitelisted so a bad client
      //    can never break rendering.
      const ALLOWED_TEAM_ICONS = [
        "shield", "shield-half", "flame", "flash", "paw", "skull", "rocket",
        "star", "diamond", "planet", "thunderstorm", "trophy", "ribbon",
        "aperture", "compass", "prism",
      ];
      const cleanIconName = ALLOWED_TEAM_ICONS.includes(String(iconName || ""))
        ? String(iconName)
        : null;
      const cleanIconColor = /^#[0-9A-Fa-f]{6}$/.test(String(iconColor || ""))
        ? String(iconColor)
        : null;

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
        iconName:    cleanIconName,
        iconColor:   cleanIconName ? cleanIconColor : null,
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
      console.error("addteam error: - server.js:2911", err);
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
      console.error("addmatch error: - server.js:2956", e);
      res.status(400).json({ success: false, error: e.message });
    }
  });


  app.post("/create-quick-match", leagueHostLimiter, requireLeagueOwnerOrAdmin, async (req, res) => {
    try {
      const { teamAName, teamBName, sport, date, startTime, endTime, venue,
              teamAIconName, teamAIconColor, teamBIconName, teamBIconColor } = req.body;
 
      const nameA = String(teamAName || "").trim();
      const nameB = String(teamBName || "").trim();
      const sp    = String(sport || "").trim();
 
      if (!nameA || !nameB) return res.status(400).json({ success: false, error: "Both team names are required." });
      if (nameA.length > 40 || nameB.length > 40) return res.status(400).json({ success: false, error: "Team names must be 40 characters or fewer." });
      if (nameA.toLowerCase() === nameB.toLowerCase()) return res.status(400).json({ success: false, error: "A team cannot play itself." });
      if (!sp) return res.status(400).json({ success: false, error: "Sport is required." });
      if (!date || !String(date).trim()) return res.status(400).json({ success: false, error: "Match date is required." });
 
      // ── Sanitize badges (same whitelist as /add-team) ──────────────────────
      const ALLOWED_TEAM_ICONS = [
        "shield", "shield-half", "flame", "flash", "paw", "skull", "rocket",
        "star", "diamond", "planet", "thunderstorm", "trophy", "ribbon",
        "aperture", "compass", "prism",
      ];
      const cleanIcon  = (n) => (ALLOWED_TEAM_ICONS.includes(String(n || "")) ? String(n) : null);
      const cleanColor = (c) => (/^#[0-9A-Fa-f]{6}$/.test(String(c || "")) ? String(c) : null);
 
      const iconA = cleanIcon(teamAIconName);
      const iconB = cleanIcon(teamBIconName);
 
      const ref = db.collection("leagueMatches").doc();
      await ref.set({
        // ── Quick-match identity ──────────────────────────
        leagueId:   null,
        type:       "quick_match",
        leagueName: "Quick Match",   // existing match cards render this label as-is
 
        // ── Inline teams (no leagueTeams docs) ────────────
        teamAId: null, teamAName: nameA,
        teamBId: null, teamBName: nameB,
        teamAIconName: iconA, teamAIconColor: iconA ? cleanColor(teamAIconColor) : null,
        teamBIconName: iconB, teamBIconColor: iconB ? cleanColor(teamBIconColor) : null,
 
        // ── Schedule ──────────────────────────────────────
        sport:     sp,
        date:      String(date).trim(),
        startTime: startTime ? String(startTime).trim() : "",
        endTime:   endTime   ? String(endTime).trim()   : "",
        venue:     venue     ? String(venue).trim()     : "",
 
        // ── State ─────────────────────────────────────────
        status: "scheduled", scoreA: 0, scoreB: 0, winnerId: null,
        liveSummary: "",
        organizerId:   req.callerUid,
        organizerName: req.callerName || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
 
      return res.json({ success: true, matchId: ref.id });
    } catch (e) {
      console.error("createquickmatch error: - server.js:3019", e);
      return res.status(400).json({ success: false, error: e.message });
    }
  });

  // =======================================================
  // 📊 UPDATE MATCH SCORE + AUTO PLAYER STATS ENGINE
  // When status = "completed": writes wins/losses/draws to
  // every playerProfiles/{uid} for players in both teams.
  // Players without a uid (unregistered walk-ins) are skipped.
  // =======================================================
  app.post("/update-match-score", scoringLimiter, requireLeagueOwnerOrAdmin, async (req, res) => {
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
          ? (sA > sB ? (match.teamAId || "teamA") : sA < sB ? (match.teamBId || "teamB") : null)
          : match.winnerId || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ── Stats engine: only runs on completion ─────────────────────────────
      if (newStatus === "completed" && match.status !== "completed" && match.teamAId && match.teamBId) {
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
                  console.log(`Stats updated: uid=${player.uid} result=${result} - server.js:3089`);
                } catch (e) {
                  console.error(`Stats update failed for uid=${player.uid}: - server.js:3091`, e.message);
                }
              })
          );
        };

        await Promise.all([
          updateTeamPlayers(teamASnap, resultA),
          updateTeamPlayers(teamBSnap, resultB),
        ]);

        console.log(`Match ${matchId} completed. Stats engine done. A:${sA} B:${sB} - server.js:3102`);
      }

      res.json({ success: true });
    } catch (e) {
      console.error("updatematchscore error: - server.js:3107", e);
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
      console.error("createplayerprofileorder error: - server.js:3201", err);
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
          console.log(`Autorefund issued for profile order ${order_id}  ID taken - server.js:3295`);
        } catch (refundErr) {
          console.error("Profile order refund failed: - server.js:3297", refundErr.message);
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
      console.error("verifyplayerprofilepayment error: - server.js:3343", err);
      return res.status(500).json({ success: false, error: err.message || "Verification failed." });
    }
  });

  // =======================================================
  // ⏰ DAY-BEFORE REMINDERS (cron)


  // =======================================================
  // 🤖 AI COACH — system prompt builder
  // =======================================================
  function buildCoachSystemPrompt(profile, topic) {
    const bits = [];
    if (Array.isArray(profile?.sports) && profile.sports.length) {
      bits.push(`They play: ${profile.sports.join(", ")}.`);
    }
    if (profile?.playerRole)   bits.push(`Playing role: ${profile.playerRole}.`);
    if (profile?.battingHand)  bits.push(`Bats ${profile.battingHand}-handed.`);
    if (profile?.bowlingStyle) bits.push(`Bowling style: ${profile.bowlingStyle}.`);

    const stats = profile?.stats || {};
    if (Number(stats.matches) > 0) {
      const parts = [`${stats.matches} matches`, `${stats.wins || 0}W-${stats.losses || 0}L-${stats.draws || 0}D`];
      if (stats.runs)    parts.push(`${stats.runs} runs`);
      if (stats.wickets) parts.push(`${stats.wickets} wickets`);
      if (stats.goals)   parts.push(`${stats.goals} goals`);
      if (stats.assists) parts.push(`${stats.assists} assists`);
      bits.push(`Career so far: ${parts.join(", ")}.`);
    }

    const profileLine = bits.length
      ? bits.join(" ")
      : "No player profile on file yet — keep advice general unless they mention specifics themselves.";

    const topicLine = topic && topic !== "general"
      ? `The player currently has the "${topic}" tab open in the coach — lean toward that topic unless they clearly ask about something else.`
      : "";

    return `You are the PlayOn AI Coach — a friendly, practical sports and fitness coach built into the PlayOn app.

You help with:
- Cricket technique: batting, pace and spin bowling, fielding, match strategy
- Football technique and tactics
- Gym training: workout plans, exercise form, progressive overload
- Sports nutrition: general meal and hydration guidance for athletes

Player context: ${profileLine}
${topicLine}

How to answer:
- Be encouraging, clear, and practical — give concrete steps or drills, not vague motivation.
- Personalize using the player context above when it's relevant; don't force it into unrelated questions.
- For nutrition: give general, educational guidance (meal timing, food ideas, hydration, balanced macros in plain terms). Do not give precise calorie-restriction numbers or clinical/medical nutrition prescriptions. For medical conditions, injuries, or extreme goals, tell them to see a doctor or registered dietitian.
- For pain or injuries: give basic safety guidance (rest, ice, see a physio/doctor) rather than diagnosing anything.
- Keep answers mobile-friendly: short paragraphs, and use plain "•" bullets for lists — no markdown headers, bold text, or tables, since this renders as plain text in the app.
- If asked something unrelated to sports, fitness, or nutrition, gently steer back to what you can help with.
- Keep tone appropriate for a general audience that includes teenagers.`;
  }

  // =======================================================
  // 🤖 AI COACH — Anthropic API call
  // =======================================================
 async function callCoachLLM(systemPrompt, messages) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Coach is not configured yet — missing GEMINI_API_KEY.");
  }

  // Gemini uses "model" for assistant turns, not "assistant"
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const model = process.env.COACH_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 700 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Coach API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text?.trim() || "Sorry, I couldn't come up with an answer that time — try asking again.";
}

  // =======================================================
  // 🤖 AI COACH — send a message, get a reply
  // =======================================================
  app.post("/coach-chat", coachLimiter, requireAuth, async (req, res) => {
    try {
      const { message, topic } = req.body;
      const trimmed = String(message || "").trim();
      if (!trimmed) return res.status(400).json({ success: false, error: "Message is required." });
      if (trimmed.length > 2000) return res.status(400).json({ success: false, error: "Message is too long (max 2000 characters)." });

      const uid = req.callerUid;

      let profile = null;
      try {
        const profSnap = await db.collection("playerProfiles").doc(uid).get();
        if (profSnap.exists) profile = profSnap.data();
      } catch (e) {
        console.warn("coach profile lookup failed (nonfatal): - server.js:3457", e.message);
      }

      const historySnap = await db.collection("coachConversations").doc(uid)
        .collection("messages").orderBy("createdAt", "desc").limit(20).get();
      const history = historySnap.docs.map((d) => d.data()).reverse();

      const llmMessages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: trimmed },
      ];

      const systemPrompt = buildCoachSystemPrompt(profile, topic);
      const replyText = await callCoachLLM(systemPrompt, llmMessages);

      const convoRef = db.collection("coachConversations").doc(uid);
      const batch = db.batch();
      batch.set(convoRef, { lastMessageAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      const userMsgRef = convoRef.collection("messages").doc();
      batch.set(userMsgRef, {
        role: "user", content: trimmed, topic: topic || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const aiMsgRef = convoRef.collection("messages").doc();
      batch.set(aiMsgRef, {
        role: "assistant", content: replyText, topic: topic || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();

      return res.json({ success: true, reply: replyText });
    } catch (err) {
      console.error("coachchat error: - server.js:3489", err.message);
      return res.status(500).json({ success: false, error: "The coach is unavailable right now. Please try again in a moment." });
    }
  });

  // =======================================================
  // 🤖 AI COACH — load conversation history (screen open)
  // =======================================================
  app.get("/coach-history", requireAuth, async (req, res) => {
    try {
      const uid = req.callerUid;
      const snap = await db.collection("coachConversations").doc(uid)
        .collection("messages").orderBy("createdAt", "asc").limit(200).get();
      const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, messages });
    } catch (err) {
      console.error("coachhistory error: - server.js:3505", err.message);
      return res.status(500).json({ success: false, error: "Could not load conversation history." });
    }
  });

  // =======================================================
  // 🤖 AI COACH — clear conversation ("New conversation" button)
  // =======================================================
  app.post("/coach-clear", requireAuth, async (req, res) => {
    try {
      const uid = req.callerUid;
      const snap = await db.collection("coachConversations").doc(uid).collection("messages").get();
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return res.json({ success: true });
    } catch (err) {
      console.error("coachclear error: - server.js:3522", err.message);
      return res.status(500).json({ success: false, error: "Could not clear the conversation." });
    }
  });
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
      console.error("sendreminders error: - server.js:3559", e);
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
      console.error("sendadminnotification error: - server.js:3601", e);
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
  // =======================================================
  // 🪙 ADMIN — SET PCOIN RATE CONFIG
  // POST /admin/pcoin-config
  // Body: { ratePer1000, enabled }
  // Auth: Firebase token with role=admin
  // =======================================================
  app.post("/admin/pcoin-config", adminActionLimiter, async (req, res) => {
    try {
      const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });

      const decoded = await admin.auth().verifyIdToken(token);
      const userDoc = await db.collection("users").doc(decoded.uid).get();
      if (!userDoc.exists || userDoc.data().role !== "admin") {
        return res.status(403).json({ success: false, error: "Admin only" });
      }

      const { ratePerHour, enabled } = req.body;
  const rate = Number(ratePerHour);
  if (isNaN(rate) || rate < 0) {
    return res.status(400).json({ success: false, error: "ratePerHour must be a number >= 0" });
  }

  await db.collection("settings").doc("pcoinConfig").set({
    ratePerHour: rate,
        enabled:     enabled !== false, // default true
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
        updatedBy:   decoded.uid,
      }, { merge: true });

      return res.json({
        success: true,
        message: `PCoin rate set to ${rate} coins per ₹1000. Enabled: ${enabled !== false}`,
      });
    } catch (err) {
      console.error("pcoinconfig error: - server.js:3654", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // =======================================================
  // 🪙 PUBLIC — GET PCOIN CONFIG
  // GET /pcoin-config — frontend fetches current rate
  // =======================================================
  app.get("/pcoin-config", async (req, res) => {
    try {
      const snap = await db.collection("settings").doc("pcoinConfig").get();
      if (!snap.exists) {
        return res.json({ success: true, ratePerHour: 0, enabled: false });
      }
      const d = snap.data();
      return res.json({ success: true, ratePerHour: d.ratePerHour || 0, enabled: d.enabled !== false });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

   // =======================================================
  app.get("/referral-config", async (req, res) => {
    try {
      const snap = await db.collection("settings").doc("referralConfig").get();
      if (!snap.exists) {
        return res.json({ success: true, rewardCoins: 50, enabled: true });
      }
      const d = snap.data();
      return res.json({
        success:     true,
        rewardCoins: Number(d.rewardCoins ?? 50),
        enabled:     d.enabled !== false,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
 
  // =======================================================
  // 🤝 ADMIN — SET REFERRAL CONFIG
  // POST /admin/referral-config
  // Body: { rewardCoins, enabled }
  // Auth: Firebase token with role=admin
  // =======================================================
  app.post("/admin/referral-config", adminActionLimiter, async (req, res) => {
    try {
      const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });
 
      const decoded = await admin.auth().verifyIdToken(token);
      const userDoc = await db.collection("users").doc(decoded.uid).get();
      if (!userDoc.exists || userDoc.data().role !== "admin") {
        return res.status(403).json({ success: false, error: "Admin only" });
      }
 
      const { rewardCoins, enabled } = req.body;
      const coins = Number(rewardCoins);
      if (isNaN(coins) || coins < 0) {
        return res.status(400).json({ success: false, error: "rewardCoins must be a number >= 0" });
      }
 
      await db.collection("settings").doc("referralConfig").set({
        rewardCoins: coins,
        enabled:     enabled !== false,
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
        updatedBy:   decoded.uid,
      }, { merge: true });
 
      return res.json({
        success: true,
        message: `Referral reward set to ${coins} PCoins. Enabled: ${enabled !== false}`,
      });
    } catch (err) {
      console.error("referralconfig error: - server.js:3729", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });
 
  // =======================================================
  // 🤝 APPLY REFERRAL CODE — called right after signup
  // POST /apply-referral-code
  // Body: { code }
  // Auth: Firebase token of the NEW user
  // Validates: code exists, not self-referral, account is
  // new (no bookings), not already referred
  // =======================================================
  app.post("/apply-referral-code", promoLimiter, async (req, res) => {
    try {
      const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });
 
      const decoded = await admin.auth().verifyIdToken(token);
      const uid     = decoded.uid;
 
      const code = String(req.body.code || "").trim().toUpperCase();
      if (!code) return res.status(400).json({ success: false, error: "Referral code is required." });
 
      // Program must be enabled
      const cfgSnap = await db.collection("settings").doc("referralConfig").get();
      if (cfgSnap.exists && cfgSnap.data().enabled === false) {
        return res.status(400).json({ success: false, error: "Referral program is currently paused." });
      }
 
      // Find the referrer by their code
      const refUserSnap = await db.collection("users")
        .where("referralCode", "==", code)
        .limit(1)
        .get();
      if (refUserSnap.empty) {
        return res.status(404).json({ success: false, error: "Invalid referral code." });
      }
      const referrerDoc = refUserSnap.docs[0];
      const referrerUid = referrerDoc.id;
 
      // No self-referral
      if (referrerUid === uid) {
        return res.status(400).json({ success: false, error: "You can't use your own referral code." });
      }
 
      // Only new accounts (no bookings yet)
      const bookingSnap = await db.collection("bookings")
        .where("userId", "==", uid)
        .limit(1)
        .get();
      if (!bookingSnap.empty) {
        return res.status(400).json({ success: false, error: "Referral codes can only be used on new accounts." });
      }
 
      // Only one referral per user
      const existingRef = await db.collection("referrals")
        .where("referredUid", "==", uid)
        .limit(1)
        .get();
      const userSnap = await db.collection("users").doc(uid).get();
      if (!existingRef.empty || (userSnap.exists && userSnap.data().referredBy)) {
        return res.status(400).json({ success: false, error: "A referral code has already been applied to this account." });
      }
 
      const referredName = userSnap.exists ? (userSnap.data().name || "") : "";
 
      // Save link on user + create the pending referral record
      await db.collection("users").doc(uid).set({
        referredBy:     referrerUid,
        referredByCode: code,
      }, { merge: true });
 
      await db.collection("referrals").add({
        referrerUid,
        referredUid:  uid,
        referredName,
        code,
        status:       "pending", // → completed after friend's 1st booking finishes
        rewardCoins:  0,         // locked in at credit time from admin config
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
 
      // Tell the referrer their code was used
      sendPushToUser(referrerUid, "🤝 Someone used your code!",
        `${referredName || "A friend"} joined PlayOn with your referral code. You'll earn PCoins after their first booking!`,
        { screen: "refer-and-earn" }
      );
 
      return res.json({ success: true, message: "Referral code applied! Reward unlocks after your first booking." });
    } catch (err) {
      console.error("applyreferralcode error: - server.js:3820", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  

  // =======================================================
  // 🪙 OWNER — SET VCOIN RATE FOR A TURF
  // POST /owner/vcoin-config/:turfId
  // Body: { vcoinEnabled, vcoinRate }
  // Auth: Firebase token — must be the turf's owner
  // =======================================================
  app.post("/owner/vcoin-config/:turfId", async (req, res) => {
    try {
      const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
      if (!token) return res.status(401).json({ success: false, error: "Missing token" });

      const decoded = await admin.auth().verifyIdToken(token);
      const { turfId } = req.params;
      const { vcoinEnabled, vcoinRate } = req.body;

      const turfDoc = await db.collection("turfs").doc(turfId).get();
      if (!turfDoc.exists) return res.status(404).json({ success: false, error: "Turf not found" });

      const userDoc = await db.collection("users").doc(decoded.uid).get();
      const role = userDoc.exists ? userDoc.data().role : "";

      // Only the turf's owner or admin can update
      if (role !== "admin" && turfDoc.data().ownerId !== decoded.uid) {
        return res.status(403).json({ success: false, error: "You don't own this turf" });
      }

      const rate = Number(vcoinRate || 0);
      if (isNaN(rate) || rate < 0) {
        return res.status(400).json({ success: false, error: "vcoinRate must be >= 0" });
      }

      await db.collection("turfs").doc(turfId).update({
        vcoinEnabled:      vcoinEnabled === true,
        vcoinRatePerHour:  rate,
        vcoinRate:         rate,   // backward compat
        vcoinUpdatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        message: `VCoin ${vcoinEnabled ? "enabled" : "disabled"} at ${rate} coins/booking for turf ${turfId}`,
      });
    } catch (err) {
      console.error("vcoinconfig error: - server.js:3870", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // =======================================================
  // 🪙 CRON — CREDIT COMPLETED COINS
  // POST /credit-completed-coins
  // Called by cron job (daily) — moves pendingBalance to balance
  // for all bookings whose slot time has passed
  // Auth: CRON_SECRET header
  // =======================================================
  app.post("/credit-completed-coins", async (req, res) => {
    if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    try {
      const now = new Date();

      // Fetch all confirmed bookings with pending coins
      const snap = await db.collection("bookings")
        .where("coinStatus", "==", "pending")
        .where("status", "==", "confirmed")
        .get();

      let credited = 0;
      let skipped  = 0;

      await Promise.allSettled(snap.docs.map(async (docSnap) => {
        const booking   = docSnap.data();
        const bookingId = docSnap.id;

        // Parse booking date + last slot end time
        try {
          const bookingDate = booking.date?.toDate
            ? booking.date.toDate()
            : new Date(booking.dateString);

          const slots = booking.selectedSlots || [];
          if (slots.length === 0) return;

          // Get end time of last slot
          const lastSlot     = slots[slots.length - 1];
          const lastPart     = String(lastSlot).split(" - ")[1]?.trim() || "";
          const match        = lastPart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
          if (!match) return;

          let endH = parseInt(match[1]);
          const endM   = parseInt(match[2] || "0");
          const period = match[3].toUpperCase();
          if (period === "PM" && endH !== 12) endH += 12;
          if (period === "AM" && endH === 12) endH = 0;

          const slotEndTime = new Date(bookingDate);
          slotEndTime.setHours(endH, endM, 0, 0);

          // Only credit if slot has already ended
          if (slotEndTime > now) { skipped++; return; }

          const pcoinPending = Number(booking.pcoinPending || 0);
          const vcoinPending = Number(booking.vcoinPending || 0);
          const uid          = booking.userId;
          if (!uid) return;

          // ── Credit PCoin ─────────────────────────────────────────────────
          if (pcoinPending > 0) {
            const pcWalletRef = db.collection("pcoinWallets").doc(uid);
            await db.runTransaction(async (txn) => {
              const wSnap = await txn.get(pcWalletRef);
              if (wSnap.exists) {
                const curr    = wSnap.data();
                const pending = Math.max(Number(curr.pendingBalance || 0) - pcoinPending, 0);
                txn.update(pcWalletRef, {
                  balance:        admin.firestore.FieldValue.increment(pcoinPending),
                  pendingBalance: pending,
                  totalEarned:    admin.firestore.FieldValue.increment(pcoinPending),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              } else {
                txn.set(pcWalletRef, {
                  uid,
                  balance:        pcoinPending,
                  pendingBalance: 0,
                  totalEarned:    pcoinPending,
                  totalRedeemed:  0,
                  createdAt:      admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });
            await db.collection("pcoinLedger").add({
              uid, type: "pcoin_earn", coins: pcoinPending,
              bookingId, turfId: booking.turfId, turfName: booking.turfName || "",
              note: "Credited after slot completed",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // ── Credit VCoin ─────────────────────────────────────────────────
          if (vcoinPending > 0 && booking.turfId) {
            const vcKey     = `${uid}_${booking.turfId}`;
            const vcWalRef  = db.collection("vcoinWallets").doc(vcKey);
            await db.runTransaction(async (txn) => {
              const wSnap = await txn.get(vcWalRef);
              if (wSnap.exists) {
                const curr    = wSnap.data();
                const pending = Math.max(Number(curr.pendingBalance || 0) - vcoinPending, 0);
                txn.update(vcWalRef, {
                  balance:        admin.firestore.FieldValue.increment(vcoinPending),
                  pendingBalance: pending,
                  totalEarned:    admin.firestore.FieldValue.increment(vcoinPending),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              } else {
                txn.set(vcWalRef, {
                  uid, turfId: booking.turfId, turfName: booking.turfName || "",
                  balance:        vcoinPending,
                  pendingBalance: 0,
                  totalEarned:    vcoinPending,
                  totalRedeemed:  0,
                  createdAt:      admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });
            await db.collection("vcoinLedger").add({
              uid, type: "vcoin_earn", coins: vcoinPending,
              bookingId, turfId: booking.turfId, turfName: booking.turfName || "",
              note: "Credited after slot completed",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // ── Mark booking as credited ──────────────────────────────────────
          await docSnap.ref.update({
            pcoinEarned:  pcoinPending,
            vcoinEarned:  vcoinPending,
            pcoinPending: 0,
            vcoinPending: 0,
            coinStatus:   "credited",
            coinCreditedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // ── Push notification to user ─────────────────────────────────────
          if (pcoinPending > 0 || vcoinPending > 0) {
            const parts = [];
            if (pcoinPending > 0) parts.push(`${pcoinPending} PCoin`);
            if (vcoinPending > 0) parts.push(`${vcoinPending} VCoin`);
            sendPushToUser(uid, "🪙 Coins Credited!",
              `${parts.join(" + ")} added to your wallet from your ${booking.turfName} booking.`,
              { screen: "wallet" }
            );
          }

             try {
            const refSnap = await db.collection("referrals")
              .where("referredUid", "==", uid)
              .where("status", "==", "pending")
              .limit(1)
              .get();
 
            if (!refSnap.empty) {
              const refDoc      = refSnap.docs[0];
              const refData     = refDoc.data();
              const referrerUid = refData.referrerUid;
 
              // Reward amount comes from admin config AT CREDIT TIME
              const refCfgSnap  = await db.collection("settings").doc("referralConfig").get();
              const refCfg      = refCfgSnap.exists ? refCfgSnap.data() : {};
              const refEnabled  = refCfg.enabled !== false;
              const rewardCoins = Number(refCfg.rewardCoins ?? 50);
 
              // If paused or 0, leave the referral pending — it can still
              // complete on a later booking once the admin re-enables it
              if (referrerUid && refEnabled && rewardCoins > 0) {
                // Credit referrer's PCoin wallet directly (booking already done)
                const refWalletRef = db.collection("pcoinWallets").doc(referrerUid);
                await db.runTransaction(async (txn) => {
                  const wSnap = await txn.get(refWalletRef);
                  if (wSnap.exists) {
                    txn.update(refWalletRef, {
                      balance:     admin.firestore.FieldValue.increment(rewardCoins),
                      totalEarned: admin.firestore.FieldValue.increment(rewardCoins),
                      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
                    });
                  } else {
                    txn.set(refWalletRef, {
                      uid:            referrerUid,
                      balance:        rewardCoins,
                      pendingBalance: 0,
                      totalEarned:    rewardCoins,
                      totalRedeemed:  0,
                      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
                      updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
                    });
                  }
                });
 
                // Ledger entry for referrer
                await db.collection("pcoinLedger").add({
                  uid:          referrerUid,
                  type:         "pcoin_referral",
                  coins:        rewardCoins,
                  bookingId,
                  referredUid:  uid,
                  referredName: refData.referredName || "",
                  note:         `Referral reward — ${refData.referredName || "your friend"} completed their first booking`,
                  createdAt:    admin.firestore.FieldValue.serverTimestamp(),
                });
 
                // Close out the referral
                await refDoc.ref.update({
                  status:         "completed",
                  rewardCoins,
                  firstBookingId: bookingId,
                  completedAt:    admin.firestore.FieldValue.serverTimestamp(),
                });
 
                // Celebrate 🎉
                sendPushToUser(referrerUid, "🎉 Referral Reward!",
                  `${refData.referredName || "Your friend"} completed their first booking — ${rewardCoins} PCoins added to your wallet!`,
                  { screen: "wallet" }
                );
 
                console.log(`🤝 Referral reward: ${rewardCoins} PCoins → ${referrerUid} (friend=${uid}, booking=${bookingId}) - server.js:4095`);
              }
            }
          } catch (refErr) {
            // Referral errors must NEVER block coin crediting
            console.warn(`Referral reward failed (nonfatal) for booking ${bookingId}: - server.js:4100`, refErr.message);
          }

          credited++;
          console.log(`🪙 Coins credited: bookingId=${bookingId} pcoin=${pcoinPending} vcoin=${vcoinPending} - server.js:4104`);
        } catch (e) {
          console.warn(`Coin credit failed for booking ${docSnap.id}: - server.js:4106`, e.message);
        }
      }));

      return res.json({
        success: true,
        message: `Coin credit run complete. Credited: ${credited}, Skipped (future slots): ${skipped}`,
        credited, skipped,
      });
    } catch (err) {
      console.error("creditcompletedcoins error: - server.js:4116", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });


  // =======================================================
  // 🎯 BALL MACHINE — new parallel booking system (added)
  // =======================================================
// =============================================================================
// 🎯 BALL MACHINE — SCHEMA NOTES
// =============================================================================
// Turf doc gets these NEW fields (owner sets them in the add/edit turf screen):
//   ballMachineEnabled       : boolean        — turns the feature on for this venue
//   ballMachineCount         : number         — how many machines/bays run in parallel
//   ballMachineOpeningTime   : number (hour)  — falls back to turf.openingTime, then 6
//   ballMachineClosingTime   : number (hour)  — falls back to turf.closingTime, then 23
//   ballMachinePackages      : [{ id, label, overs, durationMinutes, price }]
//        e.g. { id:"p1", label:"6 Overs", overs:6,  durationMinutes:15, price:150 }
//             { id:"p2", label:"12 Overs", overs:12, durationMinutes:30, price:300 }
//   (VCoin reuses the turf's EXISTING vcoinEnabled / vcoinRatePerHour fields —
//    no separate config needed, one venue = one VCoin rate)
//
// NEW Firestore collections (parallel to bookings/orders/blockedSlots/slotLocks —
// deliberately NOT reusing those, so ball machine bugs can never touch turf-slot
// money math):
//   ballMachineOrders    — created at checkout, same lifecycle as `orders`
//   ballMachineBookings  — confirmed sessions, same lifecycle as `bookings`
//   ballMachineBlocks    — owner-blocked machine time (mirrors `blockedSlots`)
//   ballMachineLocks     — short-lived holds while a user is checking out
//                          (mirrors `slotLocks`; write these client-side the
//                          same way you already do for slotLocks)
//
// Time is stored as MINUTES-FROM-MIDNIGHT ("startUnit"), on a fixed 15-minute
// grid, rather than slot strings — because package duration varies (15 min,
// 30 min, ...) instead of your turf's fixed 30-min slot. `machineIndex`
// (1..ballMachineCount) records which bay a booking landed on so multiple
// machines can run truly in parallel.
// =============================================================================

const BALL_MACHINE_UNIT_MINUTES = 15;

function getBallMachineWindow(turf) {
  const openHour  = Number(turf.ballMachineOpeningTime ?? turf.openingTime ?? 6);
  const closeHour = Number(turf.ballMachineClosingTime ?? turf.closingTime ?? 23);
  return { startMin: openHour * 60, endMin: closeHour * 60 };
}

function findBallMachinePackage(turf, packageId) {
  const packages = Array.isArray(turf.ballMachinePackages) ? turf.ballMachinePackages : [];
  return packages.find((p) => p.id === packageId) || null;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Builds a flat list of { machineIndex, start, end } from confirmed bookings +
// owner blocks + active locks for one turf/date, so availability checks only
// need one pass. `machineIndex: "all"` (used by blocks) conflicts with every bay.
async function getBallMachineOccupiedRanges(turfId, dateString, excludeUserId, excludeBookingId) {
  const [bookingSnap, blockSnap, lockSnap] = await Promise.all([
    db.collection("ballMachineBookings")
      .where("turfId", "==", turfId).where("dateString", "==", dateString).get(),
    db.collection("ballMachineBlocks")
      .where("turfId", "==", turfId).where("dateString", "==", dateString).get(),
    db.collection("ballMachineLocks")
      .where("turfId", "==", turfId).where("dateString", "==", dateString).get(),
  ]);

  const now = new Date();
  const ranges = [];

  bookingSnap.docs.forEach((d) => {
    if (d.id === excludeBookingId) return;
    const b = d.data();
    if (b.status === "cancelled") return;
    ranges.push({ machineIndex: b.machineIndex, start: b.startUnit, end: b.startUnit + b.durationMinutes });
  });

  blockSnap.docs.forEach((d) => {
    const b = d.data();
    ranges.push({
      machineIndex: b.machineIndex || "all",
      start: b.startUnit,
      end: b.startUnit + (b.durationMinutes || BALL_MACHINE_UNIT_MINUTES),
    });
  });

  lockSnap.docs.forEach((d) => {
    const l = d.data();
    if (l.userId === excludeUserId) return;
    const expiry = l.expiresAt?.toDate?.() || new Date(l.expiresAt);
    if (expiry <= now) return;
    ranges.push({
      machineIndex: l.machineIndex || "all",
      start: l.startUnit,
      end: l.startUnit + (l.durationMinutes || BALL_MACHINE_UNIT_MINUTES),
    });
  });

  return ranges;
}

// Returns the first free machine number (1-indexed) for [start, end), or null.
function findFreeMachine(occupiedRanges, machineCount, start, end) {
  for (let m = 1; m <= machineCount; m++) {
    const conflict = occupiedRanges.some((r) => {
      if (r.machineIndex !== "all" && Number(r.machineIndex) !== m) return false;
      return rangesOverlap(start, end, r.start, r.end);
    });
    if (!conflict) return m;
  }
  return null;
}

// =============================================================================
// 📅 GET AVAILABILITY — powers the customer's time picker for a chosen package
// =============================================================================
app.get("/ballmachine-availability", async (req, res) => {
  try {
    const { turfId, dateString, packageId } = req.query;
    if (!turfId || !dateString || !packageId) {
      return res.status(400).json({ success: false, error: "turfId, dateString and packageId are required" });
    }

    const turfDoc = await db.collection("turfs").doc(String(turfId)).get();
    if (!turfDoc.exists) return res.status(404).json({ success: false, error: "Turf not found" });
    const turf = turfDoc.data();
    if (turf.ballMachineEnabled !== true) {
      return res.status(400).json({ success: false, error: "Ball Machine is not available at this venue" });
    }

    const pkg = findBallMachinePackage(turf, String(packageId));
    if (!pkg) return res.status(400).json({ success: false, error: "Invalid package selected" });

    const durationMinutes = Number(pkg.durationMinutes);
    const machineCount    = Math.max(1, Number(turf.ballMachineCount || 1));
    const { startMin, endMin } = getBallMachineWindow(turf);

    const occupied = await getBallMachineOccupiedRanges(String(turfId), String(dateString), null, null);

    const available = [];
    for (let t = startMin; t + durationMinutes <= endMin; t += BALL_MACHINE_UNIT_MINUTES) {
      if (findFreeMachine(occupied, machineCount, t, t + durationMinutes)) {
        available.push({ startUnit: t, startTime: formatMinutes(t), endTime: formatMinutes(t + durationMinutes) });
      }
    }

    return res.json({ success: true, package: pkg, durationMinutes, machineCount, available });
  } catch (err) {
    console.error("ballmachineavailability error: - server.js:4267", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to load availability" });
  }
});

// =============================================================================
// ✅ CREATE BALL MACHINE ORDER
// =============================================================================
app.post("/create-ballmachine-order", orderLimiter, async (req, res) => {
  try {
    const { turfId, dateString, packageId, startUnit, userId } = req.body;
    if (!turfId || !dateString || !packageId || startUnit === undefined || startUnit === null) {
      return res.status(400).json({ error: "turfId, dateString, packageId and startUnit are required" });
    }

    const turfDoc = await db.collection("turfs").doc(turfId).get();
    if (!turfDoc.exists) return res.status(404).json({ error: "Turf not found" });
    const turf = turfDoc.data();
    if (turf.ballMachineEnabled !== true) {
      return res.status(400).json({ error: "Ball Machine is not available at this venue" });
    }

    const pkg = findBallMachinePackage(turf, packageId);
    if (!pkg) return res.status(400).json({ error: "Invalid package selected" });

    const durationMinutes = Number(pkg.durationMinutes);
    const price           = Number(pkg.price);
    if (!durationMinutes || durationMinutes <= 0 || !price || price <= 0) {
      return res.status(400).json({ error: "This package is misconfigured. Please contact the venue." });
    }

    const start = Number(startUnit);
    if (isNaN(start) || start % BALL_MACHINE_UNIT_MINUTES !== 0) {
      return res.status(400).json({ error: "Invalid start time" });
    }
    const end = start + durationMinutes;
    const { startMin, endMin } = getBallMachineWindow(turf);
    if (start < startMin || end > endMin) {
      return res.status(400).json({ error: "Selected time is outside operating hours" });
    }

    const machineCount = Math.max(1, Number(turf.ballMachineCount || 1));
    const occupied      = await getBallMachineOccupiedRanges(turfId, dateString, userId, null);
    const freeMachine    = findFreeMachine(occupied, machineCount, start, end);
    if (!freeMachine) {
      return res.status(409).json({
        success: false, slotConflict: true,
        error: "This time is no longer available. Please pick another slot.",
      });
    }

    const order = await razorpay.orders.create({
      amount: price * 100, currency: "INR", receipt: "bm_" + Date.now(),
    });

    await db.collection("ballMachineOrders").doc(order.id).set({
      turfId, turfName: turf.name || "", turfLocation: turf.location || "",
      image:   Array.isArray(turf.images) && turf.images.length > 0 ? turf.images[0] : turf.image || "",
      ownerId: turf.ownerId || null, ownerName: turf.ownerName || "",
      userId:  userId || null,
      dateString, startUnit: start, durationMinutes,
      startTime: formatMinutes(start), endTime: formatMinutes(end),
      packageId: pkg.id, packageLabel: pkg.label || `${pkg.overs} overs`, overs: Number(pkg.overs || 0),
      price, orderId: order.id,
      orderStatus: "created", paymentStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.KEY_ID });
  } catch (err) {
    console.error("createballmachineorder error: - server.js:4337", err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// ✅ VERIFY BALL MACHINE PAYMENT
// =============================================================================
app.post("/verify-ballmachine-payment", verifyLimiter, async (req, res) => {
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

    const orderRef  = db.collection("ballMachineOrders").doc(order_id);
    let bookingId    = null;
    let orderData    = null;
    let alreadyPaid  = false;
    let machineIndex = null;

    await db.runTransaction(async (txn) => {
      const orderDoc = await txn.get(orderRef);
      if (!orderDoc.exists) throw new Error("Order not found");
      orderData = orderDoc.data();
      if (orderData.orderStatus === "paid") { alreadyPaid = true; return; }

      const start = orderData.startUnit;
      const end   = start + orderData.durationMinutes;

      const bookingSnap = await txn.get(
        db.collection("ballMachineBookings")
          .where("turfId", "==", orderData.turfId)
          .where("dateString", "==", orderData.dateString)
      );
      const blockSnap = await txn.get(
        db.collection("ballMachineBlocks")
          .where("turfId", "==", orderData.turfId)
          .where("dateString", "==", orderData.dateString)
      );
      const turfDoc = await txn.get(db.collection("turfs").doc(orderData.turfId));
      const turf    = turfDoc.exists ? turfDoc.data() : {};
      const machineCount = Math.max(1, Number(turf.ballMachineCount || 1));

      const occupied = [];
      bookingSnap.docs.forEach((d) => {
        const b = d.data();
        if (b.status === "cancelled") return;
        occupied.push({ machineIndex: b.machineIndex, start: b.startUnit, end: b.startUnit + b.durationMinutes });
      });
      blockSnap.docs.forEach((d) => {
        const b = d.data();
        occupied.push({
          machineIndex: b.machineIndex || "all",
          start: b.startUnit,
          end: b.startUnit + (b.durationMinutes || BALL_MACHINE_UNIT_MINUTES),
        });
      });

      const freeMachine = findFreeMachine(occupied, machineCount, start, end);
      if (!freeMachine) {
        throw new Error("SLOT_CONFLICT: This time is no longer available");
      }
      machineIndex = freeMachine;

      bookingId = `${orderData.turfId}_bm_${Date.now()}`;
      const bookingRef  = db.collection("ballMachineBookings").doc(bookingId);
      const parsedDate  = new Date(orderData.dateString);
      const bookingDate = admin.firestore.Timestamp.fromDate(isNaN(parsedDate.getTime()) ? new Date() : parsedDate);

      txn.set(bookingRef, {
        turfId: orderData.turfId, turfName: orderData.turfName, turfLocation: orderData.turfLocation,
        image: orderData.image, ownerId: orderData.ownerId, ownerName: orderData.ownerName,
        userId: orderData.userId || null, userName: "", userPhone: "", userEmail: "",
        date: bookingDate, dateString: orderData.dateString,
        startUnit: start, durationMinutes: orderData.durationMinutes,
        startTime: orderData.startTime, endTime: orderData.endTime,
        machineIndex: freeMachine,
        packageId: orderData.packageId, packageLabel: orderData.packageLabel, overs: orderData.overs,
        price: orderData.price, paidAmount: orderData.price,
        paymentId: payment_id, orderId: order_id,
        status: "confirmed", paymentStatus: "paid", verificationStatus: "verified",
        ownerSettlementStatus: "pending",
        refundStatus: "not_applicable", refundAmount: 0,
        cancelledAt: null, cancelledBy: null, cancellationReason: null,
        rescheduled: false, rescheduleCount: 0,
        pcoinPending: 0, vcoinPending: 0, coinStatus: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      txn.update(orderRef, {
        orderStatus: "paid", paymentId: payment_id, paymentStatus: "paid",
        verificationStatus: "verified", paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    if (alreadyPaid) {
      try {
        const existing = await db.collection("ballMachineBookings").where("orderId", "==", order_id).limit(1).get();
        return res.json({ success: true, bookingId: existing.empty ? null : existing.docs[0].id });
      } catch {
        return res.json({ success: true, bookingId: null });
      }
    }

    // ── User info ──────────────────────────────────────────────────────────
    let userName = "", userPhone = "", userEmail = "";
    if (orderData.userId) {
      try {
        const userDoc = await db.collection("users").doc(orderData.userId).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          userName = u.name || ""; userPhone = u.phone || ""; userEmail = u.email || "";
        }
      } catch (e) { console.warn("Could not fetch user: - server.js:4470", e.message); }
      if (userName && bookingId) {
        db.collection("ballMachineBookings").doc(bookingId)
          .update({ userName, userPhone, userEmail }).catch(() => {});
      }
    }

    // ── Lock cleanup ───────────────────────────────────────────────────────
    try {
      const lockSnap = await db.collection("ballMachineLocks")
        .where("turfId", "==", orderData.turfId)
        .where("dateString", "==", orderData.dateString)
        .where("userId", "==", orderData.userId)
        .get();
      await Promise.all(
        lockSnap.docs
          .filter((d) => d.data().startUnit === orderData.startUnit)
          .map((d) => d.ref.delete())
      );
    } catch (e) { console.warn("BM lock cleanup failed: - server.js:4489", e.message); }

    // =========================================================================
    // 🪙 COIN EARN — PENDING (credited after session ends, via cron)
    // Same rate config as turf bookings: PCoin from settings/pcoinConfig,
    // VCoin from the turf's own vcoinEnabled/vcoinRatePerHour. Duration is
    // in minutes here (15/30 min) rather than half-hour slots, so we convert
    // to a fraction of an hour before applying the hourly rate.
    // =========================================================================
    let pcoinPending = 0, vcoinPending = 0;
    if (orderData.userId && bookingId) {
      try {
        const bookingHours = Number(orderData.durationMinutes || 0) / 60;

        const pcoinConfigSnap = await db.collection("settings").doc("pcoinConfig").get();
        if (pcoinConfigSnap.exists) {
          const cfg = pcoinConfigSnap.data();
          if (cfg.enabled !== false && Number(cfg.ratePerHour || 0) > 0 && bookingHours > 0) {
            pcoinPending = Math.floor(bookingHours * Number(cfg.ratePerHour));
          }
        }

        const turfSnap = await db.collection("turfs").doc(orderData.turfId).get();
        if (turfSnap.exists) {
          const turfData = turfSnap.data();
          if (turfData.vcoinEnabled === true && Number(turfData.vcoinRatePerHour || 0) > 0 && bookingHours > 0) {
            vcoinPending = Math.floor(bookingHours * Number(turfData.vcoinRatePerHour));
          }
        }

        const coinUpdate = { coinStatus: "pending" };
        if (pcoinPending > 0) coinUpdate.pcoinPending = pcoinPending;
        if (vcoinPending > 0) coinUpdate.vcoinPending = vcoinPending;
        await db.collection("ballMachineBookings").doc(bookingId).update(coinUpdate)
          .catch((e) => console.warn("BM coin booking update failed: - server.js:4523", e.message));

        if (pcoinPending > 0) {
          const pcWalletRef = db.collection("pcoinWallets").doc(orderData.userId);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(pcWalletRef);
            if (snap.exists) {
              txn.update(pcWalletRef, {
                pendingBalance: admin.firestore.FieldValue.increment(pcoinPending),
                updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(pcWalletRef, {
                uid: orderData.userId, balance: 0, pendingBalance: pcoinPending,
                totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("pcoinLedger").add({
            uid: orderData.userId, type: "pcoin_earn_pending", coins: pcoinPending,
            bookingId, bookingType: "ball_machine", turfId: orderData.turfId, turfName: orderData.turfName || "",
            note: "Ball Machine — pending, will credit after session ends",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (vcoinPending > 0) {
          const vcWalletKey = `${orderData.userId}_${orderData.turfId}`;
          const vcWalletRef = db.collection("vcoinWallets").doc(vcWalletKey);
          await db.runTransaction(async (txn) => {
            const snap = await txn.get(vcWalletRef);
            if (snap.exists) {
              txn.update(vcWalletRef, {
                pendingBalance: admin.firestore.FieldValue.increment(vcoinPending),
                updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(vcWalletRef, {
                uid: orderData.userId, turfId: orderData.turfId, turfName: orderData.turfName || "",
                balance: 0, pendingBalance: vcoinPending, totalEarned: 0, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("vcoinLedger").add({
            uid: orderData.userId, type: "vcoin_earn_pending", coins: vcoinPending,
            bookingId, bookingType: "ball_machine", turfId: orderData.turfId, turfName: orderData.turfName || "",
            note: "Ball Machine — pending, will credit after session ends",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        console.log(`🪙 BM coins pending: pcoin=${pcoinPending} vcoin=${vcoinPending} bookingId=${bookingId} - server.js:4578`);
      } catch (coinErr) {
        console.warn("BM coin pending earn failed (nonfatal): - server.js:4580", coinErr.message);
      }
    }
    // ── END COIN EARN ─────────────────────────────────────────────────────

    const dateOnly = orderData.dateString?.split(" ").slice(0, 3).join(" ") || orderData.dateString;

    sendPushToUser(orderData.userId, "🎯 Ball Machine Booked!",
      `Your ${orderData.overs}-over session at ${orderData.turfName} on ${dateOnly} from ${orderData.startTime} is confirmed.`,
      { screen: "bookings", bookingId }
    );
    if (orderData.ownerId) {
      sendPushToUser(orderData.ownerId, "🎯 New Ball Machine Booking",
        `${userName || "A user"} booked a ${orderData.overs}-over session at ${orderData.turfName} on ${dateOnly} from ${orderData.startTime}.`,
        { screen: "owner-bookings", bookingId }
      );
    }

    return res.json({ success: true, bookingId, machineIndex, pcoinPending, vcoinPending });

  } catch (err) {
    console.error("verifyballmachinepayment error: - server.js:4601", err);

    if (err.message?.startsWith("SLOT_CONFLICT") && payment_id_outer) {
      try {
        const payment = await razorpay.payments.fetch(payment_id_outer);
        if (payment.status === "captured") {
          const refund = await razorpay.payments.refund(payment_id_outer, {
            amount: payment.amount, notes: { reason: err.message }, speed: "normal",
          });
          if (order_id) {
            await db.collection("ballMachineOrders").doc(order_id).update({
              orderStatus: "refunded", paymentStatus: "refunded",
              refundId: refund.id, refundReason: err.message,
              refundedAt: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
          }
          return res.status(409).json({
            success: false, error: err.message.replace("SLOT_CONFLICT: ", ""),
            autoRefunded: true, refundId: refund.id,
            message: "This time is no longer available. Your payment has been refunded automatically. It will reflect in 5–7 business days.",
          });
        }
      } catch (refundErr) {
        console.error("BM autorefund failed: - server.js:4624", refundErr.message);
        return res.status(409).json({
          success: false, error: err.message.replace("SLOT_CONFLICT: ", ""),
          autoRefunded: false,
          message: "Slot unavailable. Refund could not be processed automatically — please contact support.",
        });
      }
    }

    try {
      if (order_id) {
        const orderDoc = await db.collection("ballMachineOrders").doc(order_id).get();
        if (orderDoc.exists && orderDoc.data().orderStatus !== "paid") {
          await db.collection("ballMachineOrders").doc(order_id).update({
            orderStatus: "failed", paymentStatus: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (e) { console.warn("BM failed order update: - server.js:4643", e.message); }

    return res.status(500).json({ success: false, error: err.message || "Verification failed" });
  }
});

// =============================================================================
// ✅ CANCEL BALL MACHINE BOOKING (user-initiated)
// =============================================================================
app.post("/cancel-ballmachine-booking", cancelLimiter, async (req, res) => {
  try {
    const { bookingId, userId, reason } = req.body;
    if (!bookingId || !userId) {
      return res.status(400).json({ success: false, error: "bookingId and userId are required" });
    }

    const bookingRef = db.collection("ballMachineBookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();

    if (booking.userId !== userId) {
      return res.status(403).json({ success: false, error: "You are not authorised to cancel this booking" });
    }
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "This booking is already cancelled" });
    }

    const bookingDate  = booking.date?.toDate ? booking.date.toDate() : new Date(booking.dateString);
    const sessionStart = new Date(bookingDate);
    sessionStart.setHours(0, 0, 0, 0);
    sessionStart.setMinutes(Number(booking.startUnit || 0));

    const cancellationWindowHours = await getCancellationWindowHours();
    if (cancellationWindowHours > 0) {
      const hoursUntil = (sessionStart.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil < cancellationWindowHours) {
        return res.status(400).json({
          success: false,
          error: `Cancellations are not allowed within ${cancellationWindowHours} hours of the session start time`,
          hoursUntilSlot: Math.round(hoursUntil * 10) / 10,
          requiredHours: cancellationWindowHours,
        });
      }
    }

    const paidAmount   = Number(booking.paidAmount || booking.price || 0);
    const paymentId    = booking.paymentId || null;
    const wasOnline    = !!paymentId;
    const refundAmount = wasOnline ? paidAmount : 0;

    await bookingRef.update({
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           "user",
      cancellationReason:    reason || "User requested cancellation",
      refundStatus:          wasOnline ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });

    let refundId = null, refundNote = "no_refund";
    if (wasOnline && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes:  { bookingId, reason: reason || "User cancelled Ball Machine booking" },
          speed:  "normal",
        });
        refundId   = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId, refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (refundError) {
        console.error("BM refund error: - server.js:4719", refundError.message);
        await bookingRef.update({ refundStatus: "failed", refundError: refundError.message });
        refundNote = "refund_failed";
      }
    }

    // ── Coin reversal (pending EARN only — packages are flat-price, no coin
    //    redemption on ball machine bookings, so there's nothing to refund back) ──
    try {
      const pcoinPending = Number(booking.pcoinPending || 0);
      const vcoinPending = Number(booking.vcoinPending || 0);

      if (pcoinPending > 0 && userId) {
        const pcWalletRef = db.collection("pcoinWallets").doc(userId);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(pcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(pcWalletRef, {
            pendingBalance: Math.max(current - pcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("pcoinLedger").add({
          uid: userId, type: "pcoin_earn_reversed", coins: pcoinPending, bookingId,
          bookingType: "ball_machine", turfId: booking.turfId || "", turfName: booking.turfName || "",
          note: "Ball Machine booking cancelled — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (vcoinPending > 0 && userId && booking.turfId) {
        const vcWalletRef = db.collection("vcoinWallets").doc(`${userId}_${booking.turfId}`);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(vcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(vcWalletRef, {
            pendingBalance: Math.max(current - vcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("vcoinLedger").add({
          uid: userId, type: "vcoin_earn_reversed", coins: vcoinPending, bookingId,
          bookingType: "ball_machine", turfId: booking.turfId, turfName: booking.turfName || "",
          note: "Ball Machine booking cancelled — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (pcoinPending > 0 || vcoinPending > 0) {
        await bookingRef.update({ pcoinPending: 0, vcoinPending: 0, coinStatus: "cancelled" }).catch(() => {});
      }
    } catch (coinErr) {
      console.warn("BM coin reversal failed (nonfatal): - server.js:4773", coinErr.message);
    }

    sendPushToUser(userId, "❌ Ball Machine Booking Cancelled",
      wasOnline && refundAmount > 0
        ? `Your Ball Machine session at ${booking.turfName} was cancelled. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your Ball Machine session at ${booking.turfName} on ${booking.dateString} has been cancelled.`,
      { screen: "bookings", bookingId }
    );
    if (booking.ownerId) {
      sendPushToUser(booking.ownerId, "🔔 Ball Machine Booking Cancelled",
        `${booking.userName || "A user"} cancelled their Ball Machine session at ${booking.turfName} on ${booking.dateString}.`,
        { screen: "owner-bookings" }
      );
    }

    return res.json({
      success: true, bookingId, refundStatus: refundNote, refundAmount, refundId,
      message: wasOnline && refundAmount > 0
        ? `Booking cancelled. ₹${refundAmount} refund has been initiated and will reflect in 5-7 business days.`
        : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("cancelballmachinebooking error: - server.js:4796", err);
    return res.status(500).json({ success: false, error: err.message || "Cancellation failed. Please try again." });
  }
});

// =============================================================================
// ✅ OWNER/ADMIN CANCEL BALL MACHINE BOOKING
// =============================================================================
app.post("/owner-cancel-ballmachine-booking", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { bookingId, reason, note } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: "bookingId is required" });
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, error: "A cancellation reason is required." });
    }

    const bookingRef = db.collection("ballMachineBookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();

    if (req.callerRole !== "admin" && booking.ownerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You can only cancel bookings on your own venue." });
    }
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "This booking is already cancelled." });
    }

    const paidAmount   = Number(booking.paidAmount || booking.price || 0);
    const paymentId    = booking.paymentId || null;
    const wasOnline    = !!paymentId;
    const refundAmount = wasOnline ? paidAmount : 0;

    await bookingRef.update({
      status:                "cancelled",
      cancelledAt:           admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy:           req.callerRole === "admin" ? "admin" : "owner",
      cancellationReason:    String(reason).trim(),
      ownerCancelNote:       note ? String(note).trim() : "",
      refundStatus:          wasOnline ? "pending" : "not_applicable",
      refundAmount,
      ownerSettlementStatus: "cancelled",
    });

    let refundId = null, refundNote = "no_refund";
    if (wasOnline && refundAmount > 0) {
      try {
        const refund = await razorpay.payments.refund(paymentId, {
          amount: refundAmount * 100,
          notes:  { bookingId, reason: `Owner cancelled: ${reason}` },
          speed:  "normal",
        });
        refundId   = refund.id;
        refundNote = "refund_initiated";
        await bookingRef.update({
          refundId, refundStatus: "initiated",
          refundInitiated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (refundErr) {
        console.error("Owner BM cancel refund failed: - server.js:4855", refundErr.message);
        await bookingRef.update({ refundStatus: "failed", refundError: refundErr.message });
        refundNote = "refund_failed";
      }
    }

    try {
      const pcoinPending = Number(booking.pcoinPending || 0);
      const vcoinPending = Number(booking.vcoinPending || 0);
      const uid = booking.userId;

      if (pcoinPending > 0 && uid) {
        const pcWalletRef = db.collection("pcoinWallets").doc(uid);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(pcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(pcWalletRef, {
            pendingBalance: Math.max(current - pcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("pcoinLedger").add({
          uid, type: "pcoin_earn_reversed", coins: pcoinPending, bookingId,
          bookingType: "ball_machine", turfId: booking.turfId || "", turfName: booking.turfName || "",
          note: "Ball Machine booking cancelled by venue — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (vcoinPending > 0 && uid && booking.turfId) {
        const vcWalletRef = db.collection("vcoinWallets").doc(`${uid}_${booking.turfId}`);
        await db.runTransaction(async (txn) => {
          const snap = await txn.get(vcWalletRef);
          if (!snap.exists) return;
          const current = Number(snap.data().pendingBalance || 0);
          txn.update(vcWalletRef, {
            pendingBalance: Math.max(current - vcoinPending, 0),
            updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await db.collection("vcoinLedger").add({
          uid, type: "vcoin_earn_reversed", coins: vcoinPending, bookingId,
          bookingType: "ball_machine", turfId: booking.turfId, turfName: booking.turfName || "",
          note: "Ball Machine booking cancelled by venue — pending coins reversed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      if (pcoinPending > 0 || vcoinPending > 0) {
        await bookingRef.update({ pcoinPending: 0, vcoinPending: 0, coinStatus: "cancelled" }).catch(() => {});
      }
    } catch (coinErr) {
      console.warn("Owner BM cancel coin reversal failed (nonfatal): - server.js:4908", coinErr.message);
    }

    sendPushToUser(booking.userId, "❌ Ball Machine Booking Cancelled by Venue",
      wasOnline && refundAmount > 0
        ? `Your Ball Machine session at ${booking.turfName} on ${booking.dateString} was cancelled by the venue. Reason: ${reason}. ₹${refundAmount} refund initiated (5–7 business days).`
        : `Your Ball Machine session at ${booking.turfName} on ${booking.dateString} was cancelled by the venue. Reason: ${reason}.`,
      { screen: "bookings", bookingId }
    );

    return res.json({
      success: true, bookingId, refundStatus: refundNote, refundAmount, refundId,
      message: wasOnline && refundAmount > 0
        ? `Booking cancelled. ₹${refundAmount} refund initiated to the customer.`
        : "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("ownercancelballmachinebooking error: - server.js:4925", err);
    return res.status(500).json({ success: false, error: err.message || "Cancellation failed." });
  }
});

// =============================================================================
// 🔁 OWNER/ADMIN RESCHEDULE BALL MACHINE BOOKING
// - Duration stays fixed to the original package (keeps price intact)
// - Player just moves to a new date/time; machine bay is re-assigned to
//   whichever bay is free at the new time
// =============================================================================
app.post("/owner-reschedule-ballmachine-booking", adminActionLimiter, requireAdminOrOwner, async (req, res) => {
  try {
    const { bookingId, newDateString, newStartUnit, reason } = req.body;

    if (!bookingId) return res.status(400).json({ success: false, error: "bookingId is required" });
    if (!newDateString || !String(newDateString).trim()) {
      return res.status(400).json({ success: false, error: "newDateString is required" });
    }
    if (newStartUnit === undefined || newStartUnit === null || isNaN(Number(newStartUnit))) {
      return res.status(400).json({ success: false, error: "newStartUnit is required" });
    }

    const bookingRef = db.collection("ballMachineBookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    if (!bookingDoc.exists) return res.status(404).json({ success: false, error: "Booking not found" });
    const booking = bookingDoc.data();

    if (req.callerRole !== "admin" && booking.ownerId !== req.callerUid) {
      return res.status(403).json({ success: false, error: "You can only reschedule bookings on your own venue." });
    }
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, error: "Cannot reschedule a cancelled booking." });
    }

    const newDate = new Date(newDateString);
    if (isNaN(newDate.getTime())) {
      return res.status(400).json({ success: false, error: "Invalid new date." });
    }
    const newDay = new Date(newDate); newDay.setHours(0, 0, 0, 0);
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    if (newDay < today) {
      return res.status(400).json({ success: false, error: "Cannot reschedule to a past date." });
    }

    const newStart = Number(newStartUnit);
    if (newStart % BALL_MACHINE_UNIT_MINUTES !== 0) {
      return res.status(400).json({ success: false, error: "Invalid start time." });
    }
    const durationMinutes = Number(booking.durationMinutes || 0);
    const newEnd = newStart + durationMinutes;

    const turfDoc = await db.collection("turfs").doc(booking.turfId).get();
    const turf    = turfDoc.exists ? turfDoc.data() : {};
    const { startMin, endMin } = getBallMachineWindow(turf);
    if (newStart < startMin || newEnd > endMin) {
      return res.status(400).json({ success: false, error: "Selected time is outside operating hours." });
    }
    const machineCount = Math.max(1, Number(turf.ballMachineCount || 1));

    await db.runTransaction(async (txn) => {
      const bookingSnap = await txn.get(
        db.collection("ballMachineBookings")
          .where("turfId", "==", booking.turfId)
          .where("dateString", "==", newDateString)
      );
      const blockSnap = await txn.get(
        db.collection("ballMachineBlocks")
          .where("turfId", "==", booking.turfId)
          .where("dateString", "==", newDateString)
      );

      const occupied = [];
      bookingSnap.docs.forEach((d) => {
        if (d.id === bookingId) return;
        const b = d.data();
        if (b.status === "cancelled") return;
        occupied.push({ machineIndex: b.machineIndex, start: b.startUnit, end: b.startUnit + b.durationMinutes });
      });
      blockSnap.docs.forEach((d) => {
        const b = d.data();
        occupied.push({
          machineIndex: b.machineIndex || "all",
          start: b.startUnit,
          end: b.startUnit + (b.durationMinutes || BALL_MACHINE_UNIT_MINUTES),
        });
      });

      const freeMachine = findFreeMachine(occupied, machineCount, newStart, newEnd);
      if (!freeMachine) {
        throw new Error("SLOT_CONFLICT: No machine free at this new time");
      }

      const parsedDate = new Date(newDateString);
      txn.update(bookingRef, {
        dateString: newDateString,
        date:       admin.firestore.Timestamp.fromDate(isNaN(parsedDate.getTime()) ? new Date() : parsedDate),
        startUnit:  newStart,
        startTime:  formatMinutes(newStart),
        endTime:    formatMinutes(newEnd),
        machineIndex: freeMachine,
        rescheduled:   true,
        rescheduleCount: admin.firestore.FieldValue.increment(1),
        rescheduleHistory: admin.firestore.FieldValue.arrayUnion({
          fromDate:      booking.dateString || "",
          fromStartTime: booking.startTime || "",
          toDate:        newDateString,
          toStartTime:   formatMinutes(newStart),
          by:            req.callerRole === "admin" ? "admin" : "owner",
          reason:        reason ? String(reason).trim() : "",
          at:            new Date().toISOString(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    sendPushToUser(booking.userId, "🔁 Ball Machine Booking Rescheduled",
      `Your Ball Machine session at ${booking.turfName} has been moved to ${newDateString}, ${formatMinutes(newStart)}.${reason ? ` Reason: ${reason}` : ""}`,
      { screen: "bookings", bookingId }
    );

    return res.json({
      success: true, bookingId, newDateString,
      newStartTime: formatMinutes(newStart), newEndTime: formatMinutes(newEnd),
      message: "Booking rescheduled successfully. The customer has been notified.",
    });
  } catch (err) {
    console.error("ownerrescheduleballmachinebooking error: - server.js:5052", err);
    if (err.message?.startsWith("SLOT_CONFLICT")) {
      return res.status(409).json({
        success: false, slotConflict: true,
        error: err.message.replace("SLOT_CONFLICT: ", ""),
      });
    }
    return res.status(500).json({ success: false, error: err.message || "Reschedule failed." });
  }
});

// =============================================================================
// 🪙 CREDIT COMPLETED BALL MACHINE COINS (cron — call alongside your existing
// /credit-completed-coins on the same schedule, with the same x-cron-secret)
// =============================================================================
app.post("/credit-completed-ballmachine-coins", async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const now = new Date();
    const snap = await db.collection("ballMachineBookings")
      .where("coinStatus", "==", "pending")
      .where("status", "==", "confirmed")
      .get();

    let credited = 0, skipped = 0;

    await Promise.allSettled(snap.docs.map(async (docSnap) => {
      const booking   = docSnap.data();
      const bookingId = docSnap.id;

      try {
        const bookingDate = booking.date?.toDate ? booking.date.toDate() : new Date(booking.dateString);
        const sessionEnd  = new Date(bookingDate);
        sessionEnd.setHours(0, 0, 0, 0);
        sessionEnd.setMinutes(Number(booking.startUnit || 0) + Number(booking.durationMinutes || 0));

        if (sessionEnd > now) { skipped++; return; }

        const pcoinPending = Number(booking.pcoinPending || 0);
        const vcoinPending = Number(booking.vcoinPending || 0);
        const uid = booking.userId;
        if (!uid) return;

        if (pcoinPending > 0) {
          const pcWalletRef = db.collection("pcoinWallets").doc(uid);
          await db.runTransaction(async (txn) => {
            const wSnap = await txn.get(pcWalletRef);
            if (wSnap.exists) {
              const curr    = wSnap.data();
              const pending = Math.max(Number(curr.pendingBalance || 0) - pcoinPending, 0);
              txn.update(pcWalletRef, {
                balance:        admin.firestore.FieldValue.increment(pcoinPending),
                pendingBalance: pending,
                totalEarned:    admin.firestore.FieldValue.increment(pcoinPending),
                updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(pcWalletRef, {
                uid, balance: pcoinPending, pendingBalance: 0,
                totalEarned: pcoinPending, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("pcoinLedger").add({
            uid, type: "pcoin_earn", coins: pcoinPending, bookingId,
            bookingType: "ball_machine", turfId: booking.turfId, turfName: booking.turfName || "",
            note: "Credited after Ball Machine session completed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        if (vcoinPending > 0 && booking.turfId) {
          const vcKey    = `${uid}_${booking.turfId}`;
          const vcWalRef = db.collection("vcoinWallets").doc(vcKey);
          await db.runTransaction(async (txn) => {
            const wSnap = await txn.get(vcWalRef);
            if (wSnap.exists) {
              const curr    = wSnap.data();
              const pending = Math.max(Number(curr.pendingBalance || 0) - vcoinPending, 0);
              txn.update(vcWalRef, {
                balance:        admin.firestore.FieldValue.increment(vcoinPending),
                pendingBalance: pending,
                totalEarned:    admin.firestore.FieldValue.increment(vcoinPending),
                updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
              });
            } else {
              txn.set(vcWalRef, {
                uid, turfId: booking.turfId, turfName: booking.turfName || "",
                balance: vcoinPending, pendingBalance: 0,
                totalEarned: vcoinPending, totalRedeemed: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          });
          await db.collection("vcoinLedger").add({
            uid, type: "vcoin_earn", coins: vcoinPending, bookingId,
            bookingType: "ball_machine", turfId: booking.turfId, turfName: booking.turfName || "",
            note: "Credited after Ball Machine session completed",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        await docSnap.ref.update({
          pcoinEarned: pcoinPending, vcoinEarned: vcoinPending,
          pcoinPending: 0, vcoinPending: 0,
          coinStatus: "credited",
          coinCreditedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (pcoinPending > 0 || vcoinPending > 0) {
          const parts = [];
          if (pcoinPending > 0) parts.push(`${pcoinPending} PCoin`);
          if (vcoinPending > 0) parts.push(`${vcoinPending} VCoin`);
          sendPushToUser(uid, "🪙 Coins Credited!",
            `${parts.join(" + ")} added to your wallet from your ${booking.turfName} Ball Machine session.`,
            { screen: "wallet" }
          );
        }

        credited++;
        console.log(`🪙 BM coins credited: bookingId=${bookingId} pcoin=${pcoinPending} vcoin=${vcoinPending} - server.js:5178`);
      } catch (e) {
        console.warn(`BM coin credit failed for booking ${docSnap.id}: - server.js:5180`, e.message);
      }
    }));

    return res.json({
      success: true,
      message: `Ball Machine coin credit run complete. Credited: ${credited}, Skipped (future sessions): ${skipped}`,
      credited, skipped,
    });
  } catch (err) {
    console.error("creditcompletedballmachinecoins error: - server.js:5190", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


  // ✅ HEALTH CHECK
  // =======================================================
  app.get("/", (req, res) => res.send("Bookora server running ✅"));

  // =======================================================
  // ❌ GLOBAL ERROR HANDLER
  // =======================================================
  app.use((err, req, res, next) => {
    console.error("Global Error: - server.js:5204", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  });

  // =======================================================
  // 🚀 START
  // =======================================================
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on ${PORT} ✅ - server.js:5212`));