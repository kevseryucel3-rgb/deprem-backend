const admin = require("firebase-admin");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cron = require("node-cron");
const express = require("express");

const app = express();

// 🔐 Firebase (ENV üzerinden güvenli kullanım)
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let isProcessing = false;

// 🔥 RAM CACHE
const sentCache = new Set();

// 🧹 CACHE TEMİZLE
setInterval(() => {
    sentCache.clear();
    console.log("🧹 RAM cache temizlendi");
}, 1000 * 60 * 60);

/**
 * 📏 Mesafe
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 🔒 Duplicate kontrol
 */
async function checkAndMarkSent(id) {
    if (sentCache.has(id)) return true;

    const docRef = db.collection("sent").doc(id);

    return await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        if (doc.exists) {
            sentCache.add(id);
            return true;
        }

        transaction.set(docRef, {
            sent: true,
            time: admin.firestore.FieldValue.serverTimestamp()
        });

        sentCache.add(id);
        return false;
    });
}

/**
 * 📡 Bildirim gönder
 */
async function sendNotification(eq) {
    const { mag, place } = eq.properties;
    const [lon, lat] = eq.geometry.coordinates;

    // 🌍 GLOBAL FREE (BÜYÜK DEPREM)
    if (mag >= 4.5) {
        await admin.messaging().send({
            topic: "global",
            notification: {
                title: `🚨 ${mag} Deprem`,
                body: place
            },
            data: {
                mag: mag.toString(),
                place,
                lat: lat.toString(),
                lon: lon.toString()
            }
        });

        console.log("🌍 GLOBAL GÖNDERİLDİ (FREE)");
        return;
    }

    // 🔥 🔻 MALİYET OPTİMİZASYONU
    // Küçük depremlerde kullanıcı çekme sayısını azalt
    if (mag < 3.5) {
        console.log("💸 Küçük deprem → kullanıcı sorgusu atlandı");
        return;
    }

    const snapshot = await db.collection("users").get();
    if (snapshot.empty) return;

    const messages = [];
    const invalidTokens = [];

    snapshot.forEach(doc => {
        const user = doc.data();
        if (!user.token) return;

        const minMag = user.minMag || 3.0;
        const maxDist = user.maxDist || 500;

        if (mag < minMag) return;

        if (user.lat && user.lon) {
            const dist = getDistance(user.lat, user.lon, lat, lon);
            if (dist > maxDist) return;
        }

        messages.push({
            token: user.token,
            notification: {
                title: `🚨 ${mag} Şiddetinde Deprem`,
                body: place
            },
            data: {
                mag: mag.toString(),
                place,
                lat: lat.toString(),
                lon: lon.toString()
            },
            android: {
                priority: "high",
                notification: {
                    channelId: "earthquake_channel",
                    sound: "default"
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: "default",
                        contentAvailable: true
                    }
                }
            }
        });
    });

    // 🔥 batch gönder
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);

        try {
            const response = await admin.messaging().sendEach(batch);
            console.log(`✅ ${response.successCount} başarılı`);

            response.responses.forEach((res, idx) => {
                if (!res.success) {
                    const err = res.error?.code;

                    if (
                        err === "messaging/registration-token-not-registered" ||
                        err === "messaging/invalid-registration-token"
                    ) {
                        invalidTokens.push(batch[idx].token);
                    }
                }
            });

        } catch (error) {
            console.error("❌ FCM hata:", error.message);
        }
    }

    // 🧹 token temizleme
    if (invalidTokens.length > 0) {
        console.log(`🧹 ${invalidTokens.length} token siliniyor`);

        const users = await db.collection("users").get();

        users.forEach(doc => {
            const data = doc.data();
            if (invalidTokens.includes(data.token)) {
                doc.ref.delete();
            }
        });
    }
}

/**
 * 🔍 Ana döngü
 */
async function checkEarthquakes() {
    if (isProcessing) {
        console.log("⏳ işlem devam ediyor...");
        return;
    }

    isProcessing = true;

    try {
        console.log("🔍 Deprem kontrol...");

        const res = await fetch(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
        );

        const data = await res.json();
        const quakes = data.features || [];

        for (const eq of quakes) {
            const mag = eq.properties.mag;

            if (mag < 2.5) continue;

            const alreadySent = await checkAndMarkSent(eq.id);

            if (!alreadySent) {
                console.log(`🚨 YENİ: ${eq.properties.place} (${mag})`);
                await sendNotification(eq);
            }
        }

    } catch (err) {
        console.error("❌ HATA:", err.message);
    } finally {
        isProcessing = false;
    }
}

// ⏱️ 60 saniye (maliyet düşürme)
cron.schedule("*/60 * * * * *", checkEarthquakes);

// 🌐 endpoint
app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));

// 🧪 health
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        processing: isProcessing,
        cacheSize: sentCache.size,
        time: new Date()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server ${PORT} portunda`));