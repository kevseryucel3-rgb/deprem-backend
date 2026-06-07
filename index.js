console.log("VERSION: CLEAN-USGS-KANDILLI-BACKEND");

const admin = require("firebase-admin");
const express = require("express");
const fetch = require("node-fetch");
const { getKandilliDepremler } = require("./services/kandilliService");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log("HIT:", req.url);
  next();
});

if (!process.env.GOOGLE_CREDENTIALS) {
  throw new Error("GOOGLE_CREDENTIALS eksik");
}

const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let isProcessing = false;
let lastRun = 0;
const CHECK_INTERVAL_MS = 45 * 1000;
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

function normalizeUsgsFeature(feature) {
  const [lon, lat, depthRaw] = feature.geometry.coordinates;
  const mag = Number(feature.properties.mag || 0);
  const depth = Number(depthRaw || 0);

  if (!lat || !lon || !mag) return null;

  return {
    id: `usgs_${feature.id}`,
    provider: "usgs",
    source: "usgs",
    place: feature.properties.place || "Global",
    title: feature.properties.place || "Global",
    location: feature.properties.place || "Global",
    magnitude: mag,
    mag,
    lat,
    lon,
    latitude: lat,
    longitude: lon,
    depth,
    time: feature.properties.time || Date.now(),
    date_time: new Date(feature.properties.time || Date.now()).toISOString(),
    geojson: {
      type: "Point",
      coordinates: [lon, lat, depth],
    },
  };
}

async function getUsgsDepremler() {
  try {
    const response = await fetch(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      }
    );

    const json = await response.json();
    const features = Array.isArray(json.features) ? json.features : [];

    return features
      .map((feature) => normalizeUsgsFeature(feature))
      .filter(Boolean);
  } catch (error) {
    console.error("USGS veri hatasi:", error.message);
    return [];
  }
}

function isDuplicate(a, b) {
  const timeA = Number(a.time || new Date(a.date_time).getTime() || 0);
  const timeB = Number(b.time || new Date(b.date_time).getTime() || 0);

  return (
    Math.abs(Number(a.lat) - Number(b.lat)) < 0.05 &&
    Math.abs(Number(a.lon) - Number(b.lon)) < 0.05 &&
    Math.abs(timeA - timeB) < 5 * 60 * 1000
  );
}

function mergeEarthquakes(usgs, kandilli) {
  const merged = [...usgs];

  for (const quake of kandilli) {
    const duplicate = merged.some((existing) => isDuplicate(existing, quake));
    if (!duplicate) merged.push(quake);
  }

  return merged
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, 500);
}

async function sendNotification(eq) {
  const mag = Number(eq.mag || eq.magnitude || 0);
  const place = String(eq.place || eq.title || eq.location || "Deprem");
  const source = eq.source || eq.provider || "unknown";
  const lat = Number(eq.lat || eq.latitude);
  const lon = Number(eq.lon || eq.longitude || eq.lng);
  const depth = Number(eq.depth || 0);
  const quakeTime = String(eq.time || Date.now());

  if (!mag || !lat || !lon) {
  console.log("❌ DEPREM ELENDİ", {
    source,
    mag,
    lat,
    lon,
    place
  });
  return;
}

  console.log(`Bildirim kontrolu: ${source} | ${mag} | ${place}`);

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

    const notificationsEnabled = user.notificationsEnabled === true;
    const alarmEnabled = user.alarmEnabled === true;
    if (!notificationsEnabled && !alarmEnabled) return;

    const userLat = Number(user.lat);
    const userLon = Number(user.lon);
    if (!Number.isFinite(userLat) || !Number.isFinite(userLon)) return;

    const distance = getDistance(userLat, userLon, lat, lon);
if (source === "kandilli") {
  const isTR =
    userLat >= 34 &&
    userLat <= 44 &&
    userLon >= 24 &&
    userLon <= 47;

  if (!isTR) return;
}

    let isPremium = user.isPremium === true;
    if (user.premiumUntil) {
      try {
        isPremium = user.premiumUntil.toDate() > new Date();
      } catch (_) {}
    }

    let sendNotificationFlag = false;
    let sendAlarmFlag = false;
console.log("👤 USER:", {
  userId: doc.id,
  isPremium,
  mag,
  distance
});
    if (isPremium) {
      const notifMinMag = Number(user.minMag || 1.0);
      const notifMaxDist = Number(user.maxDist || 500);
      const alarmMinMag = Number(user.alarmMag ?? 4.5);
      const alarmMaxDist = Number(user.alarmDist ?? 15000);

      if (notificationsEnabled && mag >= notifMinMag && distance <= notifMaxDist) {
        sendNotificationFlag = true;
      }

      if (alarmEnabled && mag >= alarmMinMag && distance <= alarmMaxDist) {
        sendNotificationFlag = true;
        sendAlarmFlag = true;
      }
    } else if (notificationsEnabled && mag >= 2.0 && distance <= 1200) {
      sendNotificationFlag = true;
    }

    if (!sendNotificationFlag) return;

   messages.push({
  token: user.token,

  notification: {
    title: `${mag.toFixed(1)} Deprem`,
    body: `${place} - ${distance} km - ${depth} km`,
  },

  data: {
    title: `${mag.toFixed(1)} Deprem`,
    body: `${place} - ${distance} km - ${depth} km`,
    place,
    mag: String(mag),
    lat: String(lat),
    lon: String(lon),
    depth: String(depth),
    distance: String(distance),
    source,
    time: quakeTime,
    open_alarm: sendAlarmFlag ? "true" : "false",
  },

  android: {
    priority: "high",
    notification: {
      channelId: "earthquake_channel",
      priority: "max",
      defaultSound: true,
    },
  },
});

}); // <-- snapshot.forEach BURADA KAPANACAK

