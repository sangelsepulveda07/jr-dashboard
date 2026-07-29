// /api/ghl-orders-jr.js
// Trae las órdenes pagadas (status = Completed) de un Location de GoHighLevel
// (API v2, Payments > Orders).
//
// Estructura REAL confirmada llamando la API directamente:
//   - order.sourceName    -> nombre completo del evento/producto
//                            (ej. "8. 🇲🇽 Respiracion CDMX - 20 Sept ✅")
//   - order.contactName / order.contactEmail  -> datos del cliente (campos planos)
//   - order.amount        -> monto final pagado (ya con descuento aplicado)
//
// ⚠️ LIMITACIONES CONOCIDAS (para no romper por timeout de Vercel Hobby — 10s):
//   1. Solo se traen órdenes desde ORDERS_SINCE (las campañas actuales arrancaron
//      julio 2026) — el location tiene +2400 órdenes históricas de años, no las
//      necesitamos todas.
//   2. NO se pide el detalle de atribución por contacto (eso implicaría cientos
//      de llamadas extra = timeout seguro). Las tablas "Anuncios con ventas" y
//      "Conjuntos con ventas" quedan vacías por ahora — el resto del dashboard
//      (ventas, entradas, ROAS, CAC por evento) funciona completo.
//   3. La lista de órdenes no trae detalle de items, así que no se puede saber
//      si hubo "Bump"/upsell — ese KPI queda en 0.

const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const ORDERS_SINCE = new Date("2026-06-15T00:00:00Z");

// Nombres de pruebas internas — sus órdenes NO cuentan como ventas reales.
// Comparación insensible a mayúsculas/acentos, por "contiene" (no exacta).
const EXCLUDED_NAMES = [
  "jonathan gonzalez",
  "fernanda puente",
  "alejandro angel",
  "alejo angel",
];

function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function isExcludedContact(o) {
  const name = normalize(o.contactName);
  const email = normalize(o.contactEmail);
  return EXCLUDED_NAMES.some((n) => name.includes(n) || email.includes(n.replace(/\s+/g, "")));
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_TOKEN}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

function fmtDate(iso) {
  const dt = new Date(iso);
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Mexico_City" });
}

// Precio base del boleto por moneda — se usa para saber cuántos boletos trae
// cada orden (ej. una orden de $2,598 MXN = 2 boletos de $1,299 c/u).
// ⚠️ AJUSTA: el precio en COP es una estimación — confírmalo si hace falta.
const TICKET_BASE_BY_CURRENCY = {
  MXN: 1299,
  USD: 47,
  COP: 259000,
};
function estimateEntradas(amount, currency) {
  const base = TICKET_BASE_BY_CURRENCY[currency] || TICKET_BASE_BY_CURRENCY.MXN;
  if (!amount || amount <= 0) return 0;
  return Math.max(1, Math.round(amount / base));
}

async function fetchOrdersPage(locationId, offset) {
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    limit: "100",
    offset: String(offset),
    status: "completed",
  });
  const r = await fetch(`${GHL_BASE}/payments/orders?${params.toString()}`, { headers: ghlHeaders() });
  const j = await r.json();
  if (!r.ok) throw new Error(`GHL orders error: ${j.message || r.statusText}`);
  return j;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, s-maxage=60, stale-while-revalidate=180");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!GHL_TOKEN) {
    res.status(500).json({ error: "Falta GHL_ACCESS_TOKEN en las variables de entorno de Vercel" });
    return;
  }

  const locationId = req.query.locationId;
  if (!locationId) {
    res.status(400).json({ error: "Falta el parámetro locationId" });
    return;
  }
  const knownIds = new Set(
    (req.query.knownIds || "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  try {
    const byId = new Map(); // dedup por _id, sin importar qué falle en la paginación
    let hitCutoff = false;
    for (let page = 0; page < 12 && !hitCutoff; page++) {
      const offset = page * 100;
      const result = await fetchOrdersPage(locationId, offset);
      const orders = result.data || result.orders || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        if (new Date(o.createdAt) < ORDERS_SINCE) { hitCutoff = true; continue; }
        byId.set(o._id, o); // si ya existía, se sobreescribe con el mismo dato — no duplica
      }

      if (orders.length < 100) break;
    }

    let allOrders = Array.from(byId.values());
    allOrders = allOrders.filter((o) => (o.status || "").toLowerCase() === "completed");
    allOrders = allOrders.filter((o) => (o.paymentStatus || "").toLowerCase() === "paid");
    allOrders = allOrders.filter((o) => (o.amount || 0) > 0);
    allOrders = allOrders.filter((o) => !isExcludedContact(o));

    const validIds = allOrders.map((o) => o._id);
    const newOrders = allOrders.filter((o) => !knownIds.has(o._id));

    const enriched = newOrders.map((o) => [
      fmtDate(o.createdAt),
      o.contactName || o.contactEmail || "Sin nombre",
      o.amount || 0,
      estimateEntradas(o.amount, o.currency || "MXN"),
      "", "", "", "", // atribución por contacto — deshabilitada por ahora, ver nota arriba
      0, 0, // upsellCount, upsellAmount — no disponibles en este endpoint
      o._id,
      o.sourceName || "",
      o.currency || "MXN",
    ]);

    res.status(200).json({
      newSales: enriched,
      validIds,
      totalTransactions: allOrders.length,
      fetchedNew: enriched.length,
      skippedCount: allOrders.length - enriched.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
