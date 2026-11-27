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
const sku = 'avvicendo-pro-12m'; // prodotto di prova: DPA Studio è sospeso (draft) dal 24/11
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
      assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value: '34.90' });
      return Response.json({ id: orderId, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] });
    }
    if (url.pathname.startsWith(`/v2/checkout/orders/${orderId}`)) {
      captured = true;
      return Response.json({ id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: sku, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '34.90' } }] } }] });
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
  assert.match(await page.text(), /34,90 €/);
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
  assert.equal(tx.status, 'completato'); assert.equal(tx.amount, '34.90'); assert.equal(tx.license, lic);
  const v = await (await licenseFn(req('/api/license/verify', 'POST', { 'content-type': 'application/json', origin: 'https://avvicendo.netlify.app' }, JSON.stringify({ key: lic, sku })))).json();
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
  const yearly = subscriptions.get('avvicendo-pro-annuale');
  const monthly = subscriptions.get('avvicendo-pro-mensile');
  assert.equal(yearly.interval, 'YEAR'); assert.equal(monthly.interval, 'MONTH');
  let createdBody;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === `/v1/catalogs/products/${yearly.productId}`) return Response.json({}, { status: 404 });
    if (url.pathname === '/v1/catalogs/products') return Response.json({ id: yearly.productId });
    if (url.pathname === '/v1/billing/plans' && !options.body) return Response.json({ plans: [] });
    if (url.pathname === '/v1/billing/plans') { createdBody = JSON.parse(options.body); return Response.json({ id: 'P-ABCDEFGHIJKLMNOPQRSTUVWX' }); }
    if (url.pathname.startsWith('/v1/billing/plans/')) {
      return Response.json({ id: 'P-ABCDEFGHIJKLMNOPQRSTUVWX', status: 'ACTIVE', product_id: yearly.productId, billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0, frequency: { interval_unit: 'YEAR', interval_count: 1 }, pricing_scheme: { fixed_price: { value: '29.00', currency_code: 'EUR' } } }], payment_preferences: { auto_bill_outstanding: false } });
    }
    throw new Error(url.pathname);
  };
  assert.equal(await provisionPlan({ api: 'https://api-m.sandbox.paypal.com' }, 't', yearly), 'P-ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.equal(createdBody.billing_cycles[0].frequency.interval_unit, 'YEAR');
  assert.match(createdBody.description, /all’anno/);
});