if (messages.length === 0) {
  console.log("ℹ️ Kriterlere uyan kullanıcı bulunamadı.");
  return;
}

for (let i = 0; i < messages.length; i += 500) {
  const batch = messages.slice(i, i + 500);

  try {
    const res = await admin.messaging().sendEach(batch);

    console.log(
      `✅ ${res.successCount} adet bildirim gönderildi`
    );

  } catch (e) {
    console.error("❌ FCM Hatası:", e.message);
  }
}

} 
async function checkEarthquakes() {
  if (Date.now() - lastRun < CHECK_INTERVAL_MS) return;
  if (isProcessing) return;

  lastRun = Date.now();
  isProcessing = true;

  try {
    const [usgs, kandilli] = await Promise.all([
      getUsgsDepremler(),
      getKandilliDepremler(),
    ]);

    const all = mergeEarthquakes(usgs, kandilli);
    console.log(`Veri cekildi: USGS=${usgs.length}, Kandilli=${kandilli.length}, Toplam=${all.length}`);

    for (const eq of all) {
      const id = eq.id || eq.earthquake_id || `${eq.source}_${eq.lat}_${eq.lon}_${eq.mag}`;
      const mag = Number(eq.mag || eq.magnitude || 0);
      const alreadySent = await checkAndMarkSent(id, mag);
      if (!alreadySent) await sendNotification(eq);
    }
  } catch (error) {
    console.error("Genel deprem kontrol hatasi:", error.message);
  } finally {
    isProcessing = false;
  }
}

app.get("/", (req, res) => {
  res.send("Deprem API aktif");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    processing: isProcessing,
    time: new Date().toISOString(),
  });
});

app.get("/api/kandilli", async (req, res) => {
  const result = await getKandilliDepremler();
  res.json({
    status: true,
    source: "kandilli",
    count: result.length,
    result,
  });
});

app.get("/api/usgs", async (req, res) => {
  const result = await getUsgsDepremler();
  res.json({
    status: true,
    source: "usgs",
    count: result.length,
    result,
  });
});

app.get("/api/earthquakes", async (req, res) => {
  const [usgs, kandilli] = await Promise.all([
    getUsgsDepremler(),
    getKandilliDepremler(),
  ]);

  const result = mergeEarthquakes(usgs, kandilli);

  res.json({
    status: true,
    sources: {
      usgs: usgs.length,
      kandilli: kandilli.length,
    },
    count: result.length,
    result,
  });
});

setInterval(checkEarthquakes, CHECK_INTERVAL_MS);
checkEarthquakes();

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server ${PORT} portunda aktif`);
});
