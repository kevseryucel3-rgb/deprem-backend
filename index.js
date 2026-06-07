console.log("🔥 VERSION: FINAL-PRODUCTION-MIGRATED-FIXED");

const admin = require("firebase-admin");
const express = require("express");
const fetch = require("node-fetch");
const { getKandilliDepremler } = require("./services/kandilliService");

const app = express();
app.use(express.json());

// ======================
// 🌐 LOG
// ======================
app.use((req, res, next) => {
  console.log("🌐 HIT:", req.url);
  next();
});

// ======================
// 🔐 FIREBASE INIT
// ======================
if (!process.env.GOOGLE_CREDENTIALS) {
  throw new Error("❌ GOOGLE_CREDENTIALS eksik!");
}

const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let isProcessing = false;
let lastRun = 0;
const CHECK_INTERVAL_MS = 15 * 1000; // 15 Saniyede bir kontrol (Hızlı döngü)

// ======================
// 📏 MESAFE (HAIVERSINE)
// ======================
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ======================
// 🔒 DUPLICATE CONTROL (TRANSACTION)
// ======================
async function checkAndMarkSent(id, mag) {
  const ref = db.collection("sent").doc(id);

  return await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);

    if (doc.exists) {
      const oldMag = doc.data().mag || 0;
      if (oldMag === mag) return true;

      tx.update(ref, {
        mag,
        time: admin.firestore.FieldValue.serverTimestamp(),
      });

      return false;
    }

    tx.set(ref, {
      mag,
      time: admin.firestore.FieldValue.serverTimestamp(),
    });

    return false;
  });
}

