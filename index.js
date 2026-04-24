console.log("🔥 VERSION: 7777");
const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch"); // 🔥 EKLENDİ

const app = express();
app.use((req, res, next) => {
    console.log("🌐 HIT:", req.url);
    next();
});
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

// 🔥 RENDER SLEEP ENGELLE (KEEP ALIVE)
setInterval(() => {
    fetch("https://deprem-backend-hqbp.onrender.com/health");
    console.log("🔄 keep-alive ping");
}, 1000 * 60 * 5);


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
async function checkAndMarkSent(id, newMag) {

    const docRef = db.collection("sent").doc(id);

    return await db.runTransaction(async (transaction) => {

        const doc = await transaction.get(docRef);

        if (doc.exists) {

            const oldMag = doc.data().mag || 0;

            // ❌ aynı magnitude → gönderme
            if (newMag === oldMag) {
                return true;
            }

            // ✅ farklıysa → gönder ve güncelle
            transaction.update(docRef, {
                mag: newMag,
                time: admin.firestore.FieldValue.serverTimestamp()
            });

            return false;
        }

        // 🆕 ilk kayıt
        transaction.set(docRef, {
            mag: newMag,
            time: admin.firestore.FieldValue.serverTimestamp()
        });

        return false;
    });
}
async function sendNotification(eq) {
    const mag = Number(eq.properties?.mag || 0);
    const place = eq.properties?.place || "Deprem";
    const coords = eq.geometry?.coordinates || [];
    const source = eq.properties?.source || "usgs";

    if (coords.length < 2) return;

    const lon = coords[0];
    const lat = coords[1];

    // =========================
    // 🌍 GLOBAL (SADECE 6.8 ALTINDA)
    // =========================
    if (mag >= 1.0 && mag < 6.8) {

        console.log("🌍 GLOBAL:", mag, place);

        try {
            await admin.messaging().send({
                topic: "global",

                notification: {
                    title: source === "kandilli"
                        ? `🇹🇷 ${mag} Kandilli Deprem`
                        : `🌍 ${mag} Deprem`,
                    body: place
                },

                android: {
                    priority: "high",
                    ttl: 3600,
                    notification: {
                        channelId: "earthquake_channel"
                    }
                },

                data: {
    mag: mag.toString(),
    place,
    lat: lat.toString(),
    lon: lon.toString(),
    depth: eq.properties?.depth?.toString() || "0",
    time: eq.properties?.time || "",
    open_alarm: "false",
    source
}
            });

        } catch (e) {
            console.error("❌ Global gönderim hatası:", e.message);
        }
    }

    // =========================
    // 🚨 6.8+ → GLOBAL YOK
    // =========================
    if (mag < 3.0) return;

    const snapshot = await db
        .collection("users")
        .select("token", "lat", "lon", "minMag", "maxDist", "isPremium")
        .limit(2000)
        .get();

    if (snapshot.empty) return;

    const messages = [];
    const invalidTokens = [];

    snapshot.forEach(doc => {
        const user = doc.data();
        if (!user.token) return;

        const userLat = Number(user.lat || 0);
        const userLon = Number(user.lon || 0);

        if (!userLat || !userLon) return;

        const distance = getDistance(userLat, userLon, lat, lon);

        // 🇹🇷 KANDİLLİ → SADECE TÜRKİYE
        if (source === "kandilli") {
            const isInTurkey =
                userLat >= 36 && userLat <= 42 &&
                userLon >= 26 && userLon <= 45;

            if (!isInTurkey) return;
        }

        let openAlarm = "false";

        // 🟢 FREE
        if (!user.isPremium) {
            if (mag < 2.0) return;
            if (distance > 1200) return;
        }

        // 🔴 PREMIUM
        if (user.isPremium) {
            const minMag = Number(user.minMag || 1.0);
            const maxDist = Number(user.maxDist || 500);

            if (mag < minMag) return;
            if (distance > maxDist) return;

            openAlarm = "true";
        }

        messages.push({
            token: user.token,

            notification: {
                title: source === "kandilli"
                    ? `🇹🇷 ${mag} Kandilli Deprem`
                    : `🌍 ${mag} Deprem`,
                body: place
            },

            android: {
                priority: "high",
                ttl: 3600,
                notification: {
                    channelId: "earthquake_channel"
                }
            },

            data: {
    mag: mag.toString(),
    place,
    lat: lat.toString(),
    lon: lon.toString(),
    depth: eq.properties?.depth?.toString() || "0",
    time: eq.properties?.time || "",
    open_alarm: openAlarm,
    source
}
        });
    });

    // 🚀 BATCH
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);

        try {
            const response = await admin.messaging().sendEach(batch);
            console.log(`✅ ${response.successCount} mesaj gönderildi`);

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
            console.error("❌ FCM Batch hatası:", error.message);
        }
    }

    // 🧹 TOKEN CLEANUP
    if (invalidTokens.length > 0) {
        console.log(`🧹 ${invalidTokens.length} geçersiz token temizleniyor...`);
        const dbBatch = db.batch();

        for (const token of invalidTokens) {
            const userDocs = await db.collection("users")
                .where("token", "==", token)
                .get();

            userDocs.forEach(doc => dbBatch.delete(doc.ref));
        }

        await dbBatch.commit();
        console.log("✅ Geçersiz tokenlar silindi.");
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

        // 🔥 USGS + KANDİLLİ
        const [usgsRes, kandilliRes] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"),
            fetch("https://api.orhanaydogdu.com.tr/deprem/kandilli/live")
        ]);

        const usgsData = await usgsRes.json();
        const kandilliData = await kandilliRes.json();

        const usgsQuakes = usgsData.features || [];
        const kandilliQuakes = kandilliData.result || [];
        console.log("📡 Kandilli veri sayısı:", kandilliQuakes.length);
        // 🌍 USGS
        for (const eq of usgsQuakes) {
            const mag = Number(eq.properties?.mag || 0);

            if (mag < 2.0) continue;

            if (!eq.geometry || !eq.geometry.coordinates || eq.geometry.coordinates.length < 2) {
                continue;
            }

            // 🔥 %100 TEKİL ID
            if (!eq.id) continue;
            const uniqueId = "usgs_" + eq.id;

            const alreadySent = await checkAndMarkSent(uniqueId, mag);

            if (!alreadySent) {
                console.log(`🌍 USGS: ${eq.properties.place} (${mag})`);
                await sendNotification(eq);
            }
        }

        // 🇹🇷 KANDİLLİ
        for (const eq of kandilliQuakes) {

            const mag = Number(eq.mag || 0);
            if (mag < 1.0) continue;

            const lat = Number(eq.geojson?.coordinates?.[1] || eq.lat);
            const lon = Number(eq.geojson?.coordinates?.[0] || eq.lng);

            if (!lat || !lon) continue;

            // 🔥 %100 TEKİL ID
            if (!eq._id) continue;
            const uniqueId = "kandilli_" + eq._id + "_" + Math.floor(mag * 10);

            const alreadySent = await checkAndMarkSent(uniqueId, mag);

            if (!alreadySent) {

                console.log(`🇹🇷 KANDİLLİ: ${eq.title} (${mag})`);

              await sendNotification({
    properties: {
        mag: mag,
        place: eq.title,
        source: "kandilli",
        depth: eq.depth,        // 🔥 EKLE
        time: eq.date           // 🔥 EKLE
    },
    geometry: {
        coordinates: [lon, lat]
    }
});
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

// 🧪 TEST (ALARM ZORLA)
app.get("/test", async (req, res) => {
    try {
        console.log("🧪 TEST ALARM GÖNDERİLİYOR...");

        await admin.messaging().send({
            topic: "global",

            android: {
                priority: "high",
                ttl: 0,
                notification: {
                    channelId: "earthquake_channel"
                }
            },

            data: {
                mag: "5.5",
                lat: "39.9",
                lon: "32.8",
                place: "TEST DEPREM",
                open_alarm: "true" // 🔥 KRİTİK SATIR
            }
        });

        console.log("✅ TEST ALARM GÖNDERİLDİ");

        res.send("🚨 Alarm test gönderildi");

    } catch (e) {
        console.error("❌ TEST HATA:", e);
        res.send("Hata: " + e.message);
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server ${PORT} portunda`);
});