// /api/meta-spend-jr.js
// Devuelve gasto + clics diarios de Meta para una o varias campañas en UNA sola llamada.
// GET /api/meta-spend?campaignIds=id1,id2,id3
//
// Respuesta: { "id1": { daily: { "July 9, 2026": {spend, clicks}, ... } }, "id2": {...} }
//
// Cacheado en el Edge de Vercel (s-maxage) para que NO se re-consulte Meta en cada
// visita de cada usuario — esta era la causa #1 de la lentitud del dashboard anterior.

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = "v21.0";

function fmtDate(d) {
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function fetchCampaignDaily(campaignId) {
  const url =
    `https://graph.facebook.com/${API_VERSION}/${campaignId}/insights` +
    `?time_increment=1&fields=spend,clicks,date_start&limit=500` +
    `&access_token=${META_TOKEN}`;

  const daily = {};
  let next = url;
  let guard = 0;
  while (next && guard < 10) {
    guard++;
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(`Meta error (${campaignId}): ${j.error.message}`);
    (j.data || []).forEach((row) => {
      const key = fmtDate(row.date_start);
      daily[key] = { spend: parseFloat(row.spend || 0), clicks: parseInt(row.clicks || 0, 10) };
    });
    next = j.paging && j.paging.next ? j.paging.next : null;
  }
  return daily;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!META_TOKEN) {
    res.status(500).json({ error: "Falta META_ACCESS_TOKEN en las variables de entorno de Vercel" });
    return;
  }

  const campaignIds = (req.query.campaignIds || req.query.campaignId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (campaignIds.length === 0) {
    res.status(400).json({ error: "Falta el parámetro campaignIds" });
    return;
  }

  try {
    const results = await Promise.all(
      campaignIds.map(async (id) => {
        try {
          const daily = await fetchCampaignDaily(id);
          return [id, { daily }];
        } catch (e) {
          return [id, { daily: {}, error: e.message }];
        }
      })
    );
    res.status(200).json(Object.fromEntries(results));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
