console.log("🔥 VERSION: FINAL-PRODUCTION-GÜNCEL");

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
// 📏 MESAFE (Haversine)
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
// 🔔 NOTIFICATION ENGINE
// ======================
async function sendNotification(eq) {
    const mag = Number(eq.properties.mag || 0);
    const place = String(eq.properties.place || "Deprem");
    const source = eq.properties.source || "usgs";

    const [lon, lat, depthRaw] = eq.geometry.coordinates;
    const depth = Math.round(depthRaw || 0);
    const quakeTime = eq.properties.time || Date.now();

    console.log(`📨 İşlem Başladı: ${source.toUpperCase()} | Şiddet: ${mag} | Yer: ${place}`);

    const snapshot = await db.collection("users")
        .where("pushActive", "==", true)
        .select(
            "token", "lat", "lon", "notificationsEnabled", "alarmEnabled",
            "isPremium", "premiumUntil", "minMag", "maxDist", "alarmMag", "alarmDist"
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

        // 🇹🇷 Türkiye sınırları kontrolü (Kandilli ve AFAD için yerel kısıtlama)
        if (source === "kandilli" || source === "afad") {
            const isTR = userLat >= 34 && userLat <= 44 && userLon >= 24 && userLon <= 47; 
            if (!isTR) return;
        }

        let sendNotificationFlag = false;
        let sendAlarmFlag = false;

        // Premium Kontrolü
        let isPremium = user.isPremium === true;
        if (user.premiumUntil) {
            try {
                const until = user.premiumUntil.toDate();
                isPremium = until > new Date();
            } catch (e) {
                console.log("⚠️ premiumUntil parse hatası:", e.message);
            }
        }

        if (isPremium) {
            // 💎 PREMIUM KULLANICI FİLTRESİ
            const notifMinMag = Number(user.minMag || 1.0);
            const notifMaxDist = Number(user.maxDist || 500);
            const alarmMinMag = Number(user.alarmMag ?? 4.5);
            const alarmMaxDist = Number(user.alarmDist ?? 500);
            const alarmEnabled = user.alarmEnabled === true;

            // Normal bildirim kriteri uyumu
            if (notificationsEnabled && mag >= notifMinMag && distance <= notifMaxDist) {
                sendNotificationFlag = true;
            }

            // Siren/Alarm çalma kriteri uyumu
            if (alarmEnabled && mag >= alarmMinMag && distance <= alarmMaxDist) {
                sendNotificationFlag = true;
                sendAlarmFlag = true;
            }
        } else {
            // 🆓 ÜCRETSİZ KULLANICI FİLTRESİ (Sabit Ayar)
            if (notificationsEnabled && mag >= 3.0 && distance <= 500) {
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
                open_alarm: sendAlarmFlag ? "true" : "false" // Siren çalma tetikleyicisi
            },
            android: { 
                priority: "high"
            }
        });
    });

    if (messages.length === 0) {
        console.log("ℹ️ Kriterlere uyan kullanıcı bulunamadı.");
        return;
    }

    // Toplu FCM Gönderimi (Batching 500)
    for (let i = 0; i < messages.length; i += 500) {
        const chunk = messages.slice(i, i + 500);
        try {
            const res = await admin.messaging().sendEach(chunk);
            const invalidTokens = [];
            res.responses.forEach((r, idx) => {
                if (!r.success) {
                    const err = r.error?.code;
                    if (err === "messaging/registration-token-not-registered" || 
                        err === "messaging/invalid-registration-token") {
                        invalidTokens.push(chunk[idx].token);
                    }
                }
            });
            
            if (invalidTokens.length > 0) {
                console.log(`🧹 ${invalidTokens.length} adet geçersiz token temizleniyor...`);
                await cleanInvalidTokens(invalidTokens);
            }
            console.log(`✅ ${res.successCount} adet bildirim başarıyla iletildi.`);
        } catch (e) {
            console.error("❌ FCM Batch Hatası:", e.message);
        }
    }
}