// ======================
// 🧹 TOKEN CLEANUP
// ======================
async function cleanInvalidTokens(tokens) {
  if (!tokens.length) return;

  for (let i = 0; i < tokens.length; i += 10) {
    const chunk = tokens.slice(i, i + 10);
    const snap = await db.collection("users").where("token", "in", chunk).get();

    if (snap.empty) continue;

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.update(doc.ref, {
        token: admin.firestore.FieldValue.delete(),
        pushActive: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }
}

// =============================================================================
// 🎛️ VERİ NORMALİZASYONU (Çalışan Kodun En Güçlü Kısmı)
// =============================================================================
function normalizeUsgsFeature(feature) {
  const [lon, lat, depthRaw] = feature.geometry.coordinates;
  const mag = Number(feature.properties.mag || 0);
  const depth = Number(depthRaw || 0);

  if (!lat || !lon || !mag) return null;

  return {
    id: `usgs_${feature.id}`,
    source: "usgs",
    place: feature.properties.place || "Global Deprem",
    mag: mag,
    lat: lat,
    lon: lon,
    depth: depth,
    time: String(feature.properties.time || Date.now()),
  };
}

async function getUsgsDepremler() {
  try {
    const response = await fetch(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
    );
    const json = await response.json();
    const features = Array.isArray(json.features) ? json.features : [];
    return features.map((f) => normalizeUsgsFeature(f)).filter(Boolean);
  } catch (error) {
    console.error("❌ USGS veri hatası:", error.message);
    return [];
  }
}

function isDuplicate(a, b) {
  const timeA = Number(a.time || 0);
  const timeB = Number(b.time || 0);

  return (
    Math.abs(Number(a.lat) - Number(b.lat)) < 0.05 &&
    Math.abs(Number(a.lon) - Number(b.lon)) < 0.05 &&
    Math.abs(timeA - timeB) < 5 * 60 * 1000
  );
}

function mergeEarthquakes(usgs, kandilliNormalized) {
  const merged = [...usgs];

  for (const quake of kandilliNormalized) {
    const duplicate = merged.some((existing) => isDuplicate(existing, quake));
    if (!duplicate) merged.push(quake);
  }

  return merged;
}

// =============================================================================
// 🔔 NOTIFICATION (KALICI FİLTRE MANTIĞI KORUNDU & TAM UYUMLU)
// =============================================================================
async function sendNotification(eq) {
  const mag = Number(eq.mag || 0);
  const place = String(eq.place || "Deprem");
  const source = String(eq.source || "usgs").toLowerCase();
  const lat = Number(eq.lat);
  const lon = Number(eq.lon);
  const depth = Math.round(eq.depth || 0);
  const quakeTime = String(eq.time || Date.now());

  console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

  const snapshot = await db.collection("users")
    .where("pushActive", "==", true)
    .select(
      "token",
      "lat",
      "lon",
      "notificationsEnabled",
      "alarmEnabled",
      "isPremium",
      "premiumUntil",
      "minMag",
      "maxDist",
      "alarmMag",
      "alarmDist"
    )
    .limit(2000)
    .get();

  const messages = [];

  snapshot.forEach((doc) => {
    const user = doc.data();
    if (!user.token) return;

    // KALICI KURAL: Ana main.dart kuralına sadık kalındı (varsayılan true)
    const notificationsEnabled = user.notificationsEnabled !== false;
    const alarmEnabledGlobal = user.alarmEnabled === true;

    if (!notificationsEnabled && !alarmEnabledGlobal) return;

    if (user.lat === undefined || user.lon === undefined || user.lat === null || user.lon === null) return;
    const userLat = Number(user.lat);
    const userLon = Number(user.lon);
    if (isNaN(userLat) || isNaN(userLon)) return;

    const distance = getDistance(userLat, userLon, lat, lon);

    // 🇹🇷 KALICI KURAL: KANDİLLİ ÖZEL Sınır Kuralı
    if (source === "kandilli") {
      const isTR = userLat >= 34 && userLat <= 44 && userLon >= 24 && userLon <= 47; 
      if (!isTR) return;
    }

    let sendNotificationFlag = false;
    let sendAlarmFlag = false;

    let isPremium = user.isPremium === true;
    if (user.premiumUntil) {
      try {
        isPremium = user.premiumUntil.toDate() > new Date();
      } catch (e) {}
    }

    // 🎯 KALICI KURAL: MAIN.DART FİLTRE MANTIĞI %100 KORUNDU
    if (isPremium) {
      const userMinMag = Number(user.minMag || 1.0);
      const userMaxDist = Number(user.maxDist || 500.0);
      const userAlarmMag = Number(user.alarmMag ?? 3.0);
      const userAlarmDist = Number(user.alarmDist ?? 300.0);

      if (notificationsEnabled && mag >= userMinMag && distance <= userMaxDist) {
        sendNotificationFlag = true;
      }

      if (alarmEnabledGlobal && mag >= userAlarmMag && distance <= userAlarmDist) {
        sendNotificationFlag = true; 
        sendAlarmFlag = true;
      }
    } else {
      // Ücretsiz Kullanıcı Ayarları
      if (notificationsEnabled && mag >= 2.0 && distance <= 1200.0) {
        sendNotificationFlag = true;
      }
      if (alarmEnabledGlobal && mag >= 4.5 && distance <= 500.0) {
        sendNotificationFlag = true;
        sendAlarmFlag = true;
      }
    }

    if (!sendNotificationFlag) return;

    messages.push({
      token: user.token,
      data: {
        title: `🚨 ${mag.toFixed(1)} Deprem`,
        body: place,
        place: place,
        mag: String(mag),
        lat: String(lat),
        lon: String(lon),
        depth: String(depth),
        distance: String(distance),
        source: source,
        time: quakeTime,
        open_alarm: sendAlarmFlag ? "true" : "false", // Kritik anahtar korundu
      },
      android: {
        priority: "high",
      },
    });
  });

  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i += 500) {
    const batch = messages.slice(i, i + 500);
    try {
      const res = await admin.messaging().sendEach(batch);
      const invalidTokens = [];
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          const err = r.error?.code;
          if (err === "messaging/registration-token-not-registered" || 
              err === "messaging/invalid-registration-token") {
            invalidTokens.push(batch[idx].token);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await cleanInvalidTokens(invalidTokens);
      }
      console.log(`✅ ${res.successCount} adet bildirim iletildi.`);
    } catch (e) {
      console.error("❌ FCM Batch Hatası:", e.message);
    }
  }
}

// ======================
// 🔍 LOOP (KRONOMETRE)
// ======================
async function checkEarthquakes() {
  if (Date.now() - lastRun < CHECK_INTERVAL_MS) return;
  if (isProcessing) return;

  lastRun = Date.now();
  isProcessing = true;

  try {
    const [usgsList, kandilliRaw] = await Promise.all([
      getUsgsDepremler(),
      getKandilliDepremler().catch(() => []),
    ]);

    // Kandilli verisini güvenli bir şekilde döngü öncesi normalize edelim
    const kandilliNormalized = [];
    if (Array.isArray(kandilliRaw)) {
      for (const eq of kandilliRaw) {
        try {
          const mag = parseFloat(eq.mag || eq.magnitude || 0);
          if (isNaN(mag) || mag <= 0) continue;

          const lat = Number(eq.latitude || eq.lat);
          const lon = Number(eq.longitude || eq.lon || eq.lng);
          const depth = Number(eq.depth || 0);

          if (!lat || !lon) continue;

          let cleanPlace = eq.title || eq.location || eq.place || "Türkiye";
          cleanPlace = cleanPlace.replace(/^ML\s*\d+(\.\d+)?\s*-\s*/i, "").trim();

          kandilliNormalized.push({
            id: `kandilli_${lat}_${lon}_${mag}`,
            source: "kandilli",
            place: cleanPlace,
            mag: mag,
            lat: lat,
            lon: lon,
            depth: depth,
            time: String(eq.date || eq.date_time || Date.now()),
          });
        } catch (err) {
          console.error("❌ Kandilli Satır Normalizasyon Hatası:", err.message);
        }
      }
    }

    const allQuakes = mergeEarthquakes(usgsList, kandilliNormalized);
    console.log(`📡 Döngü Tetiklendi | USGS: ${usgsList.length} | Kandilli: ${kandilliNormalized.length} | Birleşen: ${allQuakes.length}`);

    for (const eq of allQuakes) {
      const alreadySent = await checkAndMarkSent(eq.id, eq.mag);
      if (!alreadySent) {
        await sendNotification(eq);
      }
    }
  } catch (e) {
    console.error("❌ GENEL HATA:", e.message);
  } finally {
    isProcessing = false;
  }
}

// Döngüyü başlat
setInterval(checkEarthquakes, CHECK_INTERVAL_MS);
checkEarthquakes();

// ======================
// 🛣️ ROUTES
// ======================
app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    processing: isProcessing,
    time: new Date(),
  });
});

