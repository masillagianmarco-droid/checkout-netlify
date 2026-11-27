// Avvicendo (SF365-0002): catalogo in Sandbox e flusso di acquisto con PayPal simulato.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import checkout from '../netlify/functions/checkout.mjs';
import licenseFn from '../netlify/functions/sf365-license.mjs';
import { findProduct, validateCatalog } from '../catalog/products.mjs';

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
const site = 'https://avvicendo.netlify.app';
const sku = 'avvicendo-pro-12m';
const orderId = 'TURNI0123456789AB';
const req = (path, method = 'GET', headers = {}, body) =>
  new Request(origin + path, { method, headers: { ...(method === 'POST' && { Origin: origin }), ...headers }, body });

function mockPayPal(value) {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com', 'solo Sandbox');
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 't' });
    if (url.pathname === '/v2/checkout/orders') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value });
      return Response.json({ id: orderId, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] });
    }
    if (url.pathname.startsWith(`/v2/checkout/orders/${orderId}`)) {
      return Response.json({ id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: sku, payments: { captures: [{ id: 'CAPT1', status: 'COMPLETED', amount: { currency_code: 'EUR', value } }] } }] });
    }
    throw new Error('Chiamata non simulata: ' + url.pathname);
  };
}

test('Avvicendo: listino del titolare (24/11) in sandbox — mensile 3,90, annuale 29,00, licenza 12 mesi 34,90; DPA Studio sospeso', () => {
  assert.deepEqual(validateCatalog(), []);
  const expected = { 'avvicendo-pro-12m': ['one_time', '34.90'], 'avvicendo-pro-mensile': ['subscription', '3.90'], 'avvicendo-pro-annuale': ['subscription', '29.00'] };
  for (const [s, [type, price]] of Object.entries(expected)) {
    const p = findProduct(s);
    assert.equal(p.status, 'sandbox', s);
    assert.equal(p.type, type, s);
    assert.equal(p.price, price, s);
    assert.equal(p.site, site, s);
    assert.equal(p.project, 'SF365-0002');
    assert.match(p.delivery.kind, /license/);
  }
  assert.equal(findProduct('avvicendo-pro-12m').delivery.license_days, 365, 'licenza 12 mesi senza rinnovo');
  for (const s of ['dpa-studio-pro-12m', 'dpa-studio-pro-mensile', 'dpa-studio-pro-annuale']) assert.equal(findProduct(s).status, 'draft', s);
});

test('Sandbox: acquisto della licenza 12 mesi, prezzo dal server, licenza valida per tutta la famiglia e CORS verso il sito', async () => {
  process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec';
  mockPayPal('34.90');
  const page = await checkout(req(`/checkout?offerta=${sku}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /34,90 €/);
  const start = await checkout(req(`/checkout?offerta=${sku}&prezzo=0.01`, 'POST'));
  assert.equal(start.status, 303, 'il prezzo dal browser viene ignorato');
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
  const done = await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${orderId}`, 'POST', { Cookie: cookie }));
  assert.equal(done.status, 200);
  const lic = (await done.text()).match(/SF365-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}/)[0];
  const tx = JSON.parse(STORES.transactions.get(`paypal:${orderId}`));
  assert.equal(tx.amount, '34.90');
  assert.equal(tx.license, lic);
  const verify = (body) => licenseFn(new Request(origin + '/api/license/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: site }, body: JSON.stringify(body) }));
  const r = await verify({ key: lic, sku });
  assert.equal(r.headers.get('access-control-allow-origin'), site);
  const v = await r.json();
  assert.equal(v.valid, true);
  assert.equal(v.mode, 'sandbox');
  assert.ok(new Date(v.expires_at) > new Date(Date.now() + 360 * 86400000), 'licenza di circa 12 mesi');
  assert.equal((await (await verify({ key: lic, sku: 'avvicendo-pro-annuale' })).json()).valid, true, 'stessa famiglia di prodotto');
  assert.equal((await (await verify({ key: lic, sku: 'dpa-studio-pro-12m' })).json()).reason, 'prodotto_diverso');
});

test('DPA Studio sospeso: non acquistabile, non elencato nel catalogo pubblico', async () => {
  const { default: apiFn } = await import('../netlify/functions/sf365-api.mjs');
  for (const path of ['/checkout?offerta=dpa-studio-pro-12m', '/abbonamento?offerta=dpa-studio-pro-mensile']) {
    const fn = path.startsWith('/checkout') ? checkout : (await import('../netlify/functions/abbonamento.mjs')).default;
    const r = await fn(req(path));
    assert.ok([403, 404].includes(r.status), `${path} → ${r.status}`);
  }
  const j = await (await apiFn(req('/api/catalog'), {})).json();
  assert.ok(!j.products.some((p) => p.sku.startsWith('dpa-studio')));
  assert.equal((await apiFn(req('/api/product/dpa-studio-pro-12m'), { params: { sku: 'dpa-studio-pro-12m' } })).status, 404);
});
