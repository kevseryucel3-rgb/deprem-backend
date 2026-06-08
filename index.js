console.log("🔥 VERSION: FINAL-PRODUCTION - OPTIMIZED");

const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch");
const { getKandilliDepremler } = require("./services/kandilliService");
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
// 📏 MESAFE HESAPLAMA (Haversine Formülü)
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
// 🔒 MÜKERRER KONTROLÜ (Transaction Safe)
// ======================
async function checkAndMarkSent(id, mag) {
    // Firestore doküman ID'lerinde nokta veya geçersiz karakter temizliği kontrolü
    const safeDocId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const ref = db.collection("sent").doc(safeDocId);

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
// 🧹 TOKEN TEMİZLEME
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
// 🔔 BİLDİRİM GÖNDERİMİ
// ======================
async function sendNotification(eq) {
    const mag = Number(eq.properties.mag || 0);
    const place = String(eq.properties.place || "Deprem");
    const source = eq.properties.source || "usgs";

    const [lon, lat, depthRaw] = eq.geometry.coordinates;
    const depth = Math.round(depthRaw || 0);
    const quakeTime = eq.properties.time || eq.properties.timestamp || eq.properties.date || Date.now();

    console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

    // Cihaz ayarlarını optimize etmek için projeye uygun limitlendirilmiş veri çekimi
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

        if (user.lat === undefined || user.lon === undefined || user.lat === null || user.lon === null) {
            return;
        }

        const userLat = Number(user.lat);
        const userLon = Number(user.lon);
        if (isNaN(userLat) || isNaN(userLon)) return;

        const distance = getDistance(userLat, userLon, lat, lon);

        // 🇹🇷 KANDİLLİ ÖZEL KURALI: Türkiye sınırları dışında Kandilli bildirimi gönderilmez.
        if (source === "kandilli") {
            const isTR = userLat >= 34 && userLat <= 44 && userLon >= 24 && userLon <= 47; 
            if (!isTR) return;
        }

        let sendNotificationFlag = false;
        let sendAlarmFlag = false;

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
            // 🆓 ÜCRETSİZ KULLANICI FİLTRESİ
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
            android: { priority: "high" }
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
            console.log(`✅ ${res.successCount} adet bildirim başarıyla iletildi.`);
        } catch (e) {
            console.error("❌ FCM Batch Hatası:", e.message);
        }
    }
}

// ======================
// 🔍 ANA DÖNGÜ (LOOP)
// ======================
// ======================
// 🔍 ANA DÖNGÜ (LOOP) - 45 SANİYE KORUMALI VE KİLİTLİ
// ======================
async function checkEarthquakes() {
    const NOW = Date.now();
    
    // 🔒 1. KORUMA: Eğer son çalışmanın üzerinden 43 saniye geçmediyse ASLA çalıştırma
    if (NOW - lastRun < 43000) {
        return; 
    }

    // 🔒 2. KORUMA: Eğer içeride hâlâ devam eden bir asenkron işlem varsa ASLA ikinciyi başlatma
    if (isProcessing) {
        console.log("⏳ İşlem hâlâ devam ediyor, yeni tarama engellendi.");
        return;
    }

    // Milleri ve kilidi hemen işlemin başında kitle
    isProcessing = true;
    lastRun = NOW;

    try {
        console.log("🔄 [CRON] 45 saniyelik yeni deprem taraması başlatıldı...");

        const [usgsRes, kandilliRawList] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson").catch(() => null),
            getKandilliDepremler().catch(() => [])
        ]);

        // API çökmelerine karşı güvenlik koruması
        if (!usgsRes) {
            console.error("⚠️ USGS API'sine erişilemedi, bu tur atlanıyor.");
            isProcessing = false;
            return;
        }

        const usgs = await usgsRes.json();
        const usgsList = usgs.features || [];
        const kandilliList = cleanKandilliData(kandilliRawList);

        console.log(`📡 Veri Çekildi -> USGS: ${usgsList.length} | Kandilli: ${kandilliList.length}`);

        // 🌍 USGS İŞLEME
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

       // 🇹🇷 KANDİLLİ İŞLEME (HER SANİYE GÖNDERİMİ ENGELLEYEN GÜVENLİ DÖNGÜ)
        for (const eq of kandilliList) {
            try {
                const mag = parseFloat(eq.mag);
                if (isNaN(mag)) continue;

                const lat = Number(eq.lat);
                const lon = Number(eq.lon);
                const depth = Number(eq.depth || 0);

                if (!lat || !lon) continue;

                // 🔒 Nokta ve geçersiz karakter içermeyen, tamamen güvenli yedek ID üretimi
                const safeLatStr = String(lat).replace(/[^0-9]/g, "");
                const safeLonStr = String(lon).replace(/[^0-9]/g, "");
                const safeMagStr = String(mag).replace(/[^0-9]/g, "");
                
                // Eğer servisten temiz bir id geldiyse onu kullan, gelmediyse noktasız garantici ID'yi bas
                const fallbackId = `kandilli_${safeLatStr}_${safeLonStr}_${safeMagStr}`;
                const id = eq.id ? String(eq.id) : fallbackId;
                
                // Firestore Transaction'a sokmadan önce ID'yi bir kez daha sanitize et
                const finalDocId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
                
                const sent = await checkAndMarkSent(finalDocId, mag);

                if (!sent) {
                    await sendNotification({
                        properties: {
                            mag: mag,
                            place: eq.title,
                            source: "kandilli",
                            date: eq.date
                        },
                        geometry: {
                            coordinates: [lon, lat, depth]
                        }
                    });
                }
            } catch (err) {
                console.error("❌ Tekil Kandilli Satır Hatası:", err.message);
            }
        }

    } catch (e) { // Ana try bloğunun güvenli kapanışı ve yakalaması
        console.error("❌ GENEL LOOP HATASI:", e.message);
    } finally {
        // İşlem tamamen bittiğinde kilidi kaldır ki bir sonraki 45. saniyede çalışabilsin
        isProcessing = false; 
        console.log("🏁 Tarama turu güvenli bir şekilde tamamlandı, kilit açıldı.");
    }
} // checkEarthquakes fonksiyonunun ana kapanış parantezi