// FLUTTER ROUTE (Kandilli)
app.get("/api/kandilli", async (req, res) => {
  try {
    const data = await getKandilliDepremler();
    const cleanData = (data || []).map((eq) => ({
      ...eq,
      mag: Number(eq.mag || eq.magnitude || 0),
      magnitude: Number(eq.mag || eq.magnitude || 0),
      latitude: Number(eq.lat || eq.latitude || 0),
      lat: Number(eq.lat || eq.latitude || 0),
      longitude: Number(eq.lon || eq.longitude || eq.lng || 0),
      lon: Number(eq.lon || eq.longitude || eq.lng || 0),
      lng: Number(eq.lon || eq.longitude || eq.lng || 0),
      depth: Number(eq.depth || 0),
      title: String(eq.title || eq.location || eq.place || "Türkiye"),
      place: String(eq.title || eq.location || eq.place || "Türkiye"),
      date: eq.date || eq.date_time || new Date().toISOString(),
    }));

    res.json({ status: true, source: "kandilli", count: cleanData.length, result: cleanData });
  } catch (err) {
    res.status(500).json({ status: false, error: err.message, result: [] });
  }
});

// ======================
// 🧪 TEST ENDPOINT
// ======================
app.get("/test", async (req, res) => {
  try {
    const userSnap = await db.collection("users").where("pushActive", "==", true).limit(1).get();
    if (userSnap.empty) return res.send("Aktif kullanıcı bulunamadı");

    const testUser = userSnap.docs[0].data();
    await admin.messaging().send({
      token: testUser.token,
      android: { priority: "high" },
      data: {
        id: "test_" + Date.now(),
        title: "🚨 BİLDİRİM TESTİ",
        body: "Sistem test bildirimi başarıyla tetiklendi.",
        mag: "4.8",
        lat: "38.4",
        lon: "27.2",
        depth: "7",
        distance: "120",
        open_alarm: "true",
        source: "test",
        time: String(Date.now()),
      },
    });
    res.send("🚨 Test bildirimi gönderildi.");
  } catch (e) {
    res.send("Hata: " + e.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server ${PORT} portunda aktif`);
});