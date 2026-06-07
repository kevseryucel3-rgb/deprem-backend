console.log("VERSION: CLEAN-USGS-KANDILLI-BACKEND");

const admin = require("firebase-admin");
const express = require("express");
const fetch = require("node-fetch");
const { getKandilliDepremler } = require("./services/kandilliService");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log("HIT:", req.url);
  next();
});

if (!process.env.GOOGLE_CREDENTIALS) {
  throw new Error("GOOGLE_CREDENTIALS eksik");
}

const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let isProcessing = false;
let lastRun = 0;

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

async function checkAndMarkSent(id, mag) {
  const ref = db.collection("sent").doc(id);

  return await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);

    if (doc.exists) {
      const oldMag = doc.data().mag || 0;
      if (oldMag === mag) return true;

      tx.update(ref, {
        mag,
        time: admin.firestore.FieldValue.serverTimestamp(),
      });

      return false;
    }

    tx.set(ref, {
      mag,
      time: admin.firestore.FieldValue.serverTimestamp(),
    });

    return false;
  });
}

function normalizeUsgsFeature(feature) {
  const [lon, lat, depthRaw] = feature.geometry.coordinates;
  const mag = Number(feature.properties.mag || 0);
  const depth = Number(depthRaw || 0);

  if (!lat || !lon || !mag) return null;

  return {
    id: `usgs_${feature.id}`,
    provider: "usgs",
    source: "usgs",
    place: feature.properties.place || "Global",
    title: feature.properties.place || "Global",
    location: feature.properties.place || "Global",
    magnitude: mag,
    mag,
    lat,
    lon,
    latitude: lat,
    longitude: lon,
    depth,
    time: feature.properties.time || Date.now(),
    date_time: new Date(feature.properties.time || Date.now()).toISOString(),
    geojson: {
      type: "Point",
      coordinates: [lon, lat, depth],
    },
  };
}