test('la configurazione dei piani Sandbox non richiede il live; il live resta bloccato', async () => {
  delete process.env.CHECKOUT_ORDER_SIGNING_KEY;
  const r = await subscription(req('/abbonamento/configura?offerta=avvicendo-pro-mensile&ambiente=live', 'POST'), { deploy: { context: 'production' } });
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
    const ev = { event_id: 'evt_' + id, event_type: 'transaction.completed', data: { id, currency_code: 'EUR', custom_data: { sku }, items, details: { totals: { grand_total: '3490' } } } };
    const raw = JSON.stringify(ev), ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
    assert.equal((await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${'0'.repeat(64)}` }, raw), { params: { action: 'webhook' } })).status, 400);
    assert.equal((await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${h1}` }, raw), { params: { action: 'webhook' } })).status, 200);
    return paddleFn(req(`/api/paddle/delivery?txn=${id}`), { params: { action: 'delivery' } });
  };
  // Prezzo non ancora registrato (sync-paddle mai eseguito): nessuna consegna, transazione da verificare.
  assert.equal((await send('txn_01senzaprezzo', [{ price: { id: 'pri_altro' } }])).status, 202);
  assert.equal(JSON.parse(STORES.transactions.get('paddle:txn_01senzaprezzo')).status, 'da_verificare');
  await globalThis.__SF365_TEST_STORE__('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
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

// ---- Rilievi della revisione indipendente del 24/11/2026
const ST = (name) => globalThis.__SF365_TEST_STORE__(name);
const txOf = (key) => JSON.parse(STORES.transactions.get(key));
async function paddleEvent(event_type, data) {
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  const raw = JSON.stringify({ event_id: 'evt_' + Math.random().toString(36).slice(2), event_type, data }), ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
  const r = await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${h1}` }, raw), { params: { action: 'webhook' } });
  assert.equal(r.status, 200);
}
const paddleSale = (id, extra = {}) => paddleEvent('transaction.completed', { id, currency_code: 'EUR', custom_data: { sku }, items: [{ price: { id: 'pri_giusto' } }], details: { totals: { grand_total: '3490' } }, ...extra });
const verifyLicence = async (key, context) => (await licenseFn(req('/api/license/verify', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ key })), context)).json();

test('un rimborso è definitivo: un evento «completato» ripetuto non riapre lo scaricamento', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.delivery.kind === 'download');
  await recordTransaction({ provider: 'paypal', id: 'ORDFILE2', sku: product.sku, status: 'completato', capture_id: 'CAPFILE2' });
  const { token } = await fulfil({ provider: 'paypal', id: 'ORDFILE2', product });
  process.env.PAYPAL_WEBHOOK_ID = 'WH'; mockPayPal(); verify = 'SUCCESS';
  const h = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' };
  const hook = (ev) => webhook(req('/api/paypal/webhook', 'POST', h, JSON.stringify(ev)), {});
  await hook({ id: 'WH-R2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R2', links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPFILE2' }] } });
  assert.equal(txOf('paypal:ORDFILE2').status, 'rimborsato');
  await hook({ id: 'WH-C2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPFILE2', amount: { value: '9.90', currency_code: 'EUR' }, supplementary_data: { related_ids: { order_id: 'ORDFILE2' } } } });
  assert.equal(txOf('paypal:ORDFILE2').status, 'rimborsato', 'lo stato non torna a completato');
  assert.equal((await deliveryFn(req(`/d/${token}`), { params: { token } })).status, 403);
  const info = await (await deliveryFn(req(`/api/delivery/${token}`), { params: { token } })).json();
  assert.equal(info.download, null); assert.equal(info.payment_status, 'rimborsato');
});

test('consegna senza pagamento registrato: nessuno scaricamento', async () => {
  const token = 'tokensenzapagamento000000';
  await ST('deliveries').setJSON(token, { token, sku: 'forfettario-in-ordine-2026', license: null, source: 'paypal:INESISTENTE', file: 'sf365/forfettario-in-ordine-2026-v1.0.zip', downloads: 0 });
  const r = await deliveryFn(req(`/d/${token}`), { params: { token } });
  assert.equal(r.status, 403); assert.equal((await r.json()).error, 'pagamento_non_registrato');
});

test('Paddle: storno (chargeback) che revoca la licenza; rimborso non approvato senza effetto', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01storno00001');
  const lic = txOf('paddle:txn_01storno00001').license;
  assert.equal((await verifyLicence(lic)).valid, true);
  await paddleEvent('adjustment.created', { id: 'adj_1', action: 'refund', status: 'pending_approval', transaction_id: 'txn_01storno00001' });
  assert.equal((await verifyLicence(lic)).valid, true);
  await paddleEvent('adjustment.created', { id: 'adj_2', action: 'chargeback', status: 'approved', transaction_id: 'txn_01storno00001' });
  assert.equal(txOf('paddle:txn_01storno00001').status, 'stornato');
  assert.equal((await verifyLicence(lic)).reason, 'revoked');
  await paddleSale('txn_01storno00001');
  assert.equal(txOf('paddle:txn_01storno00001').status, 'stornato', 'evento ripetuto: lo storno resta');
});

test('Paddle: il rinnovo di un abbonamento non emette una seconda licenza', async () => {
  await paddleSale('txn_01abbonam0001', { subscription_id: 'sub_01abc' });
  const lic = txOf('paddle:txn_01abbonam0001').license;
  const before = STORES.licenses.size;
  await paddleSale('txn_01abbonam0002', { subscription_id: 'sub_01abc' });
  assert.equal(STORES.licenses.size, before, 'nessuna licenza nuova al rinnovo');
  assert.equal(txOf('paddle-sub:sub_01abc').license, lic);
  await paddleEvent('subscription.canceled', { id: 'sub_01abc' });
  assert.equal((await verifyLicence(lic)).valid, false);
});

test('abbonamento PayPal: il rimborso dell’ultimo pagamento revoca la licenza', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.type === 'subscription');
  const { license } = await fulfil({ provider: 'paypal-sub', id: 'I-ABCDEFGH1234', product, expiresAt: null });
  await recordTransaction({ provider: 'paypal-sub', id: 'I-ABCDEFGH1234', status: 'attivo', last_payment: { id: 'SALE1' } });
  process.env.PAYPAL_WEBHOOK_ID = 'WH'; mockPayPal(); verify = 'SUCCESS';
  const h = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' };
  assert.equal((await verifyLicence(license)).valid, true);
  const r = await webhook(req('/api/paypal/webhook', 'POST', h, JSON.stringify({ id: 'WH-S1', event_type: 'PAYMENT.SALE.REFUNDED', resource: { id: 'REF1', sale_id: 'SALE1' } })), {});
  assert.equal(r.status, 200);
  assert.equal((await verifyLicence(license)).reason, 'revoked');
});

test('licenze e file emessi in prova non valgono quando le vendite reali sono attive', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.delivery.kind === 'license');
  await recordTransaction({ provider: 'paypal', id: 'ORDPROVA1', sku: product.sku, status: 'completato' });
  const prova = await fulfil({ provider: 'paypal', id: 'ORDPROVA1', product });
  await recordTransaction({ provider: 'paypal', id: 'ORDVERO1', sku: product.sku, status: 'completato' });
  const vera = await fulfil({ provider: 'paypal', id: 'ORDVERO1', product, mode: 'live' });
  const produzione = { deploy: { context: 'production' } };
  assert.equal((await verifyLicence(prova.license, produzione)).valid, true, 'in prova la licenza di prova vale');
  const prima = process.env.PAYPAL_LIVE_ENABLED;
  process.env.PAYPAL_LIVE_ENABLED = 'true';
  try {
    const v = await verifyLicence(prova.license, produzione);
    assert.equal(v.valid, false); assert.equal(v.reason, 'licenza_di_prova');
    assert.equal((await verifyLicence(vera.license, produzione)).valid, true);
    assert.equal((await verifyLicence(prova.license, { deploy: { context: 'deploy-preview' } })).valid, true, 'fuori dalla produzione PayPal resta in prova');
    // Stessa regola per i file: la consegna di prova non si scarica in produzione, quella reale sì.
    const file = PRODUCTS.find((p) => p.delivery.kind === 'download');
    await ST('files').set(file.delivery.file, new TextEncoder().encode('zip').buffer);
    await recordTransaction({ provider: 'paypal', id: 'ORDFILEPROVA', sku: file.sku, status: 'completato' });
    const fp = await fulfil({ provider: 'paypal', id: 'ORDFILEPROVA', product: file });
    await recordTransaction({ provider: 'paypal', id: 'ORDFILEVERO', sku: file.sku, status: 'completato' });
    const fv = await fulfil({ provider: 'paypal', id: 'ORDFILEVERO', product: file, mode: 'live' });
    const bloccato = await deliveryFn(req(`/d/${fp.token}`), { params: { token: fp.token }, ...produzione });
    assert.equal(bloccato.status, 403); assert.equal((await bloccato.json()).error, 'consegna_di_prova');
    assert.equal((await deliveryFn(req(`/d/${fv.token}`), { params: { token: fv.token }, ...produzione })).status, 200);
  } finally {
    if (prima === undefined) delete process.env.PAYPAL_LIVE_ENABLED; else process.env.PAYPAL_LIVE_ENABLED = prima;
  }
});

test('amministrazione: token obbligatorio, registro esportabile in CSV', async () => {
  process.env.ADMIN_TOKEN = 'z'.repeat(32);
  assert.equal((await adminFn(req('/api/admin/transactions'), { params: { action: 'transactions' } })).status, 401);
  const r = await adminFn(req('/api/admin/transactions?format=csv', 'GET', { authorization: 'Bearer ' + 'z'.repeat(32) }), { params: { action: 'transactions' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /rimborsato/);
});

test('amministrazione: gli errori di archiviazione restituiscono un messaggio generico', async (t) => {
  t.mock.method(console, 'error', () => {});
  const originalToken = process.env.ADMIN_TOKEN;
  const token = 'z'.repeat(32);
  process.env.ADMIN_TOKEN = token;
  const originalStore = globalThis.__SF365_TEST_STORE__;
  globalThis.__SF365_TEST_STORE__ = () => { throw new Error('Dettaglio interno di archiviazione'); };
  try {
    const headers = { authorization: 'Bearer ' + token };
    const response = await adminFn(req('/api/admin/transactions', 'GET', headers), { params: { action: 'transactions' } });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'errore_interno' });
  } finally {
    globalThis.__SF365_TEST_STORE__ = originalStore;
    if (originalToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalToken;
  }
});

test('catalogo pubblico con i collegamenti di acquisto', async () => {
  const j = await (await apiFn(req('/api/catalog'), {})).json();
  assert.ok(j.products.some((p) => p.buy === `/checkout?offerta=${sku}`));
  assert.ok(j.products.some((p) => p.buy === '/abbonamento?offerta=avvicendo-pro-annuale'));
});

// ---- Punti 2, 3 e 4 rimasti aperti dopo la revisione indipendente (chiusi il 24/11/2026)
const paypalHeaders = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' };
async function paypalEvent(event_type, resource) {
  process.env.PAYPAL_WEBHOOK_ID = 'WH'; mockPayPal(); verify = 'SUCCESS';
  const r = await webhook(req('/api/paypal/webhook', 'POST', paypalHeaders, JSON.stringify({ id: 'WH-' + Math.random().toString(36).slice(2), event_type, resource })), {});
  assert.equal(r.status, 200);
}

test('punto 2 — PayPal: dopo un rimborso solo un pagamento nuovo riattiva; disdetta e riattivazione non riaprono', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.type === 'subscription');
  const id = 'I-PUNTO2ABCDEF';
  await recordTransaction({ provider: 'paypal-sub', id, sku: product.sku, status: 'attivo' });
  const { license } = await fulfil({ provider: 'paypal-sub', id, product, expiresAt: null });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-A', billing_agreement_id: id, amount: { total: '5.00' } });
  assert.equal((await verifyLicence(license)).valid, true);
  await paypalEvent('PAYMENT.SALE.REFUNDED', { id: 'REF-A', sale_id: 'SALE-A' });
  assert.equal((await verifyLicence(license)).reason, 'revoked');
  await paypalEvent('BILLING.SUBSCRIPTION.RE-ACTIVATED', { id, plan_id: 'P-1' });
  assert.equal((await verifyLicence(license)).reason, 'revoked', 'la riattivazione del ciclo di vita non toglie il blocco');
  await paypalEvent('BILLING.SUBSCRIPTION.CANCELLED', { id, plan_id: 'P-1', billing_info: { next_billing_time: '2099-01-01T00:00:00Z' } });
  assert.equal((await verifyLicence(license)).reason, 'revoked', 'la disdetta non riapre il periodo rimborsato');
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-A', billing_agreement_id: id });
  assert.equal((await verifyLicence(license)).reason, 'revoked', 'lo stesso pagamento ripetuto non conta');
  await paypalEvent('BILLING.SUBSCRIPTION.ACTIVATED', { id, plan_id: 'P-1' });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-B', billing_agreement_id: id });
  assert.equal((await verifyLicence(license)).valid, true, 'il pagamento successivo riuscito riattiva il cliente pagante');
  await paypalEvent('BILLING.SUBSCRIPTION.CANCELLED', { id, plan_id: 'P-1', billing_info: { next_billing_time: '2099-01-01T00:00:00Z' } });
  const v = await verifyLicence(license);
  assert.equal(v.valid, true); assert.equal(v.expires_at, '2099-01-01T00:00:00Z', 'disdetto: vale fino alla fine del periodo pagato');
});

test('punto 3 — Paddle: rimborso o storno di un rinnovo bloccano l’abbonamento; il rinnovo pagato successivo lo sblocca', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01p3primo00001', { subscription_id: 'sub_01punto3' });
  const lic = txOf('paddle-sub:sub_01punto3').license;
  await paddleSale('txn_01p3rinnovo001', { subscription_id: 'sub_01punto3' });
  await paddleEvent('adjustment.created', { id: 'adj_p3a', action: 'refund', status: 'approved', transaction_id: 'txn_01p3primo00001' });
  assert.equal((await verifyLicence(lic)).valid, true, 'rimborso di un mese già superato: il periodo in corso resta pagato');
  await paddleEvent('adjustment.created', { id: 'adj_p3b', action: 'chargeback', status: 'approved', transaction_id: 'txn_01p3rinnovo001' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked', 'storno del rinnovo in corso: licenza revocata');
  await paddleEvent('subscription.resumed', { id: 'sub_01punto3' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked', 'la ripresa non toglie il blocco');
  await paddleSale('txn_01p3rinnovo001', { subscription_id: 'sub_01punto3' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked', 'l’evento ripetuto del pagamento stornato non conta');
  await paddleSale('txn_01p3rinnovo002', { subscription_id: 'sub_01punto3' });
  assert.equal((await verifyLicence(lic)).valid, true, 'nuovo rinnovo pagato: licenza riattivata');
  await paddleEvent('subscription.paused', { id: 'sub_01punto3' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked');
  await paddleEvent('subscription.canceled', { id: 'sub_01punto3' });
  assert.equal((await verifyLicence(lic)).reason, 'expired');
});

test('punto 4 — storno annullato (chargeback_reverse) e riattivazione manuale con motivo', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01p4singolo001');
  const lic = txOf('paddle:txn_01p4singolo001').license;
  await paddleEvent('adjustment.created', { id: 'adj_p4a', action: 'chargeback', status: 'approved', transaction_id: 'txn_01p4singolo001' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked');
  await paddleEvent('adjustment.created', { id: 'adj_p4b', action: 'chargeback_reverse', status: 'approved', transaction_id: 'txn_01p4singolo001' });
  assert.equal(txOf('paddle:txn_01p4singolo001').status, 'completato');
  assert.equal((await verifyLicence(lic)).valid, true);
  await paddleEvent('adjustment.created', { id: 'adj_p4c', action: 'chargeback_reverse', status: 'approved', transaction_id: 'txn_01p4singolo001' });
  assert.equal(txOf('paddle:txn_01p4singolo001').status, 'completato', 'senza storno in corso non cambia nulla');
  // Riattivazione manuale di un acquisto rimborsato per errore
  await paddleSale('txn_01p4manuale01');
  const lic2 = txOf('paddle:txn_01p4manuale01').license;
  await paddleEvent('adjustment.created', { id: 'adj_p4d', action: 'refund', status: 'approved', transaction_id: 'txn_01p4manuale01' });
  process.env.ADMIN_TOKEN = 'z'.repeat(32);
  const auth = { authorization: 'Bearer ' + 'z'.repeat(32), 'content-type': 'application/json' };
  assert.equal((await adminFn(req('/api/admin/reactivate', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ key: lic2, motivo: 'x' })), { params: { action: 'reactivate' } })).status, 401);
  assert.equal((await adminFn(req('/api/admin/reactivate', 'POST', auth, JSON.stringify({ key: lic2 })), { params: { action: 'reactivate' } })).status, 400, 'motivo obbligatorio');
  const r = await adminFn(req('/api/admin/reactivate', 'POST', auth, JSON.stringify({ key: lic2, motivo: 'rimborso annullato dal titolare' })), { params: { action: 'reactivate' } });
  assert.equal(r.status, 200);
  assert.equal(txOf('paddle:txn_01p4manuale01').status, 'completato');
  assert.ok(txOf('paddle:txn_01p4manuale01').events.some((e) => e.type === 'riattivazione_manuale'));
  assert.equal((await verifyLicence(lic2)).valid, true);
});

// ---- Rilievi della seconda revisione indipendente (24/11/2026) e mutazioni sopravvissute
test('riconsegna di un pagamento vecchio dopo il rimborso del più recente: il blocco resta (Paddle e PayPal)', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01s1r1000001', { subscription_id: 'sub_01s1' });
  const lic = txOf('paddle-sub:sub_01s1').license;
  await paddleSale('txn_01s1r2000001', { subscription_id: 'sub_01s1' });
  await paddleEvent('adjustment.created', { id: 'adj_s1', action: 'refund', status: 'approved', transaction_id: 'txn_01s1r2000001' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked');
  await paddleSale('txn_01s1r1000001', { subscription_id: 'sub_01s1' });
  assert.equal((await verifyLicence(lic)).reason, 'revoked', 'Paddle: R1 riconsegnato non toglie il blocco');
  assert.equal(txOf('paddle-sub:sub_01s1').last_payment_txn, 'txn_01s1r2000001');

  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.type === 'subscription');
  const id = 'I-S2RICONSEGNA1';
  await recordTransaction({ provider: 'paypal-sub', id, sku: product.sku, status: 'attivo' });
  const { license } = await fulfil({ provider: 'paypal-sub', id, product, expiresAt: null });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-1', billing_agreement_id: id });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-2', billing_agreement_id: id });
  await paypalEvent('PAYMENT.SALE.REFUNDED', { id: 'REF-2', sale_id: 'SALE-2' });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-1', billing_agreement_id: id });
  assert.equal((await verifyLicence(license)).reason, 'revoked', 'PayPal: SALE-1 riconsegnata non toglie il blocco');
  assert.equal(txOf(`paypal-sub:${id}`).last_payment.id, 'SALE-2');
});

test('rimborso, poi storno, poi storno annullato: l’acquisto resta rimborsato', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01s4rimb00001');
  const lic = txOf('paddle:txn_01s4rimb00001').license;
  await paddleEvent('adjustment.created', { id: 'adj_s4a', action: 'refund', status: 'approved', transaction_id: 'txn_01s4rimb00001' });
  await paddleEvent('adjustment.created', { id: 'adj_s4b', action: 'chargeback', status: 'approved', transaction_id: 'txn_01s4rimb00001' });
  await paddleEvent('adjustment.created', { id: 'adj_s4c', action: 'chargeback_reverse', status: 'approved', transaction_id: 'txn_01s4rimb00001' });
  assert.equal(txOf('paddle:txn_01s4rimb00001').status, 'rimborsato');
  assert.equal((await verifyLicence(lic)).reason, 'revoked');
});

test('abbonamenti: past_due non revoca; lo storno annullato toglie solo il proprio blocco', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01m10a00001', { subscription_id: 'sub_01m10' });
  const lic = txOf('paddle-sub:sub_01m10').license;
  await paddleEvent('subscription.past_due', { id: 'sub_01m10' });
  assert.equal((await verifyLicence(lic)).valid, true, 'past_due: periodo di tolleranza');
  await paddleSale('txn_01m10b00001', { subscription_id: 'sub_01m10' });
  await paddleEvent('adjustment.created', { id: 'adj_m12a', action: 'refund', status: 'approved', transaction_id: 'txn_01m10b00001' });
  await paddleEvent('adjustment.created', { id: 'adj_m12b', action: 'chargeback', status: 'approved', transaction_id: 'txn_01m10a00001' });
  await paddleEvent('adjustment.created', { id: 'adj_m12c', action: 'chargeback_reverse', status: 'approved', transaction_id: 'txn_01m10a00001' });
  assert.equal(txOf('paddle:txn_01m10a00001').status, 'completato');
  assert.equal((await verifyLicence(lic)).reason, 'revoked', 'resta il blocco del rimborso di txn_01m10b');
  await paddleEvent('adjustment.created', { id: 'adj_m12d', action: 'chargeback', status: 'approved', transaction_id: 'txn_01m10b00001' });
  assert.equal(txOf('paddle:txn_01m10b00001').status, 'rimborsato');
});

test('riattivazione manuale di un abbonamento: toglie il blocco e segue il ciclo di vita; record legacy', async () => {
  process.env.ADMIN_TOKEN = 'z'.repeat(32);
  const auth = { authorization: 'Bearer ' + 'z'.repeat(32), 'content-type': 'application/json' };
  const call = (body) => adminFn(req('/api/admin/reactivate', 'POST', auth, body), { params: { action: 'reactivate' } });
  assert.equal((await call('{non json')).status, 400);
  // Paddle: blocco tolto a mano
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01m11a00001', { subscription_id: 'sub_01m11' });
  const lic = txOf('paddle-sub:sub_01m11').license;
  await paddleEvent('adjustment.created', { id: 'adj_m11', action: 'refund', status: 'approved', transaction_id: 'txn_01m11a00001' });
  assert.equal((await call(JSON.stringify({ key: lic, motivo: '   ' }))).status, 400, 'motivo di soli spazi');
  assert.equal((await call(JSON.stringify({ key: lic, motivo: 'rimborso annullato' }))).status, 200);
  assert.equal(txOf('paddle-sub:sub_01m11').payment_hold, null);
  assert.equal((await verifyLicence(lic)).valid, true);
  await paddleEvent('subscription.canceled', { id: 'sub_01m11' });
  assert.equal((await call(JSON.stringify({ key: lic, motivo: 'prova' }))).status, 200);
  assert.equal((await verifyLicence(lic)).reason, 'expired', 'un abbonamento chiuso non torna attivo a mano');
  // PayPal: record legacy con status finale, poi pagamento successivo
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.type === 'subscription');
  const id = 'I-LEGACY000001';
  await recordTransaction({ provider: 'paypal-sub', id, sku: product.sku, status: 'attivo' });
  const { license } = await fulfil({ provider: 'paypal-sub', id, product, expiresAt: null });
  await recordTransaction({ provider: 'paypal-sub', id, status: 'rimborsato', last_payment: { id: 'OLD' } });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-NUOVA', billing_agreement_id: id });
  assert.equal(txOf(`paypal-sub:${id}`).status, 'attivo');
  assert.equal((await verifyLicence(license)).valid, true, 'il cliente pagante non resta bloccato');
  await recordTransaction({ provider: 'paypal-sub', id, status: 'stornato' });
  assert.equal((await call(JSON.stringify({ key: license, motivo: 'contestazione vinta' }))).status, 200);
  assert.equal(txOf(`paypal-sub:${id}`).status, 'attivo');
  assert.equal((await verifyLicence(license)).valid, true);
});

// ---- Rilievi della revisione parallela (Claude_QA 2026-11-24_REVISIONE_PR5_PR4) non ancora coperti
test('eventi del ciclo di vita arrivati in ritardo non riattivano una licenza chiusa (Paddle e PayPal)', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleSale('txn_01ordine0001', { subscription_id: 'sub_01ordine' });
  const lic = txOf('paddle-sub:sub_01ordine').license;
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  const send = async (event_type, data, occurred_at) => {
    const raw = JSON.stringify({ event_id: 'evt_' + Math.random().toString(36).slice(2), event_type, occurred_at, data }), ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
    assert.equal((await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${h1}` }, raw), { params: { action: 'webhook' } })).status, 200);
  };
  await send('subscription.canceled', { id: 'sub_01ordine' }, '2026-11-24T12:00:00Z');
  await send('subscription.activated', { id: 'sub_01ordine' }, '2026-11-24T11:00:00Z');
  assert.equal((await verifyLicence(lic)).reason, 'expired', 'Paddle: activated in ritardo ignorato');
  assert.ok(txOf('paddle-sub:sub_01ordine').events.some((e) => String(e.detail).startsWith('fuori_ordine')));

  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.type === 'subscription');
  const id = 'I-FUORIORDINE1';
  await recordTransaction({ provider: 'paypal-sub', id, sku: product.sku, status: 'attivo' });
  const { license } = await fulfil({ provider: 'paypal-sub', id, product, expiresAt: null });
  process.env.PAYPAL_WEBHOOK_ID = 'WH'; mockPayPal(); verify = 'SUCCESS';
  const pp = (event_type, create_time) => webhook(req('/api/paypal/webhook', 'POST', paypalHeaders, JSON.stringify({ id: 'WH-' + Math.random().toString(36).slice(2), event_type, create_time, resource: { id, plan_id: 'P-1' } })), {});
  await pp('BILLING.SUBSCRIPTION.EXPIRED', '2026-11-24T12:00:00Z');
  await pp('BILLING.SUBSCRIPTION.ACTIVATED', '2026-11-24T11:00:00Z');
  assert.equal((await verifyLicence(license)).reason, 'expired', 'PayPal: ACTIVATED in ritardo ignorato');
  await pp('BILLING.SUBSCRIPTION.RE-ACTIVATED', '2026-11-24T13:00:00Z');
  assert.equal((await verifyLicence(license)).valid, true, 'un evento più recente si applica');
});

