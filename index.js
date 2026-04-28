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

    console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

    // ==========================================
    // 🌍 KURAL 1: GLOBAL BÜYÜK DEPREM (5.5+)
    // ==========================================
    if (mag >= 5.5) {
        try {
            await admin.messaging().send({
                topic: "global",
                data: {
                    title: `🚨 ${mag} Büyük Deprem`,
                    body: `${place} | ⛏ ${depth} km`,
                    mag: String(mag),
                    lat: String(lat),
                    lon: String(lon),
                    depth: String(depth),
                    source: source,
                    open_alarm: "false"
                },
                android: { priority: "high" }
            });
            console.log("✅ Global (5.5+) mesajı iletildi.");
        } catch (e) {
            console.error("❌ Global gönderim hatası:", e.message);
        }
        // 🔥 VERİ KORUMA: Buradaki 'return' silindi. 
        // Böylece Kandilli depremi 5.5+ olsa bile aşağıdaki bireysel mesafe kontrolü çalışacak.
    }

    // ==========================================
    // 📍 KURAL 2: KİŞİSELLEŞTİRİLMİŞ FİLTRELEME
    // ==========================================
    const snapshot = await db.collection("users").limit(2000).get();
    const messages = [];

    snapshot.forEach(doc => {
        const user = doc.data();
        if (!user.token) return;

        const userLat = Number(user.lat);
        const userLon = Number(user.lon);
        if (!userLat || !userLon) return;

        const distance = getDistance(userLat, userLon, lat, lon);

    // 🇹🇷 KANDİLLİ ÖZEL KURALI: Türkiye sınırları dışında Kandilli bildirimi gönderilmez.
        if (source === "kandilli") {
            const isTR =
                userLat >= 34 && userLat <= 44 &&
                userLon >= 24 && userLon <= 47; 
            if (!isTR) return;
        }

        let canSend = false;
        let openAlarmFlag = "false";

        // ==========================================
        // 🛡️ KURAL KORUMA: Premium vs Ücretsiz Ayrımı
        // ==========================================
        if (user.isPremium === true) {
            const minMag = Number(user.minMag || 1);
            const maxDist = Number(user.maxDist || 500);

            // 🔥 KURAL: 5.5 üzeriyse mesafe bakmaksızın ÇAL 
            // VEYA kullanıcının kendi belirlediği limitler tutuyorsa ÇAL
            if (mag >= 5.5 || (mag >= minMag && distance <= maxDist)) {
                canSend = true;
                openAlarmFlag = "true"; 
            }
        } else {
            // 🔥 KURAL GÜNCELLEMESİ: 2.0 üzeri depremler kayan bildirim olarak gitmeli.
            // Ücretsiz kullanıcılar için 2.0+ ve 1200km sınırı (Flutter tarafındaki hard limit ile uyumlu)
            if (mag >= 2.0 && distance <= 1200) {
                canSend = true;
                openAlarmFlag = "false"; 
            }
        }

        if (!canSend) return;

        // ==========================================
        // 🛡️ VERİ & BİLDİRİM KORUMA
        // ==========================================
        messages.push({
            token: user.token,
            // 🔔 BİLDİRİM KORUMA: Kayan bildirim (Heads-up) için 'notification' şarttır.
            notification: {
                title: source === "kandilli" ? `🇹🇷 ${mag} Kandilli` : `🌍 ${mag} Deprem`,
                body: `${place}\n📏 ${distance} km | ⛏ ${depth} km`,
            },
            data: {
                // 🛡️ VERİ KORUMA: Tüm FCM data değerleri STRING olmalıdır.
                title: source === "kandilli" ? `🇹🇷 ${mag} Kandilli` : `🌍 ${mag} Deprem`,
                body: `${place}\n📏 ${distance} km | ⛏ ${depth} km`,
                mag: String(mag),
                lat: String(lat),
                lon: String(lon),
                depth: String(depth),
                distance: String(distance),
                source: source,
                open_alarm: openAlarmFlag
            },
            android: { 
                priority: "high",
                // 🛡️ KOD KORUMA: Android özel bildirim kanalı ve yüksek öncelik
                notification: {
                    channelId: "earthquake_channel", // Flutter tarafındaki kanal ID ile aynı
                    priority: "high", // Kayan bildirim için yüksek öncelik
                    sound: "default",
                    clickAction: "FLUTTER_NOTIFICATION_CLICK"
                }
            }
        });
    });

    // ==========================================
    // 🚀 BATCH GÖNDERİM (GÜVENLİ ÇIKIŞ)
    // ==========================================
    if (messages.length === 0) {
        console.log("ℹ️ Kriterlere uyan kullanıcı bulunamadı.");
        return;
    }

    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);
        try {
            // sendEach kullanarak güvenli ve hızlı toplu gönderim
            const res = await admin.messaging().sendEach(batch);
            
            // Hatalı tokenları temizleme süreci
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
                console.log(`🧹 ${invalidTokens.length} adet geçersiz token temizleniyor...`);
                await cleanInvalidTokens(invalidTokens);
            }
            
            console.log(`✅ ${res.successCount} adet bireysel bildirim iletildi.`);
        } catch (e) {
            console.error("❌ FCM Batch Hatası:", e.message);
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
    const [lon, lat, depthRaw] = eq.geometry.coordinates; // 🔥 BU SATIRI EKLE
    const mag = Number(eq.properties.mag || 0);
    
    // uniqueId kısmını da buna göre güncelle:
    const id = `usgs_${eq.id}`; // Daha güvenli bir ID
    const sent = await checkAndMarkSent(id, mag);
    
    if (!sent) {
        await sendNotification({
            ...eq,
            geometry: { coordinates: [lon, lat, depthRaw] }, // Veriyi doğru paketle
            properties: { ...eq.properties, source: "usgs" }
        });
    }
}

// 🇹🇷 KANDİLLİ (FIXED)
for (const eq of kandilliList) {

    try {
        const mag = parseFloat(eq.mag || eq.ml || eq.md);
        if (isNaN(mag)) continue;

        const lat = Number(eq.geojson?.coordinates?.[1] || eq.lat);
        const lon = Number(eq.geojson?.coordinates?.[0] || eq.lng);
        const depth = Number(eq.depth || 0);

        if (!lat || !lon) continue;

        // 🔥 UNIQUE ID (ARTIK _id YOK!)
        const id = `kandilli_${lat}_${lon}_${mag}`;

        const sent = await checkAndMarkSent(id, mag);

        if (!sent) {
            console.log("🇹🇷 KANDİLLİ GÖNDERİLİYOR:", mag, eq.title);

            await sendNotification({
                properties: {
                    mag,
                    place: eq.title || "Türkiye",
                    source: "kandilli"
                },
                geometry: {
                    coordinates: [lon, lat, depth]
                }
            });
        }

    } catch (err) {
        console.error("❌ KANDİLLİ PARSE HATA:", err.message);
    }
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
                id: "test_alarm_123", // 🔥 BU SATIRI EKLE (Eksik olan bu)
                title: "🚨 TEST ALARMI",
                body: "Bu bir simülasyon alarmıdır.",
                mag: "6.0",
                lat: "39.9",
                lon: "32.8",
                depth: "10",
                open_alarm: "true", // Alarmı tetikler
                source: "test"
            }
        });

        console.log("✅ TEST ALARM GÖNDERİLDİ");
        res.send("🚨 Test gönderildi (ID dahil)");

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