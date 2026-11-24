/* SITE FACTORY 365 — servizi condivisi del checkout unificato: modalità, registro, licenze, consegne. */
import { allowedOrigins } from '../../catalog/products.mjs';
import { paymentSettings } from '../paypal.mjs';

export function env(name, fallback = '') {
  const v = (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get(name)) ?? process.env[name];
  return v === undefined || v === null || v === '' ? fallback : v;
}

/*
 * Vendite reali solo se TUTTE vere:
 *  - PayPal: PAYPAL_LIVE_ENABLED=true sul deploy di produzione (regola già esistente del checkout),
 *    Paddle: PADDLE_ENV=live;
 *  - LIVE_PAYMENTS_APPROVED=si-autorizzato-dal-titolare;
 *  - prodotto con status "live" nel catalogo.
 */
export const LIVE_APPROVAL_PHRASE = 'si-autorizzato-dal-titolare';
export function mode(provider, context) {
  const live = provider === 'paddle' ? env('PADDLE_ENV', 'sandbox') === 'live' : paymentSettings(context).live;
  const approved = env('LIVE_PAYMENTS_APPROVED') === LIVE_APPROVAL_PHRASE;
  return { live, approved, label: live ? 'live' : 'sandbox' };
}
export function sellable(product, provider, context) {
  const m = mode(provider, context);
  if (!product) return { ok: false, reason: 'prodotto_sconosciuto' };
  if (product.status === 'draft') return { ok: false, reason: 'prodotto_non_in_vendita' };
  if (m.live) {
    if (!m.approved) return { ok: false, reason: 'vendite_reali_non_autorizzate' };
    if (product.status !== 'live') return { ok: false, reason: 'prodotto_non_autorizzato_live' };
  }
  return { ok: true, mode: m.label };
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
export function corsHeaders(req) {
  const origin = req.headers.get('origin') || '';
  const list = allowedOrigins().concat(env('EXTRA_ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean));
  if (!list.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' };
}
export async function readJson(req, max = 20000) {
  const t = await req.text();
  if (t.length > max) throw new Error('corpo_troppo_grande');
  return t ? JSON.parse(t) : {};
}

export function timingSafeEqualStr(a, b) {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let d = 0;
  for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}
export function isAdmin(req) {
  const tok = env('ADMIN_TOKEN');
  if (!tok || tok.length < 24) return false;
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && timingSafeEqualStr(h.slice(7), tok);
}
export function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Buffer.from(a).toString('base64url');
}
export function licenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(20);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < 20; i++) { s += alphabet[a[i] % 32]; if (i % 5 === 4 && i < 19) s += '-'; }
  return 'SF365-' + s;
}
export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Buffer.from(sig).toString('hex');
}

/* Registro centralizzato su Netlify Blobs (archivi sf365-*) */
let getStoreFn = null;
export async function store(name) {
  if (globalThis.__SF365_TEST_STORE__) return globalThis.__SF365_TEST_STORE__(name);
  if (!getStoreFn) getStoreFn = (await import('@netlify/blobs')).getStore;
  return getStoreFn({ name: 'sf365-' + name, consistency: 'strong' });
}
export async function getJSON(storeName, key) {
  return (await (await store(storeName)).get(key, { type: 'json' })) ?? null;
}
export async function setJSON(storeName, key, value) {
  await (await store(storeName)).setJSON(key, value);
  return value;
}
export async function listKeys(storeName, prefix = '') {
  const out = await (await store(storeName)).list(prefix ? { prefix } : undefined);
  return out.blobs.map((b) => b.key);
}
export async function recordTransaction(tx, { reopen = false } = {}) {
  const key = `${tx.provider}:${tx.id}`;
  const prev = (await getJSON('transactions', key)) || {};
  const now = new Date().toISOString();
  const merged = { ...prev, ...tx, created_at: prev.created_at || now, updated_at: now, events: [...(prev.events || []), ...(tx.events || [])].slice(-50) };
  // Indice catturaPayPal → transazione: i webhook di rimborso la trovano senza leggere tutto il registro.
  if (tx.capture_id && tx.capture_id !== prev.capture_id) await setJSON('index', `capture:${tx.capture_id}`, { key });
  // Un acquisto singolo rimborsato o stornato resta tale: un evento «completato» ripetuto o arrivato in ritardo
  // non deve riaprire la consegna. (Gli abbonamenti hanno stati propri e possono riattivarsi.)
  // Solo uno storno annullato o una riattivazione manuale dell'amministratore possono riaprirlo (reopen).
  if (!reopen && ONE_TIME_PROVIDERS.includes(tx.provider) && FINAL_STATUSES.includes(prev.status) && !FINAL_STATUSES.includes(tx.status)) merged.status = prev.status;
  return setJSON('transactions', key, merged);
}
export const FINAL_STATUSES = ['rimborsato', 'stornato'];
const ONE_TIME_PROVIDERS = ['paypal', 'paddle'];
/* Vero se almeno un fornitore è in vendita reale: da quel momento licenze e file emessi in prova non valgono più. */
export function anyLive(context) {
  return mode('paypal', context).live || mode('paddle', context).live;
}
export function usableInThisMode(record, context) {
  return !anyLive(context) || (record && record.mode === 'live');
}
export function addDays(d, days) { return new Date(d.getTime() + days * 86400000).toISOString(); }

