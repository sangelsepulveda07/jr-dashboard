// /api/ghl-debug-jr.js
// TEMPORAL — solo para diagnóstico. Devuelve la respuesta CRUDA de GHL
// para poder ver los nombres reales de los campos (source, items, attribution, etc).
// Bórralo cuando terminemos de ajustar ghl-orders-jr.js.
//
// Uso:
//   ?locationId=X                    -> dump de 2 órdenes crudas (comportamiento original)
//   ?locationId=X&email=correo@x.com -> busca el contacto por email y devuelve el objeto CRUDO
//   ?locationId=X&contactId=abc123   -> trae el contacto por ID directamente

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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!GHL_TOKEN) {
    res.status(500).json({ error: "Falta GHL_ACCESS_TOKEN" });
    return;
  }
  const locationId = req.query.locationId;
  const email = req.query.email;
  const contactId = req.query.contactId;

  try {
    if (contactId) {
      const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() });
      const j = await r.json();
      res.status(200).json(j);
      return;
    }

    if (email) {
      const params = new URLSearchParams({ locationId, query: email, limit: "5" });
      const r = await fetch(`${GHL_BASE}/contacts/?${params.toString()}`, { headers: ghlHeaders() });
      const j = await r.json();
      res.status(200).json(j);
      return;
    }

    const params = new URLSearchParams({
      altId: locationId,
      altType: "location",
      limit: "2",
      status: "completed",
    });
    const r = await fetch(`${GHL_BASE}/payments/orders?${params.toString()}`, { headers: ghlHeaders() });
    const j = await r.json();
    res.status(200).json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
