const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const iconv = require("iconv-lite");

const KANDILLI_URL = "http://www.koeri.boun.edu.tr/scripts/lst0.asp";

// Büyüklükleri sırasıyla (hangisi doluysa) en doğru şekilde çeken fonksiyon
function parseMagnitude(md, ml, mw) {
  const parseValue = (val) => {
    if (!val || val.includes("-")) return null;
    const num = parseFloat(val.replace(",", "."));
    return isNaN(num) || num <= 0 ? null : num;
  };

  const numMw = parseValue(mw);
  const numMl = parseValue(ml);
  const numMd = parseValue(md);

  return numMl || numMw || numMd || 0;
}

function parseLine(line) {
  const match = line.match(
    /^(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}/
  );

  if (!match) return null;

  const [, rawDate, rawTime, rawLat, rawLon, rawDepth, md, ml, mw, rawPlace] = match;
  
  const latitude = parseFloat(rawLat);
  const longitude = parseFloat(rawLon);
  const depth = parseFloat(rawDepth);
  const magnitude = parseMagnitude(md, ml, mw);

  if (isNaN(latitude) || isNaN(longitude) || magnitude <= 0) {
    return null;
  }

  const isoDate = rawDate.replace(/\./g, "-");
  const dateTime = `${isoDate}T${rawTime}+03:00`;
const timestampMs = new Date(dateTime).getTime();
  const place = rawPlace.trim().replace(/\s+/g, " ");

  const rawIdString = `kandilli_${isoDate}_${rawTime.replace(/:/g, "")}_${latitude}_${longitude}`;
  const safeId = crypto.createHash("md5").update(rawIdString).digest("hex");

  return {
    earthquake_id: `kandilli_${safeId}`,
    id: `kandilli_${safeId}`,
    provider: "kandilli",
    source: "kandilli",
    date_time: dateTime,
    date: dateTime,
    time: timestampMs,
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
      timeout: 10000, // İstek süresini kısalttık (daha hızlı tepki için)
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cache-Control": "no-cache" // Her zaman güncel veri çekilmesini sağlar
      },
    });

    const html = iconv.decode(response.data, "windows-1254");
    const $ = cheerio.load(html);
    const rawText = $("pre").text();

    if (!rawText) throw new Error("Kandilli verisi boş geldi.");

    // VERİ KORUMA: 
    // 1. split ile satırları ayır
    // 2. slice(0, 30) ile ilk 30 satırı al (sadece en güncel olanlar)
    // 3. parseLine ile işle ve null olanları filtrele
    const earthquakes = rawText
  .split("\n")
  .slice(7, 50) 
  .map((line) => parseLine(line))

    console.log(`✅ Kandilli verisi korumalı işlendi: ${earthquakes.length} adet deprem bulundu.`);
    return earthquakes;

  } catch (error) {
    console.error("❌ Kandilli servis çekim hatası:", error.message);
    // Hata durumunda boş dizi dönerek ana döngünün çökmesini engelliyoruz
    return [];
  }
}

module.exports = {
  getKandilliDepremler,
};