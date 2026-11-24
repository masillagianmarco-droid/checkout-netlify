// Consegna automatica: dati della consegna e scaricamento del file (se previsto dal prodotto).
import { findProduct, publicProduct } from "../../catalog/products.mjs";
import { json, getJSON, setJSON, store, FINAL_STATUSES, usableInThisMode } from "../../lib/sf365/core.mjs";

const MAX_DOWNLOADS = 10;

export default async (req, context) => {
  const token = String(context.params.token || "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return json({ error: "token_non_valido" }, 400);
  const d = await getJSON("deliveries", token);
  if (!d) return json({ error: "consegna_sconosciuta" }, 404);
  const p = findProduct(d.sku);
  const lic = d.license ? await getJSON("licenses", d.license) : null;
  const url = new URL(req.url);
  // Lo scaricamento richiede un pagamento registrato e non rimborsato né stornato, anche per i prodotti senza
  // licenza (solo file), e non vale per le consegne di prova quando le vendite reali sono attive.
  const src = d.source ? await getJSON("transactions", d.source) : null;
  const blocked = !src ? "pagamento_non_registrato" : FINAL_STATUSES.includes(src.status) ? "pagamento_rimborsato"
    : !usableInThisMode(d, context) ? "consegna_di_prova" : null;

  if (url.pathname.startsWith("/api/delivery/")) {
    return json({
      payment_status: src ? src.status || null : null,
      product: p ? publicProduct(p) : { sku: d.sku },
      license: d.license, license_status: lic ? lic.status : null, license_expires_at: lic ? lic.expires_at : null,
      download: d.file && !blocked ? `/d/${token}` : null, downloads_left: d.file ? Math.max(0, MAX_DOWNLOADS - d.downloads) : null
    });
  }
  // /d/:token — scaricamento
  if (!d.file) return json({ error: "nessun_file" }, 404);
  if (lic && lic.status !== "active") return json({ error: "licenza_non_attiva" }, 403);
  if (blocked) return json({ error: blocked }, 403);
  if (d.downloads >= MAX_DOWNLOADS) return json({ error: "limite_scaricamenti" }, 429);
  const files = await store("files");
  const blob = await files.get(d.file, { type: "arrayBuffer" });
  if (!blob) return json({ error: "file_non_disponibile" }, 404);
  d.downloads += 1;
  await setJSON("deliveries", token, d);
  const name = d.file.split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(blob, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
};

export const config = { path: ["/api/delivery/:token", "/d/:token"], method: ["GET"] };
