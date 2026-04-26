console.log("🔥 VERSION: FINAL-PRODUCTION");

const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch");

const app = express();

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

// ======================
let isProcessing = false;
let lastRun = 0;

// ======================
// 📏 MESAFE
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
// 🔒 DUPLICATE CONTROL
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
                time: admin.firestore.FieldValue.serverTimestamp()
            });

            return false;
        }

        tx.set(ref, {
            mag,
            time: admin.firestore.FieldValue.serverTimestamp()
        });

        return false;
    });
}

// ======================
// 🧹 TOKEN CLEANUP
// ======================
async function cleanInvalidTokens(tokens) {
    if (!tokens.length) return;

    const chunk = tokens.slice(0, 10);

    const snap = await db.collection("users")
        .where("token", "in", chunk)
        .get();

    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
}

// ======================
// 🔔 NOTIFICATION
// ======================
async function sendNotification(eq) {

    const mag = Number(eq.properties.mag || 0);
    const place = String(eq.properties.place || "Deprem");
    const source = eq.properties.source || "usgs";

    const [lon, lat, depthRaw] = eq.geometry.coordinates;
    const depth = Math.round(depthRaw || 0);

    console.log("📨", source, mag, place);

    // ======================
    // 🌍 GLOBAL BÜYÜK
    // ======================
    if (mag >= 5.5) {
        await admin.messaging().send({
            topic: "global",

            data: {
                title: `🚨 ${mag} Büyük Deprem`,
                body: `${place} | ⛏ ${depth} km`,
                mag: String(mag),
                lat: String(lat),
                lon: String(lon),
                depth: String(depth),
                source,
                open_alarm: "true"
            },

            android: { priority: "high" }
        });

        return;
    }

    // ======================
    // 📍 USER FILTER
    // ======================
    const snapshot = await db.collection("users").limit(2000).get();

    const messages = [];

    snapshot.forEach(doc => {

        const user = doc.data();
        if (!user.token) return;

        const userLat = Number(user.lat);
        const userLon = Number(user.lon);
        if (!userLat || !userLon) return;

        const distance = getDistance(userLat, userLon, lat, lon);

        // 🇹🇷 Kandilli sadece TR
        if (source === "kandilli") {
            const isTR =
                userLat >= 36 && userLat <= 42 &&
                userLon >= 26 && userLon <= 45;

            if (!isTR) return;
        }

        let send = false;
        let openAlarm = "false";

        // 🟢 FREE
        if (!user.isPremium) {
            if (mag >= 3.0 && distance <= 300) send = true;
        }

        // 🔴 PREMIUM
        if (user.isPremium) {
            const minMag = Number(user.minMag || 1);
            const maxDist = Number(user.maxDist || 500);

            if (mag >= minMag && distance <= maxDist) {
                send = true;
                openAlarm = "true";
            }
        }

        if (!send) return;

        messages.push({
            token: user.token,

            data: {
                title: source === "kandilli"
                    ? `🇹🇷 ${mag} Kandilli Deprem`
                    : `🌍 ${mag} Deprem`,

                body: `${place}\n📏 ${distance} km | ⛏ ${depth} km`,

                mag: String(mag),
                lat: String(lat),
                lon: String(lon),
                depth: String(depth),
                distance: String(distance),
                source,
                open_alarm: openAlarm
            },

            android: { priority: "high" }
        });
    });

    // ======================
    // 🚀 BATCH
    // ======================
    for (let i = 0; i < messages.length; i += 500) {

        const batch = messages.slice(i, i + 500);

        try {
            const res = await admin.messaging().sendEach(batch);

            const invalidTokens = [];

            res.responses.forEach((r, i) => {
                if (!r.success) {
                    const err = r.error?.code;

                    if (
                        err === "messaging/registration-token-not-registered" ||
                        err === "messaging/invalid-registration-token"
                    ) {
                        invalidTokens.push(batch[i].token);
                    }
                }
            });

            await cleanInvalidTokens(invalidTokens);

            console.log(`✅ ${res.successCount} gönderildi`);

        } catch (e) {
            console.error("❌ FCM:", e.message);
        }
    }
}

// ======================
// 🔍 LOOP
// ======================
async function checkEarthquakes() {

    if (Date.now() - lastRun < 15000) return;
    if (isProcessing) return;

    lastRun = Date.now();
    isProcessing = true;

    try {

        const [usgsRes, kandilliRes] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"),
            fetch("https://api.orhanaydogdu.com.tr/deprem/kandilli/live")
        ]);

        const usgs = await usgsRes.json();
        const kandilli = await kandilliRes.json();

        const usgsList = usgs.features || [];
        const kandilliList = kandilli.result || [];

        console.log("📡 Kandilli:", kandilliList.length);

        // 🌍 USGS
        for (const eq of usgsList) {

            const mag = Number(eq.properties.mag || 0);
            if (mag < 2) continue;
            if (!eq.id) continue;

            const id = "usgs_" + eq.id;

            const sent = await checkAndMarkSent(id, mag);

            if (!sent) {
                await sendNotification({
                    ...eq,
                    properties: {
                        ...eq.properties,
                        source: "usgs"
                    }
                });
            }
        }

        // 🇹🇷 KANDİLLİ
        for (const eq of kandilliList) {

            const mag = parseFloat(eq.mag || eq.ml || eq.md);
            if (isNaN(mag)) continue;

            const lat = Number(eq.geojson?.coordinates?.[1] || eq.lat);
            const lon = Number(eq.geojson?.coordinates?.[0] || eq.lng);
            const depth = Number(eq.depth || 0);

            if (!lat || !lon) continue;
            if (!eq._id) continue;

            const id = "kandilli_" + eq._id;

            const sent = await checkAndMarkSent(id, mag);

            if (!sent) {
                await sendNotification({
                    properties: {
                        mag,
                        place: eq.title,
                        source: "kandilli"
                    },
                    geometry: {
                        coordinates: [lon, lat, depth]
                    }
                });
            }
        }

    } catch (e) {
        console.error("❌ HATA:", e.message);
    }

    isProcessing = false;
}

// ======================
cron.schedule("*/30 * * * * *", checkEarthquakes);

// ======================
app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        processing: isProcessing,
        time: new Date()
    });
});
// ======================
// 🧪 TEST (ALARM ZORLA)
// ======================
app.get("/test", async (req, res) => {
    try {
        console.log("🧪 TEST ALARM GÖNDERİLİYOR...");

        await admin.messaging().send({
            topic: "global",

            android: {
                priority: "high"
            },

            data: {
                title: "🚨 TEST",
                body: "Test alarm",
                mag: "5.5",
                lat: "39.9",
                lon: "32.8",
                depth: "10",
                open_alarm: "true"
            }
        });

        console.log("✅ TEST ALARM GÖNDERİLDİ");

        res.send("🚨 Test gönderildi");

    } catch (e) {
        console.error("❌ TEST HATA:", e);
        res.send("Hata: " + e.message);
    }
});

// ======================
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server ${PORT} portunda`);
});