// ======================
// 🔍 LOOP ENGINE
// ======================
async function checkEarthquakes() {
    if (Date.now() - lastRun < 15000) return;
    if (isProcessing) return;

    lastRun = Date.now();
    isProcessing = true;

    try {
        // 🚀 AFAD API DA DAHİL EDİLEREK PARALEL VERİ ÇEKME AKIŞI OLUŞTURULDU
        const urls = [
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
            "https://api.orhanaydogdu.com.tr/deprem/kandilli/live",
            "https://api.orhanaydogdu.com.tr/deprem/afad/live"
        ];

        const responses = await Promise.all(
            urls.map(url => fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).timeout(8000).catch(() => null))
        );

        const usgsJson = responses[0] ? await responses[0].json().catch(() => null) : null;
        const kandilliJson = responses[1] ? await responses[1].json().catch(() => null) : null;
        
        // AFAD için yedekli kontrol mimarisi
        let afadJson = responses[2] ? await responses[2].json().catch(() => null) : null;
        if (!afadJson || afadJson.status === false) {
            console.log("⚠️ Ana AFAD API yanıt vermedi, yedek sunucudan (Sismik Harita) veri çekiliyor...");
            const backupRes = await fetch("https://sismikharita.com/api/earthquakes").timeout(6000).catch(() => null);
            if (backupRes) afadJson = await backupRes.json().catch(() => null);
        }

        // 🌍 1. USGS VERİLERİ
        if (usgsJson && usgsJson.features) {
            for (const eq of usgsJson.features) {
                const [lon, lat, depthRaw] = eq.geometry.coordinates;
                const mag = Number(eq.properties.mag || 0);
                const id = `usgs_${eq.id}`;
                
                const sent = await checkAndMarkSent(id, mag);
                if (!sent) {
                    await sendNotification({
                        geometry: { coordinates: [lon, lat, depthRaw] },
                        properties: { mag, place: eq.properties.place, source: "usgs", time: eq.properties.time }
                    });
                }
            }
        }

        // 🇹🇷 2. AFAD VERİLERİ (ÖNCELİKLİ YEREL AYRIŞTIRICI)
        if (afadJson) {
            const afadList = afadJson.data || (Array.isArray(afadJson) ? afadJson : []);
            for (const eq of afadList) {
                if (eq.provider && eq.provider.toLowerCase() !== 'afad') continue; // Yedek sunucu için filtre

                const lat = Number(eq.latitude);
                const lon = Number(eq.longitude);
                const mag = Number(eq.mag || eq.magnitude || 0);
                const depth = Number(eq.depth || 0);

                if (!lat || !lon || !mag) continue;

                const id = `afad_${eq.earthquake_id || eq.eventID || `${lat}_${lon}_${mag}`}`;
                const sent = await checkAndMarkSent(id, mag);

                if (!sent) {
                    const place = eq.title || eq.location || "Türkiye";
                    const time = eq.date_time ? new Date(eq.date_time).getTime() : Date.now();

                    await sendNotification({
                        geometry: { coordinates: [lon, lat, depth] },
                        properties: { mag, place, source: "afad", time }
                    });
                }
            }
        }

        // 🇹🇷 3. KANDİLLİ VERİLERİ
        if (kandilliJson && kandilliJson.result) {
            for (const eq of kandilliJson.result) {
                try {
                    const mag = parseFloat(eq.mag || eq.ml || eq.md);
                    if (isNaN(mag)) continue;

                    // Koordinat çekimleri hata korumalı hale getirildi
                    const lat = Number(eq.latitude || eq.geojson?.coordinates?.[1] || eq.lat);
                    const lon = Number(eq.longitude || eq.geojson?.coordinates?.[0] || eq.lng);
                    const depth = Number(eq.depth || 0);

                    if (!lat || !lon) continue;

                    const id = `kandilli_${lat}_${lon}_${mag}`;
                    const sent = await checkAndMarkSent(id, mag);

                    if (!sent) {
                        let cleanPlace = eq.title || eq.location || "Türkiye";
                        cleanPlace = cleanPlace.replace(/^ML\s*\d+(\.\d+)?\s*-\s*/i, "").replace(/^\d+(\.\d+)?\s*-\s*/i, "").trim();

                        if (!cleanPlace || cleanPlace.length < 3) {
                            cleanPlace = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
                        }

                        const time = eq.date ? new Date(eq.date).getTime() : Date.now();

                        await sendNotification({
                            geometry: { coordinates: [lon, lat, depth] },
                            properties: { mag, place: cleanPlace, source: "kandilli", time }
                        });
                    }
                } catch (err) {
                    console.error("❌ KANDİLLİ TEKİL HATA:", err.message);
                }
            }
        }

    } catch (e) {
        console.error("❌ GENEL ENGINE HATASI:", e.message);
    } finally {
        isProcessing = false; // Kilit açma koruması her durumda çalışır
    }
}

// ======================
cron.schedule("*/45 * * * * *", checkEarthquakes);

// ======================
app.get("/", (req, res) => res.send("Deprem Push Bildirim Servisi Aktif 🚀"));

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        processing: isProcessing,
        time: new Date()
    });
});

// ======================
// 🧪 TEST ENDPOINT
// ======================
app.get("/test", async (req, res) => {
    try {
        console.log("🧪 TEST ALARM GÖNDERİLİYOR...");
        const userSnap = await db.collection("users")
            .where("pushActive", "==", true)
            .where("notificationsEnabled", "==", true)
            .limit(1)
            .get();

        if (userSnap.empty) {
            return res.send("Aktif kullanıcı bulunamadı");
        }

        const testUser = userSnap.docs[0].data();

        if (!testUser.token) {
            return res.send("Test kullanıcısında token yok");
        }
        await admin.messaging().send({
            token: testUser.token,
            android: {
                priority: "high"
            },
            data: {
                id: "test_alarm_123",
                title: "🚨 TEST ALARMI",
                body: "Bu bir simülasyon alarmıdır.",
                mag: "6.0",
                lat: "39.9",
                lon: "32.8",
                depth: "10",
                time: String(Date.now()),
                open_alarm: "true",
                source: "test"
            }
        });

        res.send("🚨 Test push başarıyla gönderildi.");

    } catch (e) {
        console.error("❌ TEST HATA:", e);
        res.send("Hata: " + e.message);
    }
});

// ======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server ${PORT} portunda aktif`);
});