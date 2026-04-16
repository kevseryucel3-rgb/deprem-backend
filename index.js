const admin = require("firebase-admin");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cron = require("node-cron");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let lastEarthquakeTime = 0;

// 🔹 Firestore'dan kullanıcıları çek
async function getUsers() {
  const snapshot = await db.collection("users").get();
  const users = [];

  snapshot.forEach(doc => {
    users.push(doc.data());
  });

  return users;
}

// 🔹 Deprem verisini çek
async function fetchEarthquakes() {
  const res = await fetch(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
  );
  const data = await res.json();
  return data.features;
}

// 🔥 GELİŞMİŞ BİLDİRİM (SES + ÖNEMLİ)
async function sendNotification(eq) {
  const users = await getUsers();

  const mag = eq.properties.mag;
  const place = eq.properties.place;

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
          priority: "max",
          defaultSound: true,
        },
      },

      apns: {
        payload: {
          aps: {
            sound: "default",
            contentAvailable: true,
          },
        },
      },
    };

    try {
      await admin.messaging().send(message);
      console.log("✅ Bildirim gitti:", user.token);
    } catch (err) {
      console.log("❌ Hata:", err.message);
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
    console.error("❌ HATA:", e);
  }
}

console.log("🚀 Deprem sistemi çalışıyor...");

// 🔥 TEST BİLDİRİMİ
setTimeout(() => {
  sendNotification({
    properties: {
      mag: 5.5,
      place: "TEST DEPREMİ",
    },
  });
}, 5000);

// 🔹 Her 30 saniyede çalıştır
cron.schedule("*/30 * * * * *", checkEarthquakes);