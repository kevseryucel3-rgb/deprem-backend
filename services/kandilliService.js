const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");

const KANDILLI_URL = "http://www.koeri.boun.edu.tr/scripts/lst0.asp";

function parseMagnitude(md, ml, mw) {
  const values = [mw, ml, md]
    .map((value) => Number.parseFloat(String(value).replace(",", ".")))
    .filter((value) => Number.isFinite(value));

  return values.length ? values[0] : 0;
}

function parseLine(line) {
  const match = line.match(
    /^(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}/
  );

  if (!match) return null;

  const [, rawDate, rawTime, rawLat, rawLon, rawDepth, md, ml, mw, rawPlace] = match;
  const latitude = Number.parseFloat(rawLat);
  const longitude = Number.parseFloat(rawLon);
  const depth = Number.parseFloat(rawDepth);
  const magnitude = parseMagnitude(md, ml, mw);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || magnitude <= 0) {
    return null;
  }

  const isoDate = rawDate.replace(/\./g, "-");
  const dateTime = `${isoDate}T${rawTime}+03:00`;
  const place = rawPlace.trim().replace(/\s+/g, " ");
  const id = `kandilli_${rawDate}_${rawTime}_${latitude}_${longitude}_${magnitude}`;

  return {
    earthquake_id: id,
    id,
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
    depth: Number.isFinite(depth) ? depth : 0,
    mag: magnitude,
    magnitude,
    title: place,
    location: place,
    place,
    geojson: {
      type: "Point",
      coordinates: [longitude, latitude, Number.isFinite(depth) ? depth : 0],
    },
  };
}

async function getKandilliDepremler() {
  try {
    const response = await axios.get(KANDILLI_URL, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const html = iconv.decode(response.data, "windows-1254");
    const $ = cheerio.load(html);
    const rawText = $("pre").text();

    const earthquakes = rawText
      .split("\n")
      .map((line) => parseLine(line))
      .filter(Boolean);

    return earthquakes;
  } catch (error) {
    console.error("Kandilli scraping hatasi:", error.message);
    return [];
  }
}

module.exports = {
  getKandilliDepremler,
};
