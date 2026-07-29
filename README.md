# Jony Respira · Dashboard v2

Proyecto **nuevo**, independiente del dashboard de Juan Londoño y del `jony-respira-dashboard`
anterior. Cubre los 3 eventos activos: CDMX 16 Ago, Monterrey 23 Ago, Medellín 29 Ago.

## Qué cambia vs. el dashboard anterior (por qué será más rápido)

1. **Carga una sola vez, no por tab.** Al abrir la página se piden en paralelo (`Promise.all`)
   el gasto de Meta, el desglose por anuncio/conjunto y las ventas de GHL — de los 3 eventos
   a la vez. Cambiar de tab o de período después NO vuelve a tocar la red, solo re-filtra
   lo que ya está en memoria/localStorage.
2. **Caché real, en dos capas:**
   - Servidor (Vercel Edge): `Cache-Control: s-maxage=...` en los 3 endpoints de `/api`.
   - Navegador: `localStorage`, con actualización silenciosa en segundo plano cada 4 min.
3. **Ventas correctamente atribuidas por evento.** El dashboard anterior no filtraba las
   ventas de GHL por evento (con 1 sola campaña activa no se notaba). Ahora cada venta se
   matchea contra el **nombre del producto** de la orden en GHL (`matchKeywords` en
   `index.html`) — revisa que esas palabras coincidan con el nombre real del producto/ticket
   en tu funnel de GHL para cada evento.
4. **Dos monedas.** CDMX y MTY venden en MXN, Medellín en COP — hay un tipo de cambio
   independiente para cada uno en los controles de arriba.

## Variables de entorno (Vercel → Project Settings → Environment Variables)

| Variable | Qué es |
|---|---|
| `META_ACCESS_TOKEN` | Token de acceso de Meta con permiso sobre la cuenta `CP - Jony Respira` (1053252493585423) |
| `GHL_API_KEY` | Private Integration Token de GoHighLevel |

## ⚠️ Cosa a verificar apenas despliegues: la integración con GHL

No tuve forma de confirmar cómo estaba conectado el dashboard anterior a GHL (ni tú lo
sabías), así que `api/ghl-orders.js` asume lo siguiente — **verifícalo y ajusta si hace falta**:

- API v2 moderna de GHL (`services.leadconnectorhq.com`), autenticación `Bearer` con un
  **Private Integration Token** (Configuración → Private Integrations en GHL), con scopes
  `payments/orders.readonly` y `contacts.readonly`.
- El endpoint de órdenes es `/payments/orders` y de ahí saca `amount`, `currency`,
  `contactId`, `items[].name` (para saber el producto/evento).
- La atribución UTM (source/medium/campaign/anuncio) la saca leyendo el contacto
  (`/contacts/{id}`) y su campo `attributionSource`.

**Si al desplegar ves error 401** → el token no tiene los scopes correctos, o es una API
key v1 clásica en vez de v2 (avísame y te ajusto el endpoint).
**Si ves ventas pero sin nombre de producto/evento** → puede que en tu funnel el nombre
del producto no diga "CDMX"/"Monterrey"/"Medellín" — dime cómo se llaman los productos
reales y ajusto `matchKeywords` en `index.html`.
**Si el monto de Medellín sale rarísimo** → ajusta el tipo de cambio COP→USD arriba a la
derecha del dashboard (por defecto 4100).

## Cómo desplegar

1. Crea un repo nuevo en GitHub (ej. `jony-respira-dashboard-v2`), vacío.
2. Sube estos archivos manteniendo la estructura (los de `/api` llevan sufijo `-jr` para
   que no se confundan en tu compu con los archivos de Juan Londoño — `index.html` no se
   puede renombrar, Vercel lo necesita con ese nombre exacto para servir la página en `/`):
   ```
   /index.html
   /package.json
   /api/meta-spend-jr.js
   /api/meta-breakdown-jr.js
   /api/ghl-orders-jr.js
   ```
3. En Vercel: **New Project → Import** ese repo de GitHub.
4. Agrega las 2 variables de entorno de arriba en Project Settings.
5. Deploy. Cada push a `main` vuelve a desplegar automático — como ya tienes configurado
   con tus otros proyectos.

## Ajustar `matchKeywords` / metas / conjuntos

Todo eso vive al inicio del `<script>` en `index.html`, dentro del arreglo `EVENTS`. No
hace falta tocar los archivos de `/api` para cambiar nombres de anuncios, metas de
inversión/entradas, o las palabras que identifican a cada evento.
