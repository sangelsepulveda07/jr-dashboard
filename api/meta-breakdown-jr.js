// /api/meta-breakdown-jr.js
// Desglose diario de gasto/clics por ANUNCIO o por CONJUNTO, para una o varias campañas.
// GET /api/meta-breakdown?campaignIds=id1,id2&level=ad          (o level=adset)
//
// Respuesta: { daily: { "Nombre del anuncio": { "July 9, 2026": {spend, clicks}, ... } } }
// Se cachea en el Edge de Vercel — antes esto se re-pedía completo en cada carga,
// y era la llamada más pesada de todo el dashboard.

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = "v21.0";

function fmtDate(d) {
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function fetchLevelDaily(campaignId, level) {
  const nameField = level === "ad" ? "ad_name" : "adset_name";
  const url =
    `https://graph.facebook.com/${API_VERSION}/${campaignId}/insights` +
    `?level=${level}&time_increment=1&fields=${nameField},spend,clicks,date_start&limit=500` +
    `&access_token=${META_TOKEN}`;

  const daily = {};
  let next = url;
  let guard = 0;
  while (next && guard < 20) {
    guard++;
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(`Meta error (${campaignId}/${level}): ${j.error.message}`);
    (j.data || []).forEach((row) => {
      const name = row[nameField];
      if (!name) return;
      const key = fmtDate(row.date_start);
      if (!daily[name]) daily[name] = {};
      daily[name][key] = { spend: parseFloat(row.spend || 0), clicks: parseInt(row.clicks || 0, 10) };
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

  const level = req.query.level === "adset" ? "adset" : "ad";
  const campaignIds = (req.query.campaignIds || req.query.campaignId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (campaignIds.length === 0) {
    res.status(400).json({ error: "Falta el parámetro campaignIds" });
    return;
  }

  try {
    const perCampaign = await Promise.all(
      campaignIds.map((id) => fetchLevelDaily(id, level).catch(() => ({})))
    );
    const daily = {};
    perCampaign.forEach((d) => {
      Object.entries(d).forEach(([name, days]) => {
        daily[name] = { ...(daily[name] || {}), ...days };
      });
    });
    res.status(200).json({ daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
