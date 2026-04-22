const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch"); // 🔥 EKLENDİ

const app = express();

// 🔐 ENV KONTROL
if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error("❌ GOOGLE_CREDENTIALS eksik!");
}

// 🔐 JSON PARSE
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (err) {
    console.error("❌ JSON parse hatası:", err.message);
    throw new Error("GOOGLE_CREDENTIALS JSON bozuk!");
}

// 🔐 Firebase init
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let isProcessing = false;
let lastRun = 0; // 🔥 COOLDOWN

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

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 🔒 Duplicate kontrol (GELİŞTİRİLDİ)
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
    const mag = Number(eq.properties?.mag || 0);
    const place = eq.properties?.place || "Deprem";
    const coords = eq.geometry?.coordinates || [];

    if (coords.length < 2) return;

    const lon = coords[0];
    const lat = coords[1];

    // 🌍 GLOBAL
    if (mag >= 4.5) {
        console.log("🌍 GLOBAL TRIGGER:", mag, place);

        await admin.messaging().send({
            topic: "global",
            android: { priority: "high" },
            apns: { payload: { aps: { contentAvailable: true } } },
            data: {
                mag: mag.toString(),
                place,
                lat: lat.toString(),
                lon: lon.toString(),
                open_alarm: "true"
            }
        });

        console.log("🌍 GLOBAL GÖNDERİLDİ");
        return;
    }

    // 💸 küçük deprem
    if (mag < 3.5) return;

    const snapshot = await db
        .collection("users")
        .select("token", "lat", "lon", "minMag", "maxDist")
        .limit(2000) // 🔥 PERFORMANCE
        .get();

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
            android: { priority: "high" },
            apns: { payload: { aps: { contentAvailable: true } } },
            data: {
                mag: mag.toString(),
                place,
                lat: lat.toString(),
                lon: lon.toString(),
                open_alarm: "true"
            }
        });
    });

    // 🔥 batch gönderim
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);

        try {
            const response = await admin.messaging().sendEach(batch);

            console.log(`✅ ${response.successCount} gönderildi`);

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

    // 🧹 TOKEN TEMİZLE (OPTİMİZE)
    if (invalidTokens.length > 0) {
        console.log(`🧹 ${invalidTokens.length} token siliniyor`);

        const snapshot = await db.collection("users").get();
        const batch = db.batch();

        snapshot.forEach(doc => {
            const data = doc.data();
            if (invalidTokens.includes(data.token)) {
                batch.delete(doc.ref);
            }
        });

        await batch.commit();
    }
}

/**
 * 🔍 Ana loop
 */
async function checkEarthquakes() {

    const now = Date.now();

    // 🔥 COOLDOWN (spam önler)
    if (now - lastRun < 15000) return;
    lastRun = now;

    if (isProcessing) return;

    isProcessing = true;

    try {
        console.log("🔍 Deprem kontrol...");

        const res = await fetch(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
        );

        const data = await res.json();
        const quakes = data.features || [];

        for (const eq of quakes) {
            const mag = Number(eq.properties?.mag || 0);

            if (mag < 2.5) continue;

            // 🔥 UNIQUE ID (GELİŞTİRİLDİ)
            const uniqueId = `${eq.properties.time}_${eq.geometry.coordinates[0]}_${eq.geometry.coordinates[1]}`;

            const alreadySent = await checkAndMarkSent(uniqueId);

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

// 🔥 HER 30 SANİYE
cron.schedule("*/30 * * * * *", checkEarthquakes);

// 🌐 endpoints
app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        processing: isProcessing,
        cacheSize: sentCache.size,
        time: new Date()
    });
});

// 🧪 TEST
app.get("/test", async (req, res) => {
    try {
        await admin.messaging().send({
            topic: "global",
            android: { priority: "high" },
            data: {
                mag: "5.5",
                lat: "39.9",
                lon: "32.8",
                place: "TEST DEPREM",
                open_alarm: "true"
            }
        });

        res.send("Test gönderildi 🚀");
    } catch (e) {
        res.send("Hata: " + e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server ${PORT} portunda`));