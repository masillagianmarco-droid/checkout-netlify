// Verifica delle licenze per tutti i siti SITE FACTORY 365 (CORS solo verso i siti del catalogo).
import { withCheckoutStorage, json, readJson, getJSON, corsHeaders, usableInThisMode } from "../../lib/sf365/core.mjs";

export default withCheckoutStorage(async (req, context) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ valid: false, reason: "metodo" }, 405, cors);
  let body;
  try { body = await readJson(req, 2000); } catch { return json({ valid: false, reason: "richiesta_non_valida" }, 400, cors); }
  const key = String(body.key || "").trim().toUpperCase();
  const sku = String(body.sku || "").trim();
  if (!/^SF365-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(key)) return json({ valid: false, reason: "formato" }, 200, cors);
  const lic = await getJSON("licenses", key);
  if (!lic) return json({ valid: false, reason: "sconosciuta" }, 200, cors);
  // una licenza vale per lo sku acquistato e per le varianti dello stesso prodotto (stesso prefisso fino a "-pro")
  const family = (s) => s.replace(/-(12m|mensile|annuale)$/, "");
  if (sku && family(lic.sku) !== family(sku)) return json({ valid: false, reason: "prodotto_diverso" }, 200, cors);
  if (lic.status !== "active") return json({ valid: false, reason: lic.status }, 200, cors);
  // Una licenza emessa con un pagamento di prova non vale quando le vendite reali sono attive.
  if (!usableInThisMode(lic, context)) return json({ valid: false, reason: "licenza_di_prova" }, 200, cors);
  if (lic.expires_at && new Date(lic.expires_at) < new Date()) return json({ valid: false, reason: "scaduta" }, 200, cors);
  return json({ valid: true, sku: lic.sku, expires_at: lic.expires_at || null, mode: lic.mode === "live" ? "live" : "sandbox" }, 200, cors);
});

export const config = { path: "/api/license/verify" };
