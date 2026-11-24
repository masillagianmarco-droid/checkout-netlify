// TurniChiari (SF365-0002): catalogo in Sandbox e flusso di acquisto con PayPal simulato.
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
const site = 'https://turnichiari.netlify.app';
const sku = 'turnichiari-pro-12m';
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

test('TurniChiari: tre offerte in sandbox, prezzi registrati, licenza', () => {
  assert.deepEqual(validateCatalog(), []);
  const expected = { 'turnichiari-pro-12m': ['one_time', '29.00'], 'turnichiari-pro-mensile': ['subscription', '3.90'], 'turnichiari-pro-annuale': ['subscription', '29.00'] };
  for (const [s, [type, price]] of Object.entries(expected)) {
    const p = findProduct(s);
    assert.equal(p.status, 'sandbox', s);
    assert.equal(p.type, type, s);
    assert.equal(p.price, price, s);
    assert.equal(p.site, site, s);
    assert.equal(p.project, 'SF365-0002');
    assert.match(p.delivery.kind, /license/);
  }
});

test('Sandbox: acquisto della licenza 12 mesi, prezzo dal server, licenza valida per tutta la famiglia e CORS verso il sito', async () => {
  process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec';
  mockPayPal('29.00');
  const page = await checkout(req(`/checkout?offerta=${sku}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /29,00 €/);
  const start = await checkout(req(`/checkout?offerta=${sku}&prezzo=0.01`, 'POST'));
  assert.equal(start.status, 303, 'il prezzo dal browser viene ignorato');
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
  const done = await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${orderId}`, 'POST', { Cookie: cookie }));
  assert.equal(done.status, 200);
  const lic = (await done.text()).match(/SF365-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}/)[0];
  const tx = JSON.parse(STORES.transactions.get(`paypal:${orderId}`));
  assert.equal(tx.amount, '29.00');
  assert.equal(tx.license, lic);
  const verify = (body) => licenseFn(new Request(origin + '/api/license/verify', { method: 'POST', headers: { 'content-type': 'application/json', origin: site }, body: JSON.stringify(body) }));
  const r = await verify({ key: lic, sku });
  assert.equal(r.headers.get('access-control-allow-origin'), site);
  const v = await r.json();
  assert.equal(v.valid, true);
  assert.equal(v.mode, 'sandbox');
  assert.ok(new Date(v.expires_at) > new Date(Date.now() + 360 * 86400000), 'licenza di circa 12 mesi');
  assert.equal((await (await verify({ key: lic, sku: 'turnichiari-pro-annuale' })).json()).valid, true, 'stessa famiglia di prodotto');
  assert.equal((await (await verify({ key: lic, sku: 'dpa-studio-pro-12m' })).json()).reason, 'prodotto_diverso');
});
