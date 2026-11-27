/* Paddle Billing: API, firma webhook, sincronizzazione catalogo */
import { env, mode, hmacSha256Hex, timingSafeEqualStr } from "./core.mjs";

export function base() {
  return mode("paddle").live ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}
export async function api(path, { method = "GET", body } = {}) {
  const key = env("PADDLE_API_KEY");
  if (!key) throw new Error("paddle_non_configurato");
  const r = await fetch(`${base()}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

/* Intestazione Paddle-Signature: "ts=1671552777;h1=<hex>" — HMAC-SHA256 di "<ts>:<corpo grezzo>" */
export async function verifySignature(header, rawBody, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(";").map((p) => p.split("=").map((s) => s.trim())));
  const ts = Number(parts.ts);
  if (!ts || !parts.h1) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${parts.ts}:${rawBody}`);
  return timingSafeEqualStr(expected, parts.h1);
}

export function productBody(p) {
  return { name: p.name.slice(0, 200), description: p.description, tax_category: p.tax_category || "standard", custom_data: { sku: p.sku, project: p.project } };
}
export function priceBody(p, productId) {
  const cents = String(Math.round(Number(p.price) * 100));
  const b = { product_id: productId, description: p.name.slice(0, 200), unit_price: { amount: cents, currency_code: p.currency }, custom_data: { sku: p.sku } };
  b.billing_cycle = p.type === "subscription" ? { interval: p.interval, frequency: 1 } : null;
  return b;
}
