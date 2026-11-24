// Paddle (alternativa): webhook firmati e recupero della consegna dopo il checkout.
import { findProduct } from "../../catalog/products.mjs";
import { json, env, recordTransaction, fulfil, getJSON, setLicenseStatus, sellable } from "../../lib/sf365/core.mjs";
import { verifySignature } from "../../lib/sf365/paddle.mjs";

async function webhook(req, context) {
  const raw = await req.text();
  const ok = await verifySignature(req.headers.get("paddle-signature"), raw, env("PADDLE_WEBHOOK_SECRET"));
  if (!ok) return json({ error: "firma_non_valida" }, 400);
  const ev = JSON.parse(raw);
  const d = ev.data || {}, now = new Date().toISOString();
  const log = { at: now, type: "webhook:" + ev.event_type, detail: ev.event_id };
  const sku = d.custom_data && d.custom_data.sku;
  switch (ev.event_type) {
    case "transaction.completed": {
      const p = findProduct(sku);
      if (!p || !sellable(p, "paddle", context).ok) { await recordTransaction({ provider: "paddle", id: d.id, sku: sku || null, status: "da_verificare", events: [log] }); break; }
      const items = d.items || [];
      const ids = (await getJSON("provider-ids", p.sku)) || {};
      if (ids.paddle_price_id && !items.some((i) => i.price && i.price.id === ids.paddle_price_id)) {
        await recordTransaction({ provider: "paddle", id: d.id, sku: p.sku, status: "da_verificare", events: [{ ...log, detail: "prezzo_non_corrispondente" }] });
        break;
      }
      const totals = (d.details && d.details.totals) || {};
      await recordTransaction({ provider: "paddle", id: d.id, sku: p.sku, project: p.project, status: "completato", amount: totals.grand_total || null, currency: d.currency_code, subscription_id: d.subscription_id || null, mode: sellable(p, "paddle", context).mode, events: [log] });
      const out = await fulfil({ provider: "paddle", id: d.id, product: p, expiresAt: p.type === "subscription" ? null : undefined });
      if (d.subscription_id) await recordTransaction({ provider: "paddle-sub", id: d.subscription_id, sku: p.sku, status: "attivo", license: out.license, events: [log] });
      break;
    }
    case "subscription.canceled":
    case "subscription.paused":
    case "subscription.past_due": {
      const tx = await getJSON("transactions", `paddle-sub:${d.id}`);
      const st = ev.event_type.split(".")[1];
      await recordTransaction({ provider: "paddle-sub", id: d.id, status: st, events: [log] });
      if (tx && tx.license && st !== "past_due") await setLicenseStatus(tx.license, st === "canceled" ? "expired" : "revoked");
      break;
    }
    case "subscription.activated":
    case "subscription.resumed": {
      const tx = await getJSON("transactions", `paddle-sub:${d.id}`);
      await recordTransaction({ provider: "paddle-sub", id: d.id, status: "attivo", events: [log] });
      if (tx && tx.license) await setLicenseStatus(tx.license, "active", null);
      break;
    }
    case "adjustment.created":
    case "adjustment.updated": {
      if (d.action === "refund" && d.status === "approved" && d.transaction_id) {
        const tx = await getJSON("transactions", `paddle:${d.transaction_id}`);
        await recordTransaction({ provider: "paddle", id: d.transaction_id, status: "rimborsato", events: [log] });
        if (tx && tx.license) await setLicenseStatus(tx.license, "revoked");
      }
      break;
    }
    default:
      await recordTransaction({ provider: "paddle-evento", id: ev.event_id || crypto.randomUUID(), status: "ricevuto", events: [log] });
  }
  return json({ ok: true });
}

// Il browser, dopo checkout.completed, interroga la consegna creata dal webhook.
async function delivery(req) {
  const txn = new URL(req.url).searchParams.get("txn") || "";
  if (!/^txn_[a-z0-9]{10,40}$/.test(txn)) return json({ error: "transazione_non_valida" }, 400);
  const tx = await getJSON("transactions", `paddle:${txn}`);
  if (!tx || tx.status !== "completato" || !tx.delivery_token) return json({ status: tx ? tx.status : "in_attesa" }, 202);
  // la consegna tramite id di transazione è disponibile solo nell'ora successiva al pagamento
  if (Date.now() - new Date(tx.created_at).getTime() > 3600000) return json({ error: "finestra_scaduta" }, 410);
  return json({ status: "completato", sku: tx.sku, license: tx.license, delivery_token: tx.delivery_token });
}

export default async (req, context) => {
  try {
    if (context.params.action === "webhook" && req.method === "POST") return await webhook(req, context);
    if (context.params.action === "delivery" && req.method === "GET") return await delivery(req);
    return json({ error: "azione_sconosciuta" }, 404);
  } catch (e) {
    return json({ error: "errore_interno" }, 500);
  }
};

export const config = { path: "/api/paddle/:action" };
