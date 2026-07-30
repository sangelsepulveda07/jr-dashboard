// /api/ghl-debug-jr.js
// TEMPORAL — solo para diagnóstico. Devuelve la respuesta CRUDA de GHL
// para poder ver los nombres reales de los campos (source, items, attribution, etc).
// Bórralo cuando terminemos de ajustar ghl-orders-jr.js.
//
// Uso:
//   ?locationId=X                    -> dump de 2 órdenes crudas (comportamiento original)
//   ?locationId=X&email=correo@x.com -> busca el contacto por email/nombre y devuelve el objeto CRUDO
//   ?locationId=X&contactId=abc123   -> trae el contacto por ID directamente
//   ?locationId=X&conversations=abc123 -> busca la conversación de ese contactId y trae sus mensajes crudos

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
  const conversationsContactId = req.query.conversations;

  try {
    if (conversationsContactId) {
      const searchParams = new URLSearchParams({
        locationId,
        contactId: conversationsContactId,
      });
      const searchR = await fetch(`${GHL_BASE}/conversations/search?${searchParams.toString()}`, { headers: ghlHeaders() });
      const searchJ = await searchR.json();

      const conversationId = searchJ?.conversations?.[0]?.id;
      if (!conversationId) {
        res.status(200).json({ note: "No se encontró conversación para ese contactId", searchResult: searchJ });
        return;
      }

      const msgR = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages?limit=50`, { headers: ghlHeaders() });
      const msgJ = await msgR.json();
      res.status(200).json({ conversationId, messages: msgJ });
      return;
    }

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
