// Complementi SITE FACTORY 365 (24/11/2026): prodotti a solo download e regola Live dell'ordine confermato.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import checkout from '../netlify/functions/checkout.mjs';
import deliveryFn from '../netlify/functions/sf365-delivery.mjs';
import { findProduct, validateCatalog } from '../catalog/products.mjs';
import { LIVE_APPROVAL_PHRASE } from '../lib/sf365/core.mjs';

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
const sku = 'forfettario-in-ordine-2026';
const orderId = 'FORFETT0123456789';
const req = (path, method = 'GET', headers = {}) =>
  new Request(origin + path, { method, headers: { ...(method === 'POST' && { Origin: origin }), ...headers } });

function mockPayPal(apiOrigin, value) {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, apiOrigin);
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 't' });
    if (url.pathname === '/v2/checkout/orders') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value });
      return Response.json({ id: orderId, links: [{ rel: 'payer-action', href: `${apiOrigin.replace('api-m.', 'www.')}/checkoutnow?token=${orderId}` }] });
    }
    if (url.pathname.startsWith(`/v2/checkout/orders/${orderId}`)) {
      return Response.json({ id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: sku, payments: { captures: [{ id: 'CAPF', status: 'COMPLETED', amount: { currency_code: 'EUR', value } }] } }] });
    }
    throw new Error('Chiamata non simulata: ' + url.pathname);
  };
}

test('catalogo valido con Forfettario in Ordine in sandbox, prezzo 9,90 € e consegna a download', () => {
  assert.deepEqual(validateCatalog(), []);
  const p = findProduct(sku);
  assert.equal(p.status, 'sandbox');
  assert.equal(p.price, '9.90');
  assert.equal(p.delivery.kind, 'download');
  assert.equal(p.owner_ai, 'Grokbot');
});

test('Sandbox: acquisto Forfettario in Ordine, consegna senza licenza e download del file', async () => {
  process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec';
  mockPayPal('https://api-m.sandbox.paypal.com', '9.90');
  const pageRes = await checkout(req(`/checkout?offerta=${sku}`));
  assert.equal(pageRes.status, 200);
  assert.match(await pageRes.text(), /9,90 €/);
  const start = await checkout(req(`/checkout?offerta=${sku}&prezzo=0.01`, 'POST'));
  assert.equal(start.status, 303, 'il prezzo dal browser viene ignorato');
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
  const done = await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${orderId}`, 'POST', { Cookie: cookie }));
  const html = await done.text();
  assert.equal(done.status, 200);
  assert.doesNotMatch(html, /SF365-[A-Z2-9]{5}-/, 'nessuna licenza per un prodotto a solo download');
  const token = html.match(/consegna\.html\?t=([A-Za-z0-9_-]+)/)[1];

  const info = await (await deliveryFn(req('/api/delivery/' + token), { params: { token } })).json();
  assert.equal(info.license, null);
  assert.equal(info.download, `/d/${token}`);

  const missing = await deliveryFn(req('/d/' + token), { params: { token } });
  assert.equal(missing.status, 404, 'file non ancora caricato: nessun download');

  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer;
  (STORES.files ||= new Map()).set('sf365/forfettario-in-ordine-2026-v1.0.zip', zip);
  const dl = await deliveryFn(req('/d/' + token), { params: { token } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /forfettario-in-ordine-2026-v1\.0\.zip/);
  const tx = JSON.parse(STORES.transactions.get(`paypal:${orderId}`));
  assert.equal(tx.amount, '9.90'); assert.equal(tx.project, 'SF365-001-GROK');
});

function liveEnv(on) {
  const vars = { PAYPAL_LIVE_ENABLED: 'true', PAYPAL_LIVE_CLIENT_ID: 'lid', PAYPAL_LIVE_CLIENT_SECRET: 'lsec', CHECKOUT_ORDER_SIGNING_KEY: 'k'.repeat(40), LIVE_PAYMENTS_APPROVED: LIVE_APPROVAL_PHRASE };
  for (const [k, v] of Object.entries(vars)) on ? (process.env[k] = v) : delete process.env[k];
}
const production = { deploy: { context: 'production' } };

test('Live: le offerte storiche continuano a richiedere il link dell’ordine confermato', async () => {
  liveEnv(true);
  try {
    const r = await checkout(req('/checkout?offerta=skywatcher-field-kit-1'), production);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /ordine confermato/);
  } finally { liveEnv(false); }
});

test('Live: un prodotto SF365 autorizzato non richiede il link dell’ordine confermato', async () => {
  const p = findProduct(sku);
  liveEnv(true); p.status = 'live';
  mockPayPal('https://api-m.paypal.com', '9.90');
  try {
    const r = await checkout(req(`/checkout?offerta=${sku}`), production);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.doesNotMatch(html, /ordine confermato/);
    assert.match(html, /9,90 €/);
  } finally { p.status = 'sandbox'; liveEnv(false); }
});

test('Live: senza autorizzazione del titolare o con prodotto non live resta tutto bloccato', async () => {
  liveEnv(true);
  try {
    const r = await checkout(req(`/checkout?offerta=${sku}`), production);
    assert.equal(r.status, 403, 'prodotto in sandbox: non vendibile in Live');
    const p = findProduct(sku); p.status = 'live'; delete process.env.LIVE_PAYMENTS_APPROVED;
    try {
      assert.equal((await checkout(req(`/checkout?offerta=${sku}`), production)).status, 403, 'manca LIVE_PAYMENTS_APPROVED');
    } finally { p.status = 'sandbox'; }
  } finally { liveEnv(false); }
});
