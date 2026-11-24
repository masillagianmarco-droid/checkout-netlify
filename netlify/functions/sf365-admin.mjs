// Amministrazione (solo con ADMIN_TOKEN): sincronizzazione cataloghi, registro, file, revoche.
import { PRODUCTS, findProduct, validateCatalog } from "../../catalog/products.mjs";
import { json, isAdmin, getJSON, setJSON, listKeys, store, setLicenseStatus, mode } from "../../lib/sf365/core.mjs";
import * as PD from "../../lib/sf365/paddle.mjs";

async function syncPaddle(context) {
  const out = [];
  for (const p of PRODUCTS.filter((x) => x.status !== "draft")) {
    const ids = (await getJSON("provider-ids", p.sku)) || {};
    const envTag = mode("paddle", context).label;
    if (ids.paddle_env === envTag && ids.paddle_price_id && ids.paddle_price === p.price) { out.push({ sku: p.sku, price_id: ids.paddle_price_id, created: false }); continue; }
    let productId = ids.paddle_env === envTag ? ids.paddle_product_id : null;
    if (!productId) {
      const r = await PD.api("/products", { method: "POST", body: PD.productBody(p) });
      if (!r.ok) { out.push({ sku: p.sku, error: "prodotto_" + r.status, detail: r.data && r.data.error && r.data.error.code }); continue; }
      productId = r.data.data.id;
    }
    const pr = await PD.api("/prices", { method: "POST", body: PD.priceBody(p, productId) });
    if (!pr.ok) { out.push({ sku: p.sku, error: "prezzo_" + pr.status, detail: pr.data && pr.data.error && pr.data.error.code }); continue; }
    await setJSON("provider-ids", p.sku, { ...ids, paddle_env: envTag, paddle_product_id: productId, paddle_price_id: pr.data.data.id, paddle_price: p.price });
    out.push({ sku: p.sku, price_id: pr.data.data.id, created: true });
  }
  return out;
}

async function dump(name, prefix) {
  const keys = await listKeys(name, prefix);
  const rows = [];
  for (const k of keys) rows.push(await getJSON(name, k));
  return rows;
}

export default async (req, context) => {
  if (!isAdmin(req)) return json({ error: "non_autorizzato" }, 401);
  const a = context.params.action;
  try {
    if (a === "catalog-check" && req.method === "GET") return json({ errors: validateCatalog(), products: PRODUCTS.length, paypal: mode("paypal", context), paddle: mode("paddle", context) });
    if (a === "sync-paddle" && req.method === "POST") return json({ env: mode("paddle", context).label, results: await syncPaddle(context) });
    if (a === "transactions" && req.method === "GET") {
      const rows = await dump("transactions");
      const url = new URL(req.url);
      if (url.searchParams.get("format") === "csv") {
        const head = ["provider", "id", "sku", "project", "status", "amount", "currency", "mode", "license", "created_at", "updated_at"];
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const csv = [head.join(";")].concat(rows.map((r) => head.map((h) => esc(r[h])).join(";"))).join("\r\n");
        return new Response("﻿" + csv, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
      }
      return json({ count: rows.length, transactions: rows });
    }
    if (a === "licenses" && req.method === "GET") return json({ licenses: await dump("licenses") });
    if (a === "revoke" && req.method === "POST") {
      const { key } = await req.json();
      const l = await setLicenseStatus(String(key || ""), "revoked");
      return l ? json({ ok: true, license: l }) : json({ error: "sconosciuta" }, 404);
    }
    if (a === "upload" && req.method === "PUT") {
      const sku = new URL(req.url).searchParams.get("sku");
      const p = findProduct(sku || "");
      if (!p || !p.delivery.file) return json({ error: "prodotto_senza_file" }, 400);
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 4.5 * 1024 * 1024) return json({ error: "file_troppo_grande" }, 413);
      await (await store("files")).set(p.delivery.file, buf);
      return json({ ok: true, file: p.delivery.file, bytes: buf.byteLength });
    }
    return json({ error: "azione_sconosciuta" }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/admin/:action" };
