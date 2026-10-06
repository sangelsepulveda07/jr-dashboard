// /api/ghl-history-jr.js
// Ventas HISTÓRICAS de GoHighLevel para la página /trafficker (reporte de cierre).
// GET /api/ghl-history-jr?locationId=XXX&since=2026-06-15&until=2026-09-06
//
// Por qué un endpoint aparte y no /api/ghl-orders-jr:
//   - ghl-orders-jr corta en 12 páginas (1,200 órdenes) para no pasarse de los 10s
//     de Vercel Hobby. Como la API devuelve primero las órdenes más nuevas, las
//     ventas de julio y principios de agosto ya quedaron FUERA de ese tope.
//   - Aquí no se pide atribución por contacto (/contacts/{id}), que es lo lento:
//     solo hace falta producto, monto y fecha. Así se pueden leer muchas páginas
//     en paralelo sin pasarse del tiempo.
//
// Devuelve totales agrupados por producto (order.sourceName) — sin nombres ni
// correos de clientes, porque esta página es un reporte agregado.

const GHL_TOKEN = process.env.GHL_ACCESS_TOKEN;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const PAGE_SIZE = 100;
const PARALLEL_PAGES = 6; // páginas pedidas a la vez
const MAX_PAGES = 40;     // tope de seguridad (4,000 órdenes)

// Mismas exclusiones y mismo cálculo de boletos que /api/ghl-orders-jr.js —
// si se cambian allá, cambiarlos aquí también para que los números cuadren.
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

const TICKET_BASE_BY_CURRENCY = { MXN: 1299, USD: 47, COP: 259000 };
const MXN_ORDER_BUMP = 746;
const DISCOUNT_TIERS = [0, 0.05, 0.10, 0.15, 0.20, 0.25];

function estimateEntradas(amount, currency) {
  const base = TICKET_BASE_BY_CURRENCY[currency] || TICKET_BASE_BY_CURRENCY.MXN;
  if (!amount || amount <= 0) return 0;
  if (currency !== "MXN") return Math.max(1, Math.round(amount / base));

  let best = { k: Math.max(1, Math.round(amount / base)), diff: Infinity };
  for (let n = 0; n <= 3; n++) {
    const remaining = amount - n * MXN_ORDER_BUMP;
    if (remaining <= 0) continue;
    for (let k = 1; k <= 6; k++) {
      for (const d of DISCOUNT_TIERS) {
        const diff = Math.abs(remaining - k * base * (1 - d));
        if (diff < best.diff - 0.005) best = { k, diff };
      }
    }
  }
  return best.k;
}

function fmtDay(iso) {
  // Día en hora de México, formato YYYY-MM-DD
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

async function fetchOrdersPage(locationId, offset, since, until) {
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    limit: String(PAGE_SIZE),
    offset: String(offset),
    status: "completed",
    // Si la API respeta el rango, pide muchas menos páginas. Si no, el filtro
    // por fecha de más abajo igual deja solo las órdenes del rango.
    startAt: since,
    endAt: until,
  });
  const r = await fetch(`${GHL_BASE}/payments/orders?${params.toString()}`, {
    headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`GHL orders error: ${j.message || r.statusText}`);
  return j.data || j.orders || [];
}

module.exports = async (req, res) => {
  // Es un periodo cerrado: se puede cachear 1 hora en el Edge.
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!GHL_TOKEN) {
    res.status(500).json({ error: "Falta GHL_ACCESS_TOKEN en las variables de entorno de Vercel" });
    return;
  }
  const { locationId, since, until } = req.query;
  if (!locationId || !since || !until) {
    res.status(400).json({ error: "Faltan parámetros: locationId, since, until (YYYY-MM-DD)" });
    return;
  }
  const sinceDate = new Date(since + "T00:00:00-06:00");
  const untilDate = new Date(until + "T23:59:59-06:00");

  try {
    const byId = new Map();
    let done = false;
    let pages = 0;
    for (let start = 0; start < MAX_PAGES && !done; start += PARALLEL_PAGES) {
      const offsets = [];
      for (let p = start; p < Math.min(start + PARALLEL_PAGES, MAX_PAGES); p++) offsets.push(p * PAGE_SIZE);
      const results = await Promise.all(offsets.map((off) => fetchOrdersPage(locationId, off, since, until)));
      for (const orders of results) {
        pages++;
        if (orders.length < PAGE_SIZE) done = true;
        for (const o of orders) {
          const d = new Date(o.createdAt);
          // La API devuelve de más nueva a más vieja: al cruzar "since" ya no hace falta seguir.
          if (d < sinceDate) { done = true; continue; }
          if (d > untilDate) continue;
          byId.set(o._id, o);
        }
      }
    }

    const orders = Array.from(byId.values())
      .filter((o) => (o.status || "").toLowerCase() === "completed")
      .filter((o) => (o.paymentStatus || "").toLowerCase() === "paid")
      .filter((o) => (o.amount || 0) > 0)
      .filter((o) => !isExcludedContact(o));

    const products = {};
    for (const o of orders) {
      const name = o.sourceName || "(sin producto)";
      const currency = o.currency || "MXN";
      const key = name + "|" + currency;
      if (!products[key]) products[key] = { name, currency, orders: 0, entradas: 0, amount: 0, firstDay: null, lastDay: null };
      const p = products[key];
      const day = fmtDay(o.createdAt);
      p.orders++;
      p.entradas += estimateEntradas(o.amount, currency);
      p.amount += o.amount;
      if (!p.firstDay || day < p.firstDay) p.firstDay = day;
      if (!p.lastDay || day > p.lastDay) p.lastDay = day;
    }

    const days = orders.map((o) => fmtDay(o.createdAt)).sort();
    res.status(200).json({
      since,
      until,
      pagesRead: pages,
      totalOrders: orders.length,
      firstOrderDay: days[0] || null,
      lastOrderDay: days[days.length - 1] || null,
      products: Object.values(products),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
