// /api/ghl-orders-jr.js
// Trae las órdenes pagadas (status = Completed) de un Location de GoHighLevel
// (API v2, Payments > Orders), y para cada orden NUEVA consulta el contacto para
// obtener atribución UTM (qué anuncio/campaña generó la venta).
//
// Estructura REAL confirmada llamando la API directamente:
//   - order.sourceName    -> nombre completo del evento/producto
//                            (ej. "8. 🇲🇽 Respiracion CDMX - 20 Sept ✅")
//   - order.contactId     -> ID del contacto en GHL (se usa para pedir atribución)
//   - order.contactName / order.contactEmail  -> datos del cliente (campos planos)
//   - order.amount        -> monto final pagado (ya con descuento aplicado)
//
// ATRIBUCIÓN UTM (confirmado con GET /contacts/{id}):
//   - contact.attributionSource     -> PRIMER touch (cuando se creó el contacto)
//   - contact.lastAttributionSource -> ÚLTIMO touch antes de la venta actual
//   En la práctica, el checkout de este negocio pasa por un redirect intermedio
//   (metadash-ybfaeoib.manus.space) que casi siempre borra el UTM del último touch.
//   Por eso usamos esta prioridad:
//     1) lastAttributionSource, SI trae algún UTM.
//     2) attributionSource (primer touch), SI trae UTM Y el contacto se creó
//        dentro de la ventana de estas campañas (>= ORDERS_SINCE) — así evitamos
//        atribuir la venta de un lead viejo (de otro evento, meses atrás) a una
//        campaña que ya no tiene nada que ver.
//     3) Si ninguno trae UTM, queda vacío (venta orgánica real / sin ads).
//
// ⚠️ LIMITACIONES CONOCIDAS (para no romper por timeout de Vercel Hobby — 10s):
//   1. Solo se traen órdenes desde ORDERS_SINCE (las campañas actuales arrancaron
//      julio 2026) — el location tiene +2400 órdenes históricas de años, no las
//      necesitamos todas.
//   2. La atribución (llamada a /contacts/{id}) SOLO se pide para órdenes nuevas
//      (que el dashboard aún no tenía cacheadas), en lotes concurrentes — así
//      cada carga normal es rápida. Una recarga completa desde cero (cache
//      limpio) sí puede tardar más si hay muchas órdenes nuevas de golpe.
//   3. La lista de órdenes no trae detalle de items, así que no se puede saber
//      si hubo "Bump"/upsell — ese KPI queda en 0.

const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const ORDERS_SINCE = new Date("2026-06-15T00:00:00Z");
const ATTRIBUTION_CONCURRENCY = 20; // llamadas simultáneas a /contacts/{id}
const ATTRIBUTION_MAX_ORDERS = 250; // tope de seguridad por request

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

async function fetchContact(contactId) {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() });
    if (!r.ok) return null;
    const j = await r.json();
    return j.contact || null;
  } catch (e) {
    return null; // si falla un contacto puntual, no tumbamos todo el request
  }
}

function hasUtm(src) {
  return !!(src && (src.utmSource || src.utmMedium || src.utmContent || src.campaign));
}

// Ver nota de "ATRIBUCIÓN UTM" arriba para la lógica de prioridad.
function pickAttribution(contact) {
  const empty = { utmSource: "", utmMedium: "", campaign: "", adName: "" };
  if (!contact) return empty;

  const last = contact.lastAttributionSource;
  const first = contact.attributionSource;
  const contactDate = contact.dateAdded ? new Date(contact.dateAdded) : null;

  let src = null;
  if (hasUtm(last)) {
    src = last;
  } else if (hasUtm(first) && contactDate && contactDate >= ORDERS_SINCE) {
    src = first;
  }
  if (!src) return empty;

  return {
    utmSource: src.utmSource || "",
    utmMedium: src.utmMedium || "",
    campaign: src.campaign || "",
    adName: src.utmContent || "", // en este negocio, utm_content = nombre del anuncio (ej. MTY23AGO_GIRA5H_IMG_02)
  };
}

// Pide atribución solo para las órdenes recibidas, en lotes concurrentes.
async function enrichAttribution(orders) {
  const toEnrich = orders.slice(0, ATTRIBUTION_MAX_ORDERS);
  const attrById = new Map();

  for (let i = 0; i < toEnrich.length; i += ATTRIBUTION_CONCURRENCY) {
    const batch = toEnrich.slice(i, i + ATTRIBUTION_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (o) => {
        if (!o.contactId) return [o._id, null];
        const contact = await fetchContact(o.contactId);
        return [o._id, contact];
      })
    );
    results.forEach(([id, contact]) => attrById.set(id, pickAttribution(contact)));
  }

  return attrById;
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

    const attrById = await enrichAttribution(newOrders);

    const enriched = newOrders.map((o) => {
      const attr = attrById.get(o._id) || { utmSource: "", utmMedium: "", campaign: "", adName: "" };
      return [
        fmtDate(o.createdAt),
        o.contactName || o.contactEmail || "Sin nombre",
        o.amount || 0,
        estimateEntradas(o.amount, o.currency || "MXN"),
        attr.utmSource,
        attr.utmMedium,
        attr.campaign,
        attr.adName,
        0, 0, // upsellCount, upsellAmount — no disponibles en este endpoint
        o._id,
        o.sourceName || "",
        o.currency || "MXN",
      ];
    });

    res.status(200).json({
      newSales: enriched,
      validIds,
      totalTransactions: allOrders.length,
      fetchedNew: enriched.length,
      skippedCount: allOrders.length - enriched.length,
      attributedCount: Array.from(attrById.values()).filter((a) => a.adName || a.campaign).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