// ======================
cron.schedule("*/45 * * * * *", checkEarthquakes);

// ======================
// API ENDPOINTS & HELPERS
// ======================
function cleanKandilliData(data) {
    return (data || []).map(eq => {
        try {
            const mag = parseFloat(eq.mag || eq.ml || eq.md || 0);
            const lat = Number(eq.geojson?.coordinates?.[1] || eq.lat || 0);
            const lon = Number(eq.geojson?.coordinates?.[0] || eq.lng || eq.lon || 0);
            const depth = Number(eq.depth || 0);

            let cleanPlace = eq.title || eq.location || eq.region || "Türkiye";
            cleanPlace = cleanPlace
                .replace(/^ML\s*\d+(\.\d+)?\s*-\s*/i, "")
                .replace(/^\d+(\.\d+)?\s*-\s*/i, "")
                .trim();

            if (!cleanPlace || cleanPlace.length < 3) {
                cleanPlace = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
            }

            return {
                ...eq,
                id: eq.id, // Servisteki temiz MD5 hash id yapısını bozma
                mag: mag,
                magnitude: mag,
                latitude: lat,
                lat: lat,
                longitude: lon,
                lon: lon,
                lng: lon, 
                depth: depth,
                title: cleanPlace,
                place: cleanPlace,
                date: eq.date || new Date().toISOString(),
                geojson: eq.geojson ? eq.geojson : {
                    type: "Point",
                    coordinates: [lon, lat, depth]
                }
            };
        } catch (e) {
            return eq;
        }
    });
}

app.get("/api/kandilli", async (req, res) => {
    try {
        const data = await getKandilliDepremler();
        const cleaned = cleanKandilliData(data);
        res.json({ status: true, source: "kandilli", count: cleaned.length, result: cleaned }); 
    } catch (err) {
        res.status(500).json({ status: false, error: err.message, result: [] });
    }
});

app.get("/api/usgs", async (req, res) => {
    try {
        const response = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson");
        const json = await response.json();
        const cleaned = (json.features || []).map(eq => {
            const [lon, lat, depth] = eq.geometry.coordinates;
            return {
                id: `usgs_${eq.id}`,
                source: "usgs",
                mag: Number(eq.properties.mag || 0),
                magnitude: Number(eq.properties.mag || 0),
                lat: lat,
                latitude: lat,
                lon: lon,
                longitude: lon,
                lng: lon,
                depth: Math.round(depth || 0),
                place: eq.properties.place || "Global Deprem",
                title: eq.properties.place || "Global Deprem",
                date: new Date(eq.properties.time).toISOString()
            };
        });
        res.json({ status: true, source: "usgs", count: cleaned.length, result: cleaned });
    } catch (err) {
        res.status(500).json({ status: false, error: err.message, result: [] });
    }
});

app.get("/", (req, res) => res.send("Deprem Servisi Aktif 🚀"));
app.get("/health", (req, res) => res.json({ status: "ok", processing: isProcessing, time: new Date() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server ${PORT} portunda aktif.`));