/* Emissione idempotente di licenza e token di consegna per una transazione. */
export async function fulfil({ provider, id, product, expiresAt, mode: issuedIn = 'sandbox' }) {
  const txKey = `${provider}:${id}`;
  const tx = await getJSON('transactions', txKey);
  if (tx && tx.delivery_token) return { license: tx.license || null, token: tx.delivery_token, already: true };
  // Pagamento già rimborsato o stornato (per esempio rimborso arrivato prima della conferma): nessuna consegna.
  if (tx && FINAL_STATUSES.includes(tx.status)) return null;
  let lic = null;
  if (product.delivery.kind.includes('license')) {
    lic = licenseKey();
    const exp = expiresAt !== undefined ? expiresAt
      : product.delivery.license_days ? addDays(new Date(), product.delivery.license_days) : null;
    await setJSON('licenses', lic, { key: lic, sku: product.sku, status: 'active', expires_at: exp, source: txKey, mode: issuedIn, created_at: new Date().toISOString() });
  }
  const token = randomToken();
  await setJSON('deliveries', token, { token, sku: product.sku, license: lic, source: txKey, mode: issuedIn, file: product.delivery.file || null, created_at: new Date().toISOString(), downloads: 0 });
  await recordTransaction({ provider, id, sku: product.sku, project: product.project, license: lic, delivery_token: token, events: [{ at: new Date().toISOString(), type: 'consegna_emessa' }] });
  return { license: lic, token, already: false };
}
export async function setLicenseStatus(licKey, status, expiresAt) {
  if (!licKey) return null;
  const l = await getJSON('licenses', licKey);
  if (!l) return null;
  l.status = status;
  if (expiresAt !== undefined) l.expires_at = expiresAt;
  l.updated_at = new Date().toISOString();
  return setJSON('licenses', licKey, l);
}

/*
 * Abbonamenti: lo stato della licenza si ricava sempre dal record dell'abbonamento, con due informazioni separate:
 *  - status: ciclo di vita dichiarato dal fornitore (attivo, past_due, disdetto, canceled, paused, sospeso, scaduto);
 *  - payment_hold: id dell'ultimo pagamento rimborsato o stornato. Finché c'è, la licenza resta revocata.
 * Il blocco si toglie solo con un pagamento successivo riuscito, con uno storno annullato o con una riattivazione
 * manuale; una disdetta, una sospensione o una riattivazione del ciclo di vita non lo tolgono.
 */
const SUB_ACTIVE = ['attivo', 'past_due'];
/* Eventi del ciclo di vita fuori ordine: vero se l'evento è più vecchio dell'ultimo già applicato. */
export function staleLifecycle(sub, eventTime) {
  const t = Date.parse(eventTime || ''), last = Date.parse((sub && sub.lifecycle_at) || '');
  return Number.isFinite(t) && Number.isFinite(last) && t < last;
}
const SUB_EXPIRED = ['scaduto', 'canceled'];
export function subscriptionLicenseState(sub) {
  if (!sub || !sub.license || !sub.status) return null;
  if (sub.payment_hold) return { status: 'revoked' };
  if (SUB_ACTIVE.includes(sub.status)) return { status: 'active', expiresAt: null };
  if (sub.status === 'disdetto') return { status: 'active', expiresAt: sub.paid_until || new Date().toISOString() };
  if (SUB_EXPIRED.includes(sub.status)) return { status: 'expired' };
  return { status: 'revoked' };
}
export async function syncSubscriptionLicense(provider, id) {
  const sub = await getJSON('transactions', `${provider}:${id}`);
  const st = subscriptionLicenseState(sub);
  if (!st) return null;
  return setLicenseStatus(sub.license, st.status, st.expiresAt);
}

/* Registrazione best-effort: un errore del registro non deve mai bloccare un pagamento già riuscito. */
export async function safely(fn) {
  try { return await fn(); } catch (e) { console.error('[sf365] registro non aggiornato:', e && e.message); return null; }
}
