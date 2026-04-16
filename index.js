const admin = require("firebase-admin");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const cron = require("node-cron");
const express = require("express");

const app = express();

// 🔐 ENV KONTROL
if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error("❌ GOOGLE_CREDENTIALS eksik!");
}

// 🔐 MULTILINE JSON FIX (EN KRİTİK)
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

// 🔥 RAM CACHE
const sentCache = new Set();

// 🧹 CACHE TEMİZLE (1 saat)
setInterval(() => {
    sentCache.clear();
    console.log("🧹 RAM cache temizlendi");
}, 1000 * 60 * 60);

/**
 * 📏 Mesafe (Haversine)
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
 * 🔒 Duplicate kontrol (Firestore + RAM)
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

    // 🌍 GLOBAL (BEDAVA)
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

        console.log("🌍 GLOBAL GÖNDERİLDİ");
        return;
    }

    // 💸 KÜÇÜK DEPREM → PAS
    if (mag < 3.5) return;

    // 🔥 SADECE GEREKLİ ALANLAR
    const snapshot = await db
        .collection("users")
        .select("token", "lat", "lon", "minMag", "maxDist")
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
    });

    // 🔥 BATCH SEND
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

    // 🧹 TOKEN TEMİZLE (maliyet azaltılmış)
    if (invalidTokens.length > 0) {
        console.log(`🧹 ${invalidTokens.length} token siliniyor`);

        const snapshot = await db.collection("users").get();

        snapshot.forEach(doc => {
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

// ⏱️ HER DAKİKA (STABİL)
cron.schedule("0 * * * * *", checkEarthquakes);

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