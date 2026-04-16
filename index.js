const admin = require("firebase-admin");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cron = require("node-cron");
const express = require("express");

const app = express();

// 🔐 Firebase
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🌍 MESAFE HESABI (KM)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 🔹 Kullanıcıları çek
async function getUsers() {
  const snapshot = await db.collection("users").get();
  return snapshot.docs.map(doc => doc.data());
}

// 🔹 Deprem verisi çek
async function fetchEarthquakes() {
  const res = await fetch(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
  );
  const data = await res.json();
  return data.features || [];
}

// 🔥 DAHA ÖNCE GÖNDERİLDİ Mİ?
async function isAlreadySent(id) {
  const doc = await db.collection("sent").doc(id).get();
  return doc.exists;
}

// 🔥 GÖNDERİLDİ OLARAK KAYDET
async function markAsSent(id) {
  await db.collection("sent").doc(id).set({
    sent: true,
    time: Date.now(),
  });
}

// 🔥 BİLDİRİM GÖNDER
async function sendNotification(eq) {
  const users = await getUsers();

  const mag = eq.properties.mag;
  const place = eq.properties.place;
  const lat = eq.geometry.coordinates[1];
  const lon = eq.geometry.coordinates[0];

  let sentCount = 0; // 🔥 kaç kişiye gitti

  for (let user of users) {
    if (!user.token) continue;

    // 🔥 KULLANICI FİLTRESİ
    const minMag = user.minMag || 1.0;
    const maxDist = user.maxDist || 15000;

    if (mag < minMag) continue;

    // 🔥 MESAFE KONTROLÜ
    if (user.lat && user.lon && maxDist < 15000) {
      const dist = getDistance(user.lat, user.lon, lat, lon);
      if (dist > maxDist) continue;
    }

    const message = {
      token: user.token,
      notification: {
        title: `🚨 ${mag} Deprem`,
        body: place,
      },
      data: {
        mag: mag.toString(),
        place: place,
        lat: lat.toString(),
        lon: lon.toString(),
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "earthquake_channel",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };

    try {
      await admin.messaging().send(message);
      sentCount++;
    } catch (err) {
      console.log("❌ Bildirim hatası:", err.message);

      // 🔥 INVALID TOKEN SİL
      if (err.message.includes("registration token is not a valid")) {
        const snapshot = await db.collection("users")
          .where("token", "==", user.token)
          .get();

        snapshot.forEach(doc => doc.ref.delete());

        console.log("🧹 Geçersiz token silindi");
      }
    }
  }

  console.log(`📨 ${sentCount} kişiye gönderildi → ${place}`);
}

// 🔹 ANA KONTROL
async function checkEarthquakes() {
  try {
    console.log("🔍 Deprem kontrol...");

    const quakes = await fetchEarthquakes();

    for (let eq of quakes) {
      const id = eq.id;
      const mag = eq.properties.mag;

      // 🔥 DAHA ÖNCE GİTTİYSE ATLA
      if (await isAlreadySent(id)) continue;

      if (mag >= 2.5) {
        console.log("⚠️ Yeni deprem:", eq.properties.place);

        await sendNotification(eq);

        // 🔥 ARTIK KAYDET
        await markAsSent(id);
      }
    }
  } catch (e) {
    console.error("❌ HATA:", e.message);
  }
}

// 🚀 başlangıç
console.log("🚀 PRO sistem çalışıyor...");
checkEarthquakes();

// ⏱️ her 30 saniye
cron.schedule("*/30 * * * * *", checkEarthquakes);

// 🌐 server
app.get("/", (req, res) => {
  res.send("PRO Deprem sistemi aktif 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🌐 Server:", PORT);
});