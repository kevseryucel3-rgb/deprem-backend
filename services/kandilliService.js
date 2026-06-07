const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

async function getKandilliDepremler() {
  try {
    const response = await axios.get(
      'http://www.koeri.boun.edu.tr/scripts/lst0.asp',
      {
        responseType: 'arraybuffer',
        timeout: 10000,
      }
    );

    const html = iconv.decode(
      response.data,
      'ISO-8859-9'
    );

    const $ = cheerio.load(html);

    const rawText = $('pre').text();

    const lines = rawText.split('\n').slice(7);

    const depremler = [];

    for (const line of lines) {

      if (line.trim().length < 50) continue;

      const tarih = line.substring(0, 10).trim();
      const saat = line.substring(11, 19).trim();

      const enlem = parseFloat(
        line.substring(21, 28).trim()
      );

      const boylam = parseFloat(
        line.substring(30, 37).trim()
      );

      const derinlik = parseFloat(
        line.substring(40, 45).trim()
      );

      const buyukluk = parseFloat(
        line.substring(60, 63).trim()
      );

      const yer = line
        .substring(71, 121)
        .trim()
        .replace(/\s+/g, ' ');

      depremler.push({
        tarih,
        saat,
        lat: enlem,
        lng: boylam,
        depth: derinlik,
        mag: buyukluk,
        title: yer,
      });
    }

    return depremler;

  } catch (error) {

    console.error(
      "Kandilli scraping hatası:",
      error.message
    );

    return [];
  }
}

module.exports = {
  getKandilliDepremler,
};
