// /api/ghl-orders-jr.js
// Trae las órdenes pagadas (status = Completed) de un Location de GoHighLevel
// (API v2, Payments > Orders — la misma pantalla que ves en GHL) y les agrega
// la atribución UTM (source/medium/campaign/anuncio) leyendo el contacto.
//
// Estructura real confirmada por captura de pantalla de GHL:
//   - order.source.name  -> nombre completo del evento/producto
//                            (ej. "2. 🇲🇽 Respiracion MTY - 23 Agosto ✅")
//   - order.source.id    -> mismo Source ID que usábamos antes por evento
//   - order.items[]      -> cada item con name, qty, amount/subtotal
//                            los "upsells" son los items marcados como Bump
//
// GET /api/ghl-orders?locationId=X&knownIds=id1,id2,id3
//   knownIds = órdenes que el navegador YA tiene guardadas (localStorage).
//   El endpoint solo procesa (y solo pide atribución de) las que NO conoce todavía.
//
// Respuesta:
//   {
//     newSales: [ [fecha, nombre, monto, entradas, source, medium, campaign, adName,
//                  upsellCount, upsellMonto, orderId, nombreEvento, moneda], ... ],
//     validIds, totalTransactions, fetchedNew, skippedCount
//   }

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

// Un item es "upsell" si viene marcado como Bump (o si el nombre lo sugiere).
function isBumpItem(item) {
  const flag = (item.type || item.tag || item.label || item.itemType || "").toString().toLowerCase();
  if (flag.includes("bump")) return true;
  return /\bbump\b|\bupsell\b/i.test(item.name || "");
}
function itemQty(item) {
  return item.qty ?? item.quantity ?? 1;
}
function itemTotal(item) {
  return item.amount ?? item.subtotal ?? (item.price || 0) * itemQty(item);
}

async function fetchOrdersPage(locationId, startAfter, startAfterId) {
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    limit: "100",
    status: "completed",
  });
  if (startAfter) params.set("startAfter", startAfter);
  if (startAfterId) params.set("startAfterId", startAfterId);
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
    let startAfterId = null;
    let guard = 0;
    while (guard < 30) {
      guard++;
      const page = await fetchOrdersPage(locationId, startAfter, startAfterId);
      const orders = page.data || page.orders || [];
      if (orders.length === 0) break;
      allOrders = allOrders.concat(orders);
      if (!page.meta || orders.length < 100) break;
      startAfter = page.meta.startAfter;
      startAfterId = page.meta.startAfterId;
    }

    // Filtro extra por si acaso el query param no filtró todo — solo Completed.
    allOrders = allOrders.filter((o) => (o.status || "").toLowerCase() === "completed");

    const validIds = allOrders.map((o) => o._id);
    const newOrders = allOrders.filter((o) => !knownIds.has(o._id));

    const enriched = await mapLimit(newOrders, 8, async (o) => {
      const currency = o.currency || "MXN";
      const items = o.items || [];
      const ticketItems = items.filter((it) => !isBumpItem(it));
      const bumpItems = items.filter(isBumpItem);

      const amount = o.amount ?? o.total ?? items.reduce((a, it) => a + itemTotal(it), 0);
      const entradas = ticketItems.reduce((a, it) => a + itemQty(it), 0) || 1;
      const upsellCount = bumpItems.reduce((a, it) => a + itemQty(it), 0);
      const upsellAmount = bumpItems.reduce((a, it) => a + itemTotal(it), 0);

      const attr = await fetchContactAttribution(o.contactId);
      const eventName = o.source?.name || "";

      return [
        fmtDate(o.createdAt),
        o.contactSnapshot?.name || o.contactSnapshot?.email || "Sin nombre",
        amount,
        entradas,
        attr.source || "",
        attr.medium || "",
        attr.campaign || "",
        attr.adName || "",
        upsellCount,
        upsellAmount,
        o._id,
        eventName,
        currency,
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
