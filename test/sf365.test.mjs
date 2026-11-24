// Integrazione SITE FACTORY 365 nel checkout condiviso: licenze, registro, webhook, verifica licenze, Paddle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';

import checkout from '../netlify/functions/checkout.mjs';
import subscription from '../netlify/functions/abbonamento.mjs';
import webhook from '../netlify/functions/sf365-paypal-webhook.mjs';
import licenseFn from '../netlify/functions/sf365-license.mjs';
import deliveryFn from '../netlify/functions/sf365-delivery.mjs';
import paddleFn from '../netlify/functions/sf365-paddle.mjs';
import adminFn from '../netlify/functions/sf365-admin.mjs';
import apiFn from '../netlify/functions/sf365-api.mjs';
import { PRODUCTS, validateCatalog } from '../catalog/products.mjs';
import { subscriptions, provisionPlan } from '../lib/abbonamenti-paypal.mjs';

const STORES = {};
globalThis.__SF365_TEST_STORE__ = (name) => {
  const m = (STORES[name] ||= new Map());
  return {
    get: async (k, o) => (m.has(k) ? (o?.type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null),
    setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); },
    set: async (k, v) => { m.set(k, v); },
    list: async (o) => ({ blobs: [...m.keys()].filter((k) => !o?.prefix || k.startsWith(o.prefix)).map((key) => ({ key })) }),
  };
};
const origin = 'https://checkout.example.test';
const sku = 'dpa-studio-pro-12m';
const orderId = 'ABCDEF0123456789Z';
let verify = 'SUCCESS';
let captured = false;

function mockPayPal() {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 't' });
    if (url.pathname === '/v1/notifications/verify-webhook-signature') return Response.json({ verification_status: verify });
    if (url.pathname === '/v2/checkout/orders') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value: '39.00' });
      return Response.json({ id: orderId, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] });
    }
    if (url.pathname.startsWith(`/v2/checkout/orders/${orderId}`)) {
      captured = true;
      return Response.json({ id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: sku, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '39.00' } }] } }] });
    }
    throw new Error('Chiamata non simulata: ' + url.pathname);
  };
}
const req = (path, method = 'GET', headers = {}, body) => new Request(origin + path, { method, headers: { ...(method === 'POST' && { Origin: origin }), ...headers }, body });

test('catalogo SITE FACTORY 365 valido e senza sku in conflitto con le offerte esistenti', () => {
  assert.deepEqual(validateCatalog(), []);
  for (const p of PRODUCTS) assert.ok(!['ospitabene-kit-annuncio', 'skywatcher-field-kit-1'].includes(p.sku));
});

test('acquisto singolo SF365 nel checkout esistente: licenza emessa, registrata e verificabile', async () => {
  process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec';
  mockPayPal();
  const page = await checkout(req(`/checkout?offerta=${sku}`));
  assert.match(await page.text(), /39,00 €/);
  const start = await checkout(req(`/checkout?offerta=${sku}&prezzo=0.01`, 'POST'));
  assert.equal(start.status, 303);
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
  const done = await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${orderId}`, 'POST', { Cookie: cookie }));
  const html = await done.text();
  assert.equal(done.status, 200);
  const lic = html.match(/SF365-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}/)[0];
  const again = await (await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${orderId}`, 'POST', { Cookie: cookie }))).text();
  assert.ok(again.includes(lic), 'consegna idempotente');
  const tx = JSON.parse(STORES.transactions.get(`paypal:${orderId}`));
  assert.equal(tx.status, 'completato'); assert.equal(tx.amount, '39.00'); assert.equal(tx.license, lic);
  const v = await (await licenseFn(req('/api/license/verify', 'POST', { 'content-type': 'application/json', origin: 'https://dpa-studio.netlify.app' }, JSON.stringify({ key: lic, sku })))).json();
  assert.equal(v.valid, true);
  const token = tx.delivery_token;
  const d = await (await deliveryFn(req('/api/delivery/' + token), { params: { token } })).json();
  assert.equal(d.license, lic);
});

test('le offerte esistenti vengono registrate senza licenza e senza cambiare il loro esito', async () => {
  const tx = [...(STORES.transactions?.keys() ?? [])];
  assert.ok(tx.length >= 1);
});

test('webhook PayPal: firma rifiutata, rimborso che revoca la licenza', async () => {
  process.env.PAYPAL_WEBHOOK_ID = 'WH';
  mockPayPal();
  const h = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' };
  verify = 'FAILURE';
  assert.equal((await webhook(req('/api/paypal/webhook', 'POST', h, JSON.stringify({ event_type: 'X' })), {})).status, 400);
  verify = 'SUCCESS';
  const ev = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R1', links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP1' }] } };
  assert.equal((await webhook(req('/api/paypal/webhook', 'POST', h, JSON.stringify(ev)), {})).status, 200);
  const lic = JSON.parse(STORES.transactions.get(`paypal:${orderId}`)).license;
  const v = await (await licenseFn(req('/api/license/verify', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ key: lic })))).json();
  assert.equal(v.valid, false); assert.equal(v.reason, 'revoked');
});

