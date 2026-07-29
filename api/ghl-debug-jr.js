// /api/ghl-debug-jr.js
// TEMPORAL — solo para diagnóstico. Devuelve la respuesta CRUDA de GHL de 1-2 órdenes
// para poder ver los nombres reales de los campos (source, items, etc).
// Bórralo cuando terminemos de ajustar ghl-orders-jr.js.

const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!GHL_TOKEN) {
    res.status(500).json({ error: "Falta GHL_ACCESS_TOKEN" });
    return;
  }
  const locationId = req.query.locationId;
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    limit: "2",
    status: "completed",
  });
  const r = await fetch(`${GHL_BASE}/payments/orders?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
      Accept: "application/json",
    },
  });
  const j = await r.json();
  res.status(200).json(j);
};
