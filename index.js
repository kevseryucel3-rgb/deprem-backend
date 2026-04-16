const admin = require("firebase-admin");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cron = require("node-cron");

// 🔐 Firebase key güvenli kontrol
if (!process.env.FIREBASE_KEY) {
  console.error("❌ FIREBASE_KEY bulunamadı!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// 🔐 Firebase başlat
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let lastEarthquakeTime = 0;
let sentEarthquakes = new Set(); // aynı depremi tekrar atmamak için

// 🔹 Firestore'dan kullanıcıları çek
async function getUsers() {
  try {
    const snapshot = await db.collection("users").get();
    return snapshot.docs.map(doc => doc.data());
  } catch (err) {
    console.error("❌ Kullanıcılar alınamadı:", err.message);
    return [];
  }
}

// 🔹 Deprem verisini çek
async function fetchEarthquakes() {
  try {
    const res = await fetch(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
    );
    const data = await res.json();
    return data.features || [];
  } catch (err) {
    console.error("❌ Deprem verisi alınamadı:", err.message);
    return [];
  }
}

// 🔥 Bildirim gönder
async function sendNotification(eq) {
  const users = await getUsers();

  const mag = eq.properties.mag;
  const place = eq.properties.place;
  const id = eq.id;

  // 🔁 Aynı deprem tekrar gitmesin
  if (sentEarthquakes.has(id)) return;
  sentEarthquakes.add(id);

  for (let user of users) {
    if (!user.token) continue;

    const message = {
      token: user.token,
      notification: {
        title: `🚨 ${mag} Deprem`,
        body: place,
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
      console.log("✅ Bildirim gitti");
    } catch (err) {
      console.log("❌ Bildirim hatası:", err.message);
    }
  }
}

// 🔹 Kontrol sistemi
async function checkEarthquakes() {
  try {
    console.log("🔍 Depremler kontrol ediliyor...");

    const quakes = await fetchEarthquakes();

    for (let eq of quakes) {
      const time = eq.properties.time;

      if (time > lastEarthquakeTime) {
        lastEarthquakeTime = time;

        if (eq.properties.mag >= 2.5) {
          console.log("⚠️ Yeni deprem:", eq.properties.place);
          await sendNotification(eq);
        }
      }
    }
  } catch (e) {
    console.error("❌ HATA:", e.message);
  }
}

console.log("🚀 Deprem sistemi çalışıyor...");

// 🔹 Sistem başlarken 1 kez çalıştır
checkEarthquakes();

// 🔹 Her 60 saniyede çalıştır (daha stabil)
cron.schedule("*/60 * * * * *", checkEarthquakes);
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Deprem sistemi çalışıyor 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server çalışıyor:", PORT);
});