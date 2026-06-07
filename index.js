Mevcut `index.js` kodunu, gönderdiğin `kandilliService` dosyasındaki veri yapısıyla **birebir uyumlu** ve **hata toleranslı** olacak şekilde güncelledim.

### 🔍 Yapılan Kritik Değişiklikler ve Güvenlik Önlemleri:

1. **API Değişimi:** Eski Kandilli API adresi (`api.orhanaydogdu.com.tr`) tamamen kaldırıldı ve yerine belirttiğin yeni `https://deprem-backend-hqbp.onrender.com/api/kandilli` adresi entegre edildi.
2. **Veri Yapısı Senkronizasyonu:** Yeni API'den dönen veri yapısı doğrudan senin `kandilliService` içindeki `parseLine` çıktısı gibi (örneğin dizi formatında `[ { mag, lat, lon, title, ... }, ... ]` veya bir obje içinde) gelecektir. Kod, her iki ihtimale de (`data` alanı veya direkt dizi olma durumu) uyumlu hale getirilerek korumaya alındı.
3. **Mesafe ve Filtre Koruması:** `lat`, `lon` ve `mag` değerlerinin okunma mantığı yeni servis yapısındaki mimariye göre düzenlendi, böylece Premium/Ücretsiz filtre kararların ve alarm tetikleyicilerin (`open_alarm`) **hiçbir zarar görmedi**.
4. **Hata ve Çökme Koruması:** `Promise.all` içindeki ağ istekleri, API'lerden biri geçici olarak yanıt vermediğinde veya yavaşladığında sunucunun kilitlenmesini engellemek adına `AbortController` (zaman aşımı) mimarisi ile donatıldı.

İşte tüm kuralları ve iş mantığını koruyan güncel `index.js` dosyan:

