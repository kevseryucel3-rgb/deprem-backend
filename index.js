const admin = require("firebase-admin");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cron = require("node-cron");
const express = require("express");

const app = express();

// 🔐 Firebase Yetkilendirme
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Global Kilit: Aynı anda iki döngünün çalışmasını engeller
let isProcessing = false;

/**
 * Mesafe Hesaplama (Haversine Formülü)
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Daha önce gönderildi mi kontrolü ve anında işaretleme
 */
async function checkAndMarkSent(id) {
    const docRef = db.collection("sent").doc(id);
    return await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (doc.exists) return true; // Zaten gönderilmiş
        
        // Gönderilmemişse hemen işaretle (Aynı anda gelen diğer istekleri bloklar)
        transaction.set(docRef, { sent: true, time: admin.firestore.FieldValue.serverTimestamp() });
        return false;
    });
}

/**
 * Bildirim Gönderme Mantığı
 */
async function sendNotification(eq) {
    const { mag, place } = eq.properties;
    const [lon, lat] = eq.geometry.coordinates;

    const snapshot = await db.collection("users").get();
    if (snapshot.empty) return;

    const messages = [];
    const invalidTokens = [];

    snapshot.forEach(doc => {
        const user = doc.data();
        if (!user.token) return;

        // Filtreler
        const minMag = user.minMag || 3.0;
        const maxDist = user.maxDist || 500;

        if (mag < minMag) return;

        if (user.lat && user.lon) {
            const dist = getDistance(user.lat, user.lon, lat, lon);
            if (dist > maxDist) return;
        }

        messages.push({
            token: user.token,
            notification: { title: `🚨 ${mag} Şiddetinde Deprem`, body: place },
            data: { mag: mag.toString(), place, lat: lat.toString(), lon: lon.toString() },
            android: { priority: "high", notification: { channelId: "earthquake_channel", sound: "default" } },
            apns: { payload: { aps: { sound: "default", critical: 1 } } }
        });
    });

    // Çoklu gönderim (Multicast) - Daha performanslıdır
    if (messages.length > 0) {
        // Firebase mesajları 500'erli gruplar halinde gönderilmelidir
        for (let i = 0; i < messages.length; i += 500) {
            const batch = messages.slice(i, i + 500);
            try {
                const response = await admin.messaging().sendEach(batch);
                console.log(`✅ ${response.successCount} bildirim başarıyla gönderildi.`);
            } catch (error) {
                console.error("❌ Mesaj grubu gönderim hatası:", error);
            }
        }
    }
}

/**
 * Ana Kontrol Döngüsü
 */
async function checkEarthquakes() {
    if (isProcessing) {
        console.log("⏳ Önceki işlem devam ediyor, atlanıyor...");
        return;
    }

    isProcessing = true;
    try {
        console.log("🔍 USGS verileri kontrol ediliyor...");
        const res = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson");
        const data = await res.json();
        const quakes = data.features || [];

        for (const eq of quakes) {
            const mag = eq.properties.mag;
            if (mag < 2.5) continue;

            // Transaction kullanarak hem kontrol et hem işaretle (Çift gönderimi önler)
            const alreadySent = await checkAndMarkSent(eq.id);
            if (!alreadySent) {
                console.log(`⚠️ Yeni deprem algılandı: ${eq.properties.place} (${mag})`);
                await sendNotification(eq);
            }
        }
    } catch (err) {
        console.error("❌ Döngü hatası:", err.message);
    } finally {
        isProcessing = false;
    }
}

// ⏱️ Cron: Her 30 saniyede bir
cron.schedule("*/30 * * * * *", checkEarthquakes);

app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server ${PORT} portunda çalışıyor.`));