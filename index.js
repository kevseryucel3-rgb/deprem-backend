console.log("🔥 VERSION: FINAL-PRODUCTION - OPTIMIZED");

const admin = require("firebase-admin");
const cron = require("node-cron");
const express = require("express");
const fetch = require("node-fetch");
const { google } = require("googleapis");
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
const GLOBAL_MIN_NOTIFY_MAG = 1.0;
const RECENT_SENT_TTL_MS = 90 * 60 * 1000;
const USER_PAGE_SIZE = 2000;
const FCM_BATCH_SIZE = 500;
const recentSentCache = new Map();

function getSentCacheKey(id, mag) {
    return `${id}:${Number(mag).toFixed(1)}`;
}

function hasRecentSent(id, mag) {
    const key = getSentCacheKey(id, mag);
    const sentAt = recentSentCache.get(key);

    if (!sentAt) return false;

    if (Date.now() - sentAt > RECENT_SENT_TTL_MS) {
        recentSentCache.delete(key);
        return false;
    }

    return true;
}

function markRecentSent(id, mag) {
    recentSentCache.set(getSentCacheKey(id, mag), Date.now());

    if (recentSentCache.size > 5000) {
        const now = Date.now();

        for (const [key, sentAt] of recentSentCache.entries()) {
            if (now - sentAt > RECENT_SENT_TTL_MS) {
                recentSentCache.delete(key);
            }
        }
    }
}
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
                time: admin.firestore.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(
                    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
                )
            });

            return false;
        }

        tx.set(ref, {
            mag,
            time: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(
                new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
            )
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

    if (isNaN(mag) || mag < GLOBAL_MIN_NOTIFY_MAG) {
        console.log(`⏭️ ${mag} küçük deprem, kullanıcı sorgusu yapılmadı.`);
        return;
    }

    const place = String(eq.properties.place || "Deprem");
    const source = eq.properties.source || "usgs";

    const [lon, lat, depthRaw] = eq.geometry.coordinates;
    const depth = Math.round(depthRaw || 0);
    const quakeTime = eq.properties.time || eq.properties.timestamp || eq.properties.date || Date.now();

    console.log(`📨 İşlem Başladı: ${source} | Şiddet: ${mag} | Yer: ${place}`);

    let usersQuery = db.collection("users")
        .where("pushActive", "==", true);

    if (source === "kandilli") {
        usersQuery = usersQuery
            .where("lat", ">=", 34)
            .where("lat", "<=", 44);
    }

    let lastDoc = null;
    let totalReadUsers = 0;
    let totalPreparedMessages = 0;

    while (true) {
        let pageQuery = usersQuery
            .select(
                "token", "lat", "lon", "notificationsEnabled", "alarmEnabled",
                "isPremium", "premiumUntil", "minMag", "maxDist", "alarmMag", "alarmDist"
            )
            .limit(USER_PAGE_SIZE);

        if (source === "kandilli") {
            pageQuery = pageQuery
                .orderBy("lat")
                .orderBy(admin.firestore.FieldPath.documentId());
        } else {
            pageQuery = pageQuery
                .orderBy(admin.firestore.FieldPath.documentId());
        }

        if (lastDoc) {
            pageQuery = pageQuery.startAfter(lastDoc);
        }

        const snapshot = await pageQuery.get();

        if (snapshot.empty) break;

        totalReadUsers += snapshot.size;

        const messages = [];

        snapshot.forEach(doc => {
            const user = doc.data();

            if (!user.token) return;

            const notificationsEnabled = user.notificationsEnabled !== false;
            const alarmEnabledGlobal = user.alarmEnabled === true;

            if (!notificationsEnabled && !alarmEnabledGlobal) return;

            if (
                user.lat === undefined ||
                user.lon === undefined ||
                user.lat === null ||
                user.lon === null
            ) {
                return;
            }

            const userLat = Number(user.lat);
            const userLon = Number(user.lon);

            if (isNaN(userLat) || isNaN(userLon)) return;

            const distance = getDistance(userLat, userLon, lat, lon);

            // Kandilli sadece Türkiye içindeki kullanıcılara gider.
            if (source === "kandilli") {
                const isTR =
                    userLat >= 34 &&
                    userLat <= 44 &&
                    userLon >= 24 &&
                    userLon <= 47;

                if (!isTR) return;
            }

            let sendNotificationFlag = false;
            let sendAlarmFlag = false;

            let isPremium = false;

            if (user.premiumUntil) {
                try {
                    const until = user.premiumUntil.toDate();
                    isPremium = until > new Date();
                } catch (e) {
                    console.log("⚠️ premiumUntil parse hatası:", e.message);
                }
            }

            const notifMinMag = Number(user.minMag ?? 1);
            const notifMaxDist = Number(user.maxDist ?? 15000);

            const alarmMinMag = Number(user.alarmMag ?? 4.5);
            const alarmMaxDist = Number(user.alarmDist ?? 15000);
            const alarmEnabled = user.alarmEnabled === true;

            if (isPremium) {
                // PREMIUM: KAYAN BİLDİRİM
                if (
                    notificationsEnabled &&
                    mag >= notifMinMag &&
                    distance <= notifMaxDist
                ) {
                    sendNotificationFlag = true;
                }

                // PREMIUM: ALARM
                if (
                    alarmEnabled &&
                    mag >= alarmMinMag &&
                    distance <= alarmMaxDist
                ) {
                    sendNotificationFlag = true;
                    sendAlarmFlag = true;
                }
            } else {
                // FREE: SADECE KAYAN BİLDİRİM
                if (
                    notificationsEnabled &&
                    mag >= notifMinMag &&
                    distance <= notifMaxDist
                ) {
                    sendNotificationFlag = true;
                }

                // FREE kullanıcıya alarm ASLA gitmez
                sendAlarmFlag = false;
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

        if (messages.length > 0) {
            totalPreparedMessages += messages.length;

            for (let i = 0; i < messages.length; i += FCM_BATCH_SIZE) {
                const batch = messages.slice(i, i + FCM_BATCH_SIZE);

                try {
                    const res = await admin.messaging().sendEach(batch);
                    const invalidTokens = [];

                    res.responses.forEach((r, idx) => {
                        if (!r.success) {
                            const err = r.error?.code;

                            if (
                                err === "messaging/registration-token-not-registered" ||
                                err === "messaging/invalid-registration-token"
                            ) {
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

        lastDoc = snapshot.docs[snapshot.docs.length - 1];

        if (snapshot.size < USER_PAGE_SIZE) break;
    }

    console.log(
        `📊 ${source} | Okunan kullanıcı: ${totalReadUsers} | Hazırlanan mesaj: ${totalPreparedMessages}`
    );
}


// ======================
// 🔍 ANA DÖNGÜ (LOOP)
// ======================
// ======================
// 🔍 ANA DÖNGÜ (LOOP) - 45 SANİYE KORUMALI VE KİLİTLİ
// ======================
// ======================
// 🔍 ANA DÖNGÜ (LOOP) - SADELEŞTİRİLMİŞ
// ======================
async function checkEarthquakes() {
    const NOW = Date.now();
    
    // 🔒 1. KORUMA: Eğer son çalışmanın üzerinden 43 saniye geçmediyse çalıştırma
 if (NOW - lastRun < 25000) {
    return;
}
    // Zaman kilitini güncelle
    lastRun = NOW;

    try {
        console.log("🔄 [CRON] Deprem taraması başlatıldı...");

        const [usgsRes, kandilliRawList] = await Promise.all([
            fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson").catch(() => null),
            getKandilliDepremler().catch(() => [])
        ]);

        if (!usgsRes) {
            console.error("⚠️ USGS API'sine erişilemedi.");
            return;
        }

        const usgs = await usgsRes.json();
        const usgsList = usgs.features || [];
        const kandilliList = cleanKandilliData(kandilliRawList);

        console.log(`📡 Veri Çekildi -> USGS: ${usgsList.length} | Kandilli: ${kandilliList.length}`);

        // 🌍 USGS İŞLEME
for (const eq of usgsList) {
    try {
        const [lon, lat, depthRaw] = eq.geometry.coordinates;

        const mag = Number(eq.properties.mag || 0);
        if (isNaN(mag) || mag < GLOBAL_MIN_NOTIFY_MAG) continue;

        const quakeTime = eq.properties.time || Date.now();

        // ⏰ Son 15 dakikadaki depremler
        const ageMinutes = (Date.now() - quakeTime) / 60000;

        if (ageMinutes > 15 || ageMinutes < -15) {
            continue;
        }

        const id = `usgs_${eq.id}_${quakeTime}`;
        const finalDocId = id.replace(/[^a-zA-Z0-9_-]/g, "_");

        if (hasRecentSent(finalDocId, mag)) continue;

        const sent = await checkAndMarkSent(finalDocId, mag);

        markRecentSent(finalDocId, mag);

        if (!sent) {
            await sendNotification({
                ...eq,
                geometry: {
                    coordinates: [lon, lat, depthRaw]
                },
                properties: {
                    ...eq.properties,
                    source: "usgs"
                }
            });
        }

    } catch (err) {
        console.error("❌ Tekil USGS Satır Hatası:", err.message);
    }
}

        // 🇹🇷 KANDİLLİ İŞLEME
      for (const eq of kandilliList) {
    try {
        const mag = parseFloat(eq.mag);
        if (isNaN(mag) || mag < GLOBAL_MIN_NOTIFY_MAG) continue;

        const quakeTime = Number(eq.time);

        // ⏰ Son 15 dakikadaki depremler
        const ageMinutes = (Date.now() - quakeTime) / 60000;

        if (ageMinutes > 15 || ageMinutes < -15) {
            continue;
        }

        const lat = Number(eq.lat);
        const lon = Number(eq.lon);
        const depth = Number(eq.depth || 0);

        if (!lat || !lon) continue;

        const safeLatStr = String(lat).replace(/[^0-9]/g, "");
        const safeLonStr = String(lon).replace(/[^0-9]/g, "");
        const fallbackId = `kandilli_${safeLatStr}_${safeLonStr}`;

        const id = eq.id ? String(eq.id) : fallbackId;
        const finalDocId = id.replace(/[^a-zA-Z0-9_-]/g, "_");

        if (hasRecentSent(finalDocId, mag)) continue;

        const sent = await checkAndMarkSent(finalDocId, mag);

        markRecentSent(finalDocId, mag);

        if (!sent) {
            await sendNotification({
                properties: {
                    mag: mag,
                    place: eq.title,
                    source: "kandilli",
                    date: eq.date,
                    time: quakeTime
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

} catch (e) {
    console.error("❌ GENEL LOOP HATASI:", e.message);
}

// ======================
cron.schedule("*/30 * * * * *", checkEarthquakes);

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
app.post("/verify-google-purchase", async (req, res) => {
    try {
        const authHeader = req.headers.authorization || "";
        const idToken = authHeader.replace("Bearer ", "");

        if (!idToken) {
            return res.status(401).json({ error: "missing_token" });
        }

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const { productId, purchaseToken } = req.body;

        if (!productId || !purchaseToken) {
            return res.status(400).json({ error: "missing_purchase_data" });
        }

        const validProducts = [
            "deprem_premium_monthly",
            "deprem_premium_yearly",
        ];

        if (!validProducts.includes(productId)) {
            return res.status(400).json({ error: "invalid_product_id" });
        }

        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
            scopes: ["https://www.googleapis.com/auth/androidpublisher"],
        });

        const androidpublisher = google.androidpublisher({
            version: "v3",
            auth,
        });

        const result = await androidpublisher.purchases.subscriptionsv2.get({
            packageName: "com.alper.depremtakip",
            token: purchaseToken,
        });

        const sub = result.data;
        const expiryTime = sub.lineItems?.[0]?.expiryTime;

        if (!expiryTime) {
            return res.status(400).json({ error: "no_expiry_time" });
        }

        const expiryDate = new Date(expiryTime);
        const premium = expiryDate > new Date();

        await db.collection("users").doc(uid).set({
            isPremium: premium,
            premiumUntil: admin.firestore.Timestamp.fromDate(expiryDate),
            googlePlay: {
                productId,
                purchaseToken,
                subscriptionState: sub.subscriptionState || null,
                latestOrderId: sub.latestOrderId || null,
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return res.json({
            premium,
            premiumUntil: expiryDate.toISOString(),
        });
    } catch (e) {
        console.error("verify-google-purchase error:", e);
        return res.status(500).json({ error: e.message });
    }
});
app.get("/health", (req, res) => res.json({ status: "ok", processing: isProcessing, time: new Date() }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server ${PORT} portunda aktif.`));