```javascript
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
    const quakeTime =
        eq.properties.time ||
        eq.properties.timestamp ||
        eq.properties.date ||
        eq.properties.created_at ||
        Date.now();

    console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

    // ==========================================
    // 📍 KALTELİ FİLTRELEME & KULLANICI SEÇİMİ
    // ==========================================
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

        // 🔥 DEBUG → kullanıcıyı gör
        console.log("👤 USER:", {
            lat: user.lat,
            lon: user.lon,
            notificationsEnabled: user.notificationsEnabled,
            alarmEnabled: user.alarmEnabled,
            isPremium: user.isPremium,
            premiumUntil: user.premiumUntil,
            minMag: user.minMag,
            maxDist: user.maxDist,
            alarmMag: user.alarmMag,
            alarmDist: user.alarmDist
        });

        // 🔥 TOKEN YOKSA
        if (!user.token) {
            console.log("❌ TOKEN YOK → SKIP");
            return;
        }
        
        console.log("✅ TOKEN VAR:", user.token?.slice(0, 25), "LEN:", user.token?.length);
        const notificationsEnabled = user.notificationsEnabled === true;
        const alarmEnabledGlobal = user.alarmEnabled === true;

        if (!notificationsEnabled && !alarmEnabledGlobal) {
            console.log("🔕 Bildirim ve alarm kapalı → SKIP");
            return;
        }

        // 🔥 KONUM KONTROLÜ
        if (
            user.lat === undefined ||
            user.lon === undefined ||
            user.lat === null ||
            user.lon === null
        ) {
            console.log("❌ KONUM YOK → USER ELENDİ");
            return;
        }

        const userLat = Number(user.lat);
        const userLon = Number(user.lon);
        if (isNaN(userLat) || isNaN(userLon)) {
            console.log("❌ GEÇERSİZ KONUM");
            return;
        }

        const distance = getDistance(userLat, userLon, lat, lon);

        // 🇹🇷 KANDİLLİ ÖZEL KURALI: Türkiye sınırları dışında Kandilli bildirimi gönderilmez.
        if (source === "kandilli") {
            const isTR =
                userLat >= 34 && userLat <= 44 &&
                userLon >= 24 && userLon <= 47; 
            if (!isTR) return;
        }

        let sendNotificationFlag = false;
        let sendAlarmFlag = false;

        // ==========================================
        // 🛡️ KURAL KORUMA: Premium vs Ücretsiz Ayrımı
        // ==========================================

        // 🔥 PREMIUM KONTROLÜ
        let isPremium = user.isPremium === true;

        if (user.premiumUntil) {
            try {
                const until = user.premiumUntil.toDate();
                isPremium = until > new Date();
            } catch (e) {
                console.log("⚠️ premiumUntil parse hatası:", e.message);
            }
        }
        
        console.log("💎 PREMIUM CHECK:", {
            userId: doc.id,
            isPremium,
            premiumUntil: user.premiumUntil || null
        });

        if (isPremium) {
            const notifMinMag = Number(user.minMag || 1);
            const notifMaxDist = Number(user.maxDist || 500);
            const alarmMinMag = Number(user.alarmMag ?? 4.5);
            const alarmMaxDist = Number(user.alarmDist ?? 15000);
            const alarmEnabled = user.alarmEnabled === true;

            // 🔔 NOTIFICATION
            console.log("🔎 NOTIF CHECK:", {
                userId: doc.id,
                mag,
                notifMinMag,
                distance,
                notifMaxDist,
                passMag: mag >= notifMinMag,
                passDist: distance <= notifMaxDist
            });

            if (mag >= notifMinMag && distance <= notifMaxDist) {
                sendNotificationFlag = true;
                console.log("✅ NOTIF UYGUN:", doc.id);
            } else {
                console.log("❌ NOTIF UYGUN DEĞİL:", doc.id);
            }

            // 🚨 ALARM
            if (
                alarmEnabled &&
                mag >= alarmMinMag &&
                distance <= alarmMaxDist
            ) {
                sendNotificationFlag = true;
                sendAlarmFlag = true;
            }

        } else {
            // 🆓 FREE USER
            if (mag >= 2.0 && distance <= 1200) {
                sendNotificationFlag = true;
            }
        }
        
        console.log("📌 FINAL USER DECISION:", {
            userId: doc.id,
            sendNotificationFlag,
            sendAlarmFlag,
            isPremium
        });

        if (!sendNotificationFlag) return;

        // ==========================================
        // 🛡️ VERİ & BİLDİRİM KORUMA
        // ==========================================
        const safeMag = isNaN(mag) ? 0 : mag;
        const safePlace = place && place.length > 2 ? place : "Bilinmeyen konum";
        const safeDistance = distance || 0;
        const safeDepth = depth || 0;
        
        console.log("🚨 ALARM FLAG:", sendAlarmFlag, "MAG:", mag);
        
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
        // Ağ gecikmeleri ve çökme riskine karşı AbortController entegrasyonu (Yedek Koruma)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const [usgsRes, kandilliRes] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson", { signal: controller.signal }),
            fetch("https://deprem-backend-hqbp.onrender.com/api/kandilli", { signal: controller.signal }) // 🚀 YENİ API ADRESİ ENTEGRE EDİLDİ
        ]).catch(err => {
            clearTimeout(timeoutId);
            throw err;
        });

        clearTimeout(timeoutId);

        const usgs = await usgsRes.json().catch(() => ({}));
        const kandilliRawData = await kandilliRes.json().catch(() => null);

        const usgsList = usgs.features || [];
        
        // Yeni API'nin dizi ya da obje içinde sarmalanmış liste dönme durumuna uyumluluk
        let kandilliList = [];
        if (kandilliRawData) {
            if (Array.isArray(kandilliRawData)) {
                kandilliList = kandilliRawData;
            } else if (kandilliRawData.result && Array.isArray(kandilliRawData.result)) {
                kandilliList = kandilliRawData.result;
            } else if (kandilliRawData.data && Array.isArray(kandilliRawData.data)) {
                kandilliList = kandilliRawData.data;
            }
        }

        console.log("📡 USGS Deprem Sayısı:", usgsList.length);
        console.log("📡 Yeni Kandilli Deprem Sayısı:", kandilliList.length);

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

        // 🇹🇷 YENİ KANDİLLİ SERVIS UYUMLU DÖNGÜ
        for (const eq of kandilliList) {
            try {
                // Yeni servisteki fallback koordinat ve büyüklük isimlendirmelerine tam koruma
                const mag = parseFloat(eq.mag || eq.magnitude || eq.ml || eq.md);
                if (isNaN(mag) || mag <= 0) continue;

                const lat = Number(eq.lat || eq.latitude || eq.geojson?.coordinates?.[1]);
                const lon = Number(eq.lon || eq.lng || eq.longitude || eq.geojson?.coordinates?.[0]);
                const depth = Number(eq.depth || 0);

                if (!lat || !lon) continue;

                // Yeni servisin sağladığı earthquake_id veya benzersiz fallback ID
                const id = eq.earthquake_id || eq.id || `kandilli_${lat}_${lon}_${mag}`;
                const sent = await checkAndMarkSent(id, mag);

                if (!sent) {
                    console.log("🇹🇷 KANDİLLİ RAW YER:", eq.title || eq.place || eq.location);

                    let cleanPlace = eq.title || eq.place || eq.location || "Türkiye";

                    // RegEx temizleyiciler
                    cleanPlace = cleanPlace
                        .replace(/^ML\s*\d+(\.\d+)?\s*-\s*/i, "")
                        .replace(/^\d+(\.\d+)?\s*-\s*/i, "")
                        .trim();

                    if (!cleanPlace || cleanPlace.length < 3) {
                        cleanPlace = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
                    }

                    console.log("📍 TEMİZLENMİŞ YER:", cleanPlace);

                    const time = eq.time || (eq.date_time ? new Date(eq.date_time).getTime() : Date.now());

                    await sendNotification({
                        properties: {
                            mag: mag,
                            place: cleanPlace,
                            source: "kandilli",
                            time: time
                        },
                        geometry: {
                            coordinates: [lon, lat, depth]
                        }
                    });
                }

            } catch (err) {
                console.error("❌ KANDİLLİ SATIR İŞLEME HATASI:", err.message);
            }
        }

    // ======================
    // 🔥 GLOBAL HATA KONTROLÜ + KİLİT AÇMA
    // ======================
    } catch (e) {
        console.error("❌ GENEL HATA:", e.message);
    } finally {
        isProcessing = false; // 🔥 SİSTEM KİLİTLENMESİNİ ÖNLEYEN EN KRİTİK DEĞİŞKEN
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

// ======================
// 🧪 TEST (ALARM ZORLA)
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

```