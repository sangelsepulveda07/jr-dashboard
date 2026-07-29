// /api/ghl-orders-jr.js
// Trae las órdenes/ventas pagadas de un Location de GoHighLevel (API v2, Payments)
// y les agrega la atribución UTM (source/medium/campaign/anuncio) leyendo el contacto.
//
// GET /api/ghl-orders?locationId=X&knownIds=id1,id2,id3
//   knownIds = transacciones que el navegador YA tiene guardadas (localStorage).
//   El endpoint solo procesa (y solo pide atribución de) las que NO conoce todavía.
//
// Respuesta:
//   {
//     newSales: [ [fecha, nombre, montoMXN, entradas, source, medium, campaign, adName,
//                  upsellCount, upsellMXN, transactionId], ... ],
//     validIds: [ ...todas las transacciones vigentes del location... ],
//     totalTransactions, fetchedNew, skippedCount
//   }
//
// ⚠️ AJUSTA ESTO: no tengo forma de confirmar cuál integración de GHL usas exactamente
// (Private Integration Bearer / API v1 clásica). Este archivo asume la API v2 moderna
// (services.leadconnectorhq.com) con un Private Integration Token con scopes:
// payments/orders.readonly y contacts.readonly. Si te da 401, ese es el primer lugar
// a revisar — instrucciones completas en el README.

const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

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

function estimateEntradas(amountMXN) {
  const TICKET_BASE = 1299;
  if (!amountMXN || amountMXN <= 0) return 0;
  return Math.max(1, Math.round(amountMXN / TICKET_BASE));
}

async function fetchOrdersPage(locationId, startAfter) {
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    limit: "100",
    status: "completed",
  });
  if (startAfter) params.set("startAfter", startAfter);
  const r = await fetch(`${GHL_BASE}/payments/orders?${params.toString()}`, { headers: ghlHeaders() });
  const j = await r.json();
  if (!r.ok) throw new Error(`GHL orders error: ${j.message || r.statusText}`);
  return j;
}

async function fetchContactAttribution(contactId) {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() });
    const j = await r.json();
    if (!r.ok) return {};
    const attr = j?.contact?.attributionSource || j?.contact?.lastAttributionSource || {};
    return {
      source: attr.utmSource || attr.medium || "",
      medium: attr.utmMedium || attr.placement || "",
      campaign: attr.campaign || attr.utmCampaign || "",
      adName: attr.adName || attr.utmContent || "",
    };
  } catch {
    return {};
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
    let allOrders = [];
    let startAfter = null;
    let guard = 0;
    while (guard < 30) {
      guard++;
      const page = await fetchOrdersPage(locationId, startAfter);
      const orders = page.data || page.orders || [];
      if (orders.length === 0) break;
      allOrders = allOrders.concat(orders);
      if (!page.meta || !page.meta.startAfter || orders.length < 100) break;
      startAfter = page.meta.startAfter;
    }

    const validIds = allOrders.map((o) => o._id);
    const newOrders = allOrders.filter((o) => !knownIds.has(o._id));

    const enriched = await mapLimit(newOrders, 8, async (o) => {
      const amount = o.amount || 0;
      const attr = await fetchContactAttribution(o.contactId);
      const items = o.items || [];
      const upsellCount = items.filter((it) => /upsell/i.test(it.name || "")).length;
      const upsellAmount = items
        .filter((it) => /upsell/i.test(it.name || ""))
        .reduce((a, it) => a + (it.amount || 0), 0);
      const productName = items.map((it) => it.name || "").filter(Boolean).join(" | ");
      return [
        fmtDate(o.createdAt),
        o.contactSnapshot?.name || o.contactSnapshot?.email || "Sin nombre",
        amount,
        estimateEntradas(amount),
        attr.source || "",
        attr.medium || "",
        attr.campaign || "",
        attr.adName || "",
        upsellCount,
        upsellAmount,
        o._id,
        productName,
        o.currency || "MXN",
      ];
    });

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