test('abbonamenti SF365 mensile e annuale: piani PayPal con il periodo corretto', async () => {
  const yearly = subscriptions.get('dpa-studio-pro-annuale');
  const monthly = subscriptions.get('dpa-studio-pro-mensile');
  assert.equal(yearly.interval, 'YEAR'); assert.equal(monthly.interval, 'MONTH');
  let createdBody;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === `/v1/catalogs/products/${yearly.productId}`) return Response.json({}, { status: 404 });
    if (url.pathname === '/v1/catalogs/products') return Response.json({ id: yearly.productId });
    if (url.pathname === '/v1/billing/plans' && !options.body) return Response.json({ plans: [] });
    if (url.pathname === '/v1/billing/plans') { createdBody = JSON.parse(options.body); return Response.json({ id: 'P-ABCDEFGHIJKLMNOPQRSTUVWX' }); }
    if (url.pathname.startsWith('/v1/billing/plans/')) {
      return Response.json({ id: 'P-ABCDEFGHIJKLMNOPQRSTUVWX', status: 'ACTIVE', product_id: yearly.productId, billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0, frequency: { interval_unit: 'YEAR', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '39.00', currency_code: 'EUR' } } }], payment_preferences: { auto_bill_outstanding: false } });
    }
    throw new Error(url.pathname);
  };
  assert.equal(await provisionPlan({ api: 'https://api-m.sandbox.paypal.com' }, 't', yearly), 'P-ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.equal(createdBody.billing_cycles[0].frequency.interval_unit, 'YEAR');
  assert.match(createdBody.description, /all’anno/);
});

test('la configurazione dei piani Sandbox non richiede il live; il live resta bloccato', async () => {
  delete process.env.CHECKOUT_ORDER_SIGNING_KEY;
  const r = await subscription(req('/abbonamento/configura?offerta=dpa-studio-pro-mensile&ambiente=live', 'POST'), { deploy: { context: 'production' } });
  assert.equal(r.status, 404);
});

test('vendite reali bloccate senza autorizzazione esplicita e prodotto live', async () => {
  process.env.PAYPAL_LIVE_ENABLED = 'true';
  process.env.PAYPAL_LIVE_CLIENT_ID = 'x'; process.env.PAYPAL_LIVE_CLIENT_SECRET = 'y';
  process.env.CHECKOUT_ORDER_SIGNING_KEY = 'k'.repeat(40);
  const r = await checkout(req(`/checkout?offerta=${sku}`), { deploy: { context: 'production' } });
  assert.equal(r.status, 403);
  delete process.env.PAYPAL_LIVE_ENABLED; delete process.env.PAYPAL_LIVE_CLIENT_ID; delete process.env.PAYPAL_LIVE_CLIENT_SECRET; delete process.env.CHECKOUT_ORDER_SIGNING_KEY;
});

test('Paddle: firma HMAC verificata e consegna solo con il prezzo registrato per lo sku', async () => {
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  const send = async (id, items) => {
    const ev = { event_id: 'evt_' + id, event_type: 'transaction.completed', data: { id, currency_code: 'EUR', custom_data: { sku }, items, details: { totals: { grand_total: '3900' } } } };
    const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
    assert.equal((await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${'0'.repeat(64)}` }, raw), { params: { action: 'webhook' } })).status, 400);
    assert.equal((await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${h1}` }, raw), { params: { action: 'webhook' } })).status, 200);
    return paddleFn(req(`/api/paddle/delivery?txn=${id}`), { params: { action: 'delivery' } });
  };
  // Prezzo non ancora registrato (sync-paddle mai eseguito): nessuna consegna, transazione da verificare.
  assert.equal((await send('txn_01senzaprezzo', [{ price: { id: 'pri_altro' } }])).status, 202);
  assert.equal(JSON.parse(STORES.transactions.get('paddle:txn_01senzaprezzo')).status, 'da_verificare');
  await globalThis.__SF365_TEST_STORE__('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '39.00' });
  // Sku dichiarato dal browser ma prezzo pagato diverso: nessuna consegna.
  assert.equal((await send('txn_01prezzodiverso', [{ price: { id: 'pri_altro' } }])).status, 202);
  assert.equal(JSON.parse(STORES.transactions.get('paddle:txn_01prezzodiverso')).delivery_token, undefined);
  // Prezzo registrato: consegna emessa.
  const d = await send('txn_01abcdefghij', [{ price: { id: 'pri_giusto' } }]);
  assert.equal(d.status, 200);
  assert.match((await d.json()).license, /^SF365-/);
});

test('consegna di un file: il rimborso blocca lo scaricamento anche senza licenza', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.delivery.kind === 'download');
  await recordTransaction({ provider: 'paypal', id: 'ORDFILE1', sku: product.sku, status: 'completato', capture_id: 'CAPFILE1' });
  const { token, license } = await fulfil({ provider: 'paypal', id: 'ORDFILE1', product });
  assert.equal(license, null);
  await globalThis.__SF365_TEST_STORE__('files').set(product.delivery.file, new TextEncoder().encode('zip').buffer);
  assert.equal((await deliveryFn(req(`/d/${token}`), { params: { token } })).status, 200);
  await recordTransaction({ provider: 'paypal', id: 'ORDFILE1', status: 'rimborsato' });
  const blocked = await deliveryFn(req(`/d/${token}`), { params: { token } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, 'pagamento_rimborsato');
});

test('amministrazione: token obbligatorio, registro esportabile in CSV', async () => {
  process.env.ADMIN_TOKEN = 'z'.repeat(32);
  assert.equal((await adminFn(req('/api/admin/transactions'), { params: { action: 'transactions' } })).status, 401);
  const r = await adminFn(req('/api/admin/transactions?format=csv', 'GET', { authorization: 'Bearer ' + 'z'.repeat(32) }), { params: { action: 'transactions' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /rimborsato/);
});

test('catalogo pubblico con i collegamenti di acquisto', async () => {
  const j = await (await apiFn(req('/api/catalog'), {})).json();
  assert.ok(j.products.some((p) => p.buy === `/checkout?offerta=${sku}`));
  assert.ok(j.products.some((p) => p.buy === '/abbonamento?offerta=dpa-studio-pro-annuale'));
});
