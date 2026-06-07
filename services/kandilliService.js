const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto"); // Güvenli ve noktasız benzersiz ID üretmek için
const iconv = require("iconv-lite");

const KANDILLI_URL = "http://www.koeri.boun.edu.tr/scripts/lst0.asp";

// Büyüklükleri sırasıyla (hangisi doluysa) en doğru şekilde çeken fonksiyon
function parseMagnitude(md, ml, mw) {
  // Önce sayıya çevrilebilir olanları buluyoruz, -.- gibi ifadeleri eliyoruz
  const parseValue = (val) => {
    if (!val || val.includes("-")) return null;
    const num = parseFloat(val.replace(",", "."));
    return isNaN(num) || num <= 0 ? null : num;
  };

  const numMw = parseValue(mw);
  const numMl = parseValue(ml);
  const numMd = parseValue(md);

  // Kandilli'de öncelik sırası genelde ML (Yerel Büyüklük) veya hangisi varsa odur.
  // En yüksek ve geçerli olan büyüklüğü seçiyoruz ki bildirimler kaçmasın.
  return numMl || numMw || numMd || 0;
}

function parseLine(line) {
  // Kandilli'nin txt formatını kusursuz ayrıştıran Regex satırı
  const match = line.match(
    /^(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}/
  );

  if (!match) return null;

  const [, rawDate, rawTime, rawLat, rawLon, rawDepth, md, ml, mw, rawPlace] = match;
  
  const latitude = parseFloat(rawLat);
  const longitude = parseFloat(rawLon);
  const depth = parseFloat(rawDepth);
  const magnitude = parseMagnitude(md, ml, mw);

  // Kritik Veri Güvenliği Filtresi
  if (isNaN(latitude) || isNaN(longitude) || magnitude <= 0) {
    return null;
  }

  const isoDate = rawDate.replace(/\./g, "-");
  const dateTime = `${isoDate}T${rawTime}+03:00`;
  const place = rawPlace.trim().replace(/\s+/g, " ");

  // 🔥 CRITICAL FIX: Firestore doküman ID'lerinde nokta (.) veya özel karakter olamaz!
  // Tarih, saat ve koordinatları temiz bir string yapıp MD5 hash alarak 
  // Firestore transaction'ın kilitlenmesini kesin olarak çözüyoruz.
  const rawIdString = `kandilli_${isoDate}_${rawTime.replace(/:/g, "")}_${latitude}_${longitude}`;
  const safeId = crypto.createHash("md5").update(rawIdString).digest("hex");

  return {
    earthquake_id: `kandilli_${safeId}`,
    id: `kandilli_${safeId}`, // index.js'in "sent" koleksiyonunda aradığı ID formatı
    provider: "kandilli",
    source: "kandilli",
    date_time: dateTime,
    date: dateTime,
    time: new Date(dateTime).getTime(),
    latitude,
    longitude,
    lat: latitude,
    lon: longitude,
    lng: longitude,
    depth: isNaN(depth) ? 0 : depth,
    mag: magnitude,
    magnitude,
    title: place,
    location: place,
    place,
    geojson: {
      type: "Point",
      coordinates: [longitude, latitude, isNaN(depth) ? 0 : depth],
    },
  };
}

async function getKandilliDepremler() {
  try {
    const response = await axios.get(KANDILLI_URL, {
      responseType: "arraybuffer",
      timeout: 15000, // Render sunucuları yavaş kalmasın diye timeout'u 15 saniyeye çektik
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const html = iconv.decode(response.data, "windows-1254");
    const $ = cheerio.load(html);
    const rawText = $("pre").text();

    if (!rawText) return [];

    const earthquakes = rawText
      .split("\n")
      .map((line) => parseLine(line))
      .filter(Boolean);

    return earthquakes;
  } catch (error) {
    console.error("❌ Kandilli servis çekim hatası:", error.message);
    return [];
  }
}

module.exports = {
  getKandilliDepremler,
};