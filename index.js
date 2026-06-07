console.log("🔥 VERSION: FINAL-PRODUCTION-FIXED");

const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch");
const { getKandilliDepremler } = require("./services/kandilliService");
const app = express();

app.use(express.json());

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

    for (let i = 0; i < tokens.length; i += 10) {
        const chunk = tokens.slice(i, i + 10);

        const snap = await db.collection("users")
            .where("token", "in", chunk)
            .get();

        if (snap.empty) continue;

        const batch = db.batch();

        snap.forEach(doc => {
            batch.update(doc.ref, {
                token: admin.firestore.FieldValue.delete(),
                pushActive: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        await batch.commit();
    }
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
    const quakeTime = eq.properties.time || Date.now();

    console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

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

    snapshot.forEach(doc => {
        const user = doc.data();

        if (!user.token) return;

        const notificationsEnabled = user.notificationsEnabled === true;
        const alarmEnabledGlobal = user.alarmEnabled === true;

        if (!notificationsEnabled && !alarmEnabledGlobal) return;

        if (user.lat === undefined || user.lon === undefined || user.lat === null || user.lon === null) return;

        const userLat = Number(user.lat);
        const userLon = Number(user.lon);
        if (isNaN(userLat) || isNaN(userLon)) return;

        const distance = getDistance(userLat, userLon, lat, lon);

        // 🇹🇷 KANDİLLİ ÖZEL KURALI
        if (source === "kandilli") {
            const isTR = userLat >= 34 && userLat <= 44 && userLon >= 24 && userLon <= 47; 
            if (!isTR) return;
        }
       
        let sendNotificationFlag = false;
        let sendAlarmFlag = false;

        let isPremium = user.isPremium === true;
        if (user.premiumUntil) {
            try {
                const until = user.premiumUntil.toDate();
                isPremium = until > new Date();
            } catch (e) {}
        }

        if (isPremium) {
            const notifMinMag = Number(user.minMag || 1);
            const notifMaxDist = Number(user.maxDist || 500);
            const alarmMinMag = Number(user.alarmMag ?? 4.5);
            const alarmMaxDist = Number(user.alarmDist ?? 15000);
            const alarmEnabled = user.alarmEnabled === true;

            if (mag >= notifMinMag && distance <= notifMaxDist) {
                sendNotificationFlag = true;
            }

            if (alarmEnabled && mag >= alarmMinMag && distance <= alarmMaxDist) {
                sendNotificationFlag = true;
                sendAlarmFlag = true;
            }
        } else {
            // Ücretsiz Kullanıcı
            if (mag >= 2.0 && distance <= 1200) {
                sendNotificationFlag = true;
            }
        }

        if (!sendNotificationFlag) return;

        const safeMag = isNaN(mag) ? 0 : mag;
        const safePlace = place && place.length > 2 ? place : "Bilinmeyen konum";
        const safeDistance = distance || 0;
        const safeDepth = depth || 0;

        messages.push({
            token: user.token,
            data: {
                title: `${safeMag.toFixed(1)} Deprem`,
                body: `${safePlace} • ${safeDistance} km • ${safeDepth} km`,
                place: safePlace,
                mag: String(safeMag),
                lat: String(lat),
                lon: String(lon),
                depth: String(safeDepth),
                distance: String(safeDistance),
                source: source,
                time: String(quakeTime),
                open_alarm: sendAlarmFlag ? "true" : "false"
            },
            android: { 
                priority: "high"
            }
        });
    });

    if (messages.length === 0) return;

    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);
        try {
            const res = await admin.messaging().sendEach(batch);
            const invalidTokens = [];
            res.responses.forEach((r, idx) => {
                if (!r.success) {
                    const err = r.error?.code;
                    if (err === "messaging/registration-token-not-registered" || 
                        err === "messaging/invalid-registration-token") {
                        invalidTokens.push(batch[idx].token);
                    }
                }
            });
            
            if (invalidTokens.length > 0) {
                await cleanInvalidTokens(invalidTokens);
            }
            console.log(`✅ ${res.successCount} adet bildirim iletildi.`);
        } catch (e) {
            console.error("❌ FCM Batch Hatası:", e.message);
        }
    }
}

// ======================
// 🔍 LOOP (KRONOMETRE)
// ======================
async function checkEarthquakes() {
    if (Date.now() - lastRun < 15000) return;
    if (isProcessing) return;

    lastRun = Date.now();
    isProcessing = true;

    try {
        const [usgsRes, kandilliList] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson").then(r => r.json()).catch(() => ({ features: [] })),
            getKandilliDepremler().catch(() => []) // İç metottan doğrudan temiz array alıyoruz
        ]);

        const usgsList = usgsRes.features || [];
        console.log(`📡 Döngü Tetiklendi | USGS: ${usgsList.length} | Kandilli: ${kandilliList.length}`);

        // 🌍 USGS DÖNGÜSÜ
        for (const eq of usgsList) {
            const [lon, lat, depthRaw] = eq.geometry.coordinates;
            const mag = Number(eq.properties.mag || 0);
            const id = `usgs_${eq.id}`;
            
            const sent = await checkAndMarkSent(id, mag);
            if (!sent) {
                await sendNotification({
                    ...eq,
                    geometry: { coordinates: [lon, lat, depthRaw] },
                    properties: { ...eq.properties, source: "usgs" }
                });
            }
        }

        // 🇹🇷 KANDİLLİ DÖNGÜSÜ
        if (Array.isArray(kandilliList)) {
            for (const eq of kandilliList) {
                try {
                    const mag = parseFloat(eq.mag || eq.magnitude || 0);
                    if (isNaN(mag) || mag <= 0) continue;

                    const lat = Number(eq.latitude || eq.lat);
                    const lon = Number(eq.longitude || eq.lon || eq.lng);
                    const depth = Number(eq.depth || 0);

                    if (!lat || !lon) continue;

                    const id = `kandilli_${lat}_${lon}_${mag}`;
                    const sent = await checkAndMarkSent(id, mag);

                    if (!sent) {
                        let cleanPlace = eq.title || eq.location || eq.place || "Türkiye";
                        cleanPlace = cleanPlace.replace(/^ML\s*\d+(\.\d+)?\s*-\s*/i, "").trim();

                        await sendNotification({
                            properties: {
                                mag: mag,
                                place: cleanPlace,
                                source: "kandilli",
                                time: String(eq.time || Date.now())
                            },
                            geometry: {
                                coordinates: [lon, lat, depth]
                            }
                        });
                    }
                } catch (err) {
                    console.error("❌ KANDİLLİ LOOP HATA:", err.message);
                }
            }
        }
    } catch (e) {
        console.error("❌ GENEL HATA:", e.message);
    } finally {
        isProcessing = false;
    }
}