test('rimborsi PayPal trovati tramite indice; record vecchi senza indice ancora trovati', async () => {
  const { fulfil, recordTransaction } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.delivery.kind === 'license');
  await recordTransaction({ provider: 'paypal', id: 'ORDIDX1', sku: product.sku, status: 'completato', capture_id: 'CAPIDX1' });
  const a = await fulfil({ provider: 'paypal', id: 'ORDIDX1', product });
  assert.deepEqual(JSON.parse(STORES.index.get('capture:CAPIDX1')), { key: 'paypal:ORDIDX1' });
  await ST('transactions').setJSON('paypal:ORDLEGACY', { provider: 'paypal', id: 'ORDLEGACY', sku: product.sku, status: 'completato', capture_id: 'CAPLEGACY' });
  const b = await fulfil({ provider: 'paypal', id: 'ORDLEGACY', product });
  for (const cap of ['CAPIDX1', 'CAPLEGACY']) {
    await paypalEvent('PAYMENT.CAPTURE.REFUNDED', { id: 'R-' + cap, links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/${cap}` }] });
  }
  assert.equal((await verifyLicence(a.license)).reason, 'revoked');
  assert.equal((await verifyLicence(b.license)).reason, 'revoked');
  // Abbonamento: indice sale:<id> scritto al pagamento
  const sub = PRODUCTS.find((p) => p.type === 'subscription');
  const id = 'I-INDICESALE01';
  await recordTransaction({ provider: 'paypal-sub', id, sku: sub.sku, status: 'attivo' });
  const c = await fulfil({ provider: 'paypal-sub', id, product: sub, expiresAt: null });
  await paypalEvent('PAYMENT.SALE.COMPLETED', { id: 'SALE-IDX', billing_agreement_id: id });
  assert.deepEqual(JSON.parse(STORES.index.get('sale:SALE-IDX')), { key: `paypal-sub:${id}` });
  await paypalEvent('PAYMENT.SALE.REFUNDED', { id: 'REF-IDX', sale_id: 'SALE-IDX' });
  assert.equal((await verifyLicence(c.license)).reason, 'revoked');
});

test('rimborso arrivato prima della conferma: nessuna licenza; download bloccato a licenza scaduta', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleEvent('adjustment.created', { id: 'adj_prima', action: 'refund', status: 'approved', transaction_id: 'txn_01rimbprima01' });
  await paddleSale('txn_01rimbprima01');
  const tx = txOf('paddle:txn_01rimbprima01');
  assert.equal(tx.status, 'rimborsato'); assert.equal(tx.license, undefined); assert.equal(tx.delivery_token, undefined);
  const { setJSON } = await import('../lib/sf365/core.mjs');
  const file = PRODUCTS.find((p) => p.delivery.file);
  if (file) {
    await ST('files').set(file.delivery.file, new TextEncoder().encode('zip').buffer);
    await ST('transactions').setJSON('paypal:ORDSCAD', { provider: 'paypal', id: 'ORDSCAD', sku: file.sku, status: 'completato' });
    await setJSON('licenses', 'SF365-SCADUTA-TEST', { key: 'SF365-SCADUTA-TEST', sku: file.sku, status: 'active', expires_at: '2020-01-01T00:00:00Z' });
    await setJSON('deliveries', 'tokenscaduto0000000000', { token: 'tokenscaduto0000000000', sku: file.sku, license: 'SF365-SCADUTA-TEST', source: 'paypal:ORDSCAD', file: file.delivery.file, downloads: 0 });
    const r = await deliveryFn(req('/d/tokenscaduto0000000000'), { params: { token: 'tokenscaduto0000000000' } });
    assert.equal(r.status, 403); assert.equal((await r.json()).error, 'licenza_scaduta');
  }
});

// ---- Terza revisione indipendente (24/11/2026)
async function paddleAt(event_type, data, occurred_at) {
  process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test';
  const raw = JSON.stringify({ event_id: 'evt_' + Math.random().toString(36).slice(2), event_type, ...(occurred_at && { occurred_at }), data }), ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac('sha256', process.env.PADDLE_WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
  const r = await paddleFn(req('/api/paddle/webhook', 'POST', { 'paddle-signature': `ts=${ts};h1=${h1}` }, raw), { params: { action: 'webhook' } });
  assert.equal(r.status, 200);
}
test('Paddle: rinnovo consegnato in ritardo dopo la disdetta non riattiva; evento senza data dopo uno datato ignorato', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  const sale = (id, at) => paddleAt('transaction.completed', { id, currency_code: 'EUR', custom_data: { sku }, items: [{ price: { id: 'pri_giusto' } }], details: { totals: { grand_total: '3490' } }, subscription_id: 'sub_01ritardo' }, at);
  await sale('txn_01rit000001', '2026-11-24T10:00:00Z');
  const lic = txOf('paddle-sub:sub_01ritardo').license;
  await paddleAt('subscription.canceled', { id: 'sub_01ritardo' }, '2026-11-24T12:00:00Z');
  await sale('txn_01rit000002', '2026-11-24T11:00:00Z');
  assert.equal((await verifyLicence(lic)).reason, 'expired', 'rinnovo vecchio: la disdetta resta');
  await paddleAt('subscription.activated', { id: 'sub_01ritardo' });
  assert.equal((await verifyLicence(lic)).reason, 'expired', 'evento senza data dopo uno datato: ignorato');
  await paddleAt('subscription.activated', { id: 'sub_01ritardo' }, '2026-11-24T13:00:00Z');
  assert.equal((await verifyLicence(lic)).valid, true);
});

test('Paddle: abbonamento rimborsato prima della conferma: nessuna licenza e nessun errore', async () => {
  await ST('provider-ids').setJSON(sku, { paddle_env: 'sandbox', paddle_price_id: 'pri_giusto', paddle_price: '34.90' });
  await paddleEvent('adjustment.created', { id: 'adj_subprima', action: 'refund', status: 'approved', transaction_id: 'txn_01subprima01' });
  await paddleSale('txn_01subprima01', { subscription_id: 'sub_01prima' });
  assert.equal(STORES.transactions.has('paddle-sub:sub_01prima'), false);
  assert.equal(txOf('paddle:txn_01subprima01').license, undefined);
});

test('indice PayPal che non corrisponde: si torna alla scansione; /api/delivery senza link a licenza scaduta', async () => {
  const { fulfil, recordTransaction, setJSON } = await import('../lib/sf365/core.mjs');
  const product = PRODUCTS.find((p) => p.delivery.kind === 'license');
  await recordTransaction({ provider: 'paypal', id: 'ORDORFANO', sku: product.sku, status: 'completato', capture_id: 'CAPORFANO' });
  const a = await fulfil({ provider: 'paypal', id: 'ORDORFANO', product });
  await recordTransaction({ provider: 'paypal', id: 'ORDALTRO', sku: product.sku, status: 'completato', capture_id: 'CAPALTRO' });
  await setJSON('index', 'capture:CAPORFANO', { key: 'paypal:ORDALTRO' }); // indice che punta a un'altra transazione esistente
  await paypalEvent('PAYMENT.CAPTURE.REFUNDED', { id: 'R-ORF', links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAPORFANO' }] });
  assert.equal((await verifyLicence(a.license)).reason, 'revoked');
  assert.equal(txOf('paypal:ORDALTRO').status, 'completato', 'la transazione sbagliata non viene toccata');
  const file = PRODUCTS.find((p) => p.delivery.file);
  if (file) {
    await ST('transactions').setJSON('paypal:ORDSCAD2', { provider: 'paypal', id: 'ORDSCAD2', sku: file.sku, status: 'completato' });
    await setJSON('licenses', 'SF365-SCADUTA-DUE', { key: 'SF365-SCADUTA-DUE', sku: file.sku, status: 'active', expires_at: '2020-01-01T00:00:00Z' });
    await setJSON('deliveries', 'tokenscadutodue0000000', { token: 'tokenscadutodue0000000', sku: file.sku, license: 'SF365-SCADUTA-DUE', source: 'paypal:ORDSCAD2', file: file.delivery.file, downloads: 0 });
    const j = await (await deliveryFn(req('/api/delivery/tokenscadutodue0000000'), { params: { token: 'tokenscadutodue0000000' } })).json();
    assert.equal(j.download, null);
  }
});