// ======================
cron.schedule("*/45 * * * * *", checkEarthquakes);

// ======================
app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        processing: isProcessing,
        time: new Date()
    });
});

// 🌟 FLUTTER'IN HEM LİSTELEME HEM DE TİP GÜVENLİĞİ İÇİN FIX EDİLEN ROUTE
app.get("/api/kandilli", async (req, res) => {
    try {
        const data = await getKandilliDepremler();
        
        // Flutter uygulamasının çökmemesi ve map'te görebilmesi için veriyi normalize ediyoruz
        const cleanData = (data || []).map(eq => ({
            ...eq,
            mag: Number(eq.mag || eq.magnitude || 0),
            magnitude: Number(eq.mag || eq.magnitude || 0),
            latitude: Number(eq.lat || eq.latitude || 0),
            lat: Number(eq.lat || eq.latitude || 0),
            longitude: Number(eq.lon || eq.longitude || eq.lng || 0),
            lon: Number(eq.lon || eq.longitude || eq.lng || 0),
            // Flutter'ın double.tryParse(e['lng']) yapısı için kritik field:
            lng: Number(eq.lon || eq.longitude || eq.lng || 0), 
            depth: Number(eq.depth || 0),
            title: String(eq.title || eq.location || eq.place || "Türkiye"),
            place: String(eq.title || eq.location || eq.place || "Türkiye"),
            date: eq.date || eq.date_time || new Date().toISOString(),
            // Flutter'ın 'geojson' null check'ini geçmesi için koordinatları gömüyoruz
            geojson: eq.geojson ? eq.geojson : {
                type: "Point",
                coordinates: [
                    Number(eq.longitude || eq.lon || eq.lng || 0),
                    Number(eq.latitude || eq.lat || 0)
                ]
            }
        }));

        // 🎯 FLUTTER'IN ARADIĞI 'status' VE 'result' SARMALINI BURADA OLUŞTURUYORUZ
        res.setHeader("Content-Type", "application/json");
        res.json({
            status: true,        // Flutter'ın if kontrolü için
            source: "kandilli",
            count: cleanData.length,
            result: cleanData    // Flutter'ın döngüye soktuğu array
        }); 
    } catch (err) {
        console.error("❌ Kandilli API Hatası:", err);
        res.status(500).json({ 
            status: false, 
            error: err.message,
            result: [] 
        });
    }
});

// ======================
// 🧪 TEST ENDPOINT
// ======================
app.get("/test", async (req, res) => {
    try {
        const userSnap = await db.collection("users").where("pushActive", "==", true).limit(1).get();
        if (userSnap.empty) return res.send("Aktif kullanıcı bulunamadı");

        const testUser = userSnap.docs[0].data();
        await admin.messaging().send({
            token: testUser.token,
            android: { priority: "high" },
            data: {
                id: "test_" + Date.now(),
                title: "🚨 BİLDİRİM TESTİ",
                body: "Sistem test bildirimi başarıyla tetiklendi.",
                mag: "4.8",
                lat: "38.4",
                lon: "27.2",
                depth: "7",
                distance: "120",
                open_alarm: "false",
                source: "test",
                time: String(Date.now())
            }
        });
        res.send("🚨 Test bildirimi gönderildi.");
    } catch (e) {
        res.send("Hata: " + e.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server ${PORT} portunda aktif`);
});