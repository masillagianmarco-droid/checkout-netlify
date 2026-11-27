// Offerte AF365 a download: Saldo IMU, ProvaOrale in coppia e ProvaOrale Individuale.
// Solo Sandbox, consegna a download senza licenza, prezzo dal catalogo, file reale caricato in Blobs "files".
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';

import checkout from '../netlify/functions/checkout.mjs';
import deliveryFn from '../netlify/functions/sf365-delivery.mjs';
import { findProduct, validateCatalog } from '../catalog/products.mjs';

// Stato globale salvato e ripristinato alla fine (rilievo della revisione Claude del 26/11).
const SAVED = { fetch: globalThis.fetch, store: globalThis.__SF365_TEST_STORE__,
  id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
after(() => {
  globalThis.fetch = SAVED.fetch;
  if (SAVED.store === undefined) delete globalThis.__SF365_TEST_STORE__; else globalThis.__SF365_TEST_STORE__ = SAVED.store;
  for (const [k, v] of [['PAYPAL_CLIENT_ID', SAVED.id], ['PAYPAL_CLIENT_SECRET', SAVED.secret]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

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
const req = (path, method = 'GET', headers = {}) =>
  new Request(origin + path, { method, headers: { ...(method === 'POST' && { Origin: origin }), ...headers } });

function mockPayPal(sku, orderId, value) {
  const apiOrigin = 'https://api-m.sandbox.paypal.com';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, apiOrigin, 'solo Sandbox');
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 't' });
    if (url.pathname === '/v2/checkout/orders') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value });
      return Response.json({ id: orderId, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }] });
    }
    if (url.pathname.startsWith(`/v2/checkout/orders/${orderId}`)) {
      return Response.json({ id: orderId, status: 'COMPLETED', purchase_units: [{ reference_id: sku, payments: { captures: [{ id: 'CAP' + orderId, status: 'COMPLETED', amount: { currency_code: 'EUR', value } }] } }] });
    }
    throw new Error('Chiamata non simulata: ' + url.pathname);
  };
}

const CASES = [
  { sku: 'af365-20261124-saldo-imu', project: 'AF365-20261124-GROK', owner: 'Grokbot', price: '9.90', label: /9,90 €/,
    file: 'sf365/saldo-imu-2026-v1.0.zip', disp: /saldo-imu-2026-v1\.0\.zip/, orderId: 'SALDOIMU012345678',
    fixture: process.env.AF365_FILE_SALDO_IMU },
  { sku: 'provaorale-kit-coppia-1', project: 'AF365-20261125-GROK', owner: 'Grokbot', price: '5.90', label: /5,90 €/,
    file: 'sf365/provaorale-kit-coppia-v1.0.pdf', disp: /provaorale-kit-coppia-v1\.0\.pdf/, orderId: 'KITCOPPIA01234567',
    fixture: process.env.AF365_FILE_KIT_COPPIA },
  { sku: 'provaorale-1', project: 'AF365-20261124-GPT', owner: 'ChatGPT', price: '9.90', label: /9,90 €/,
    file: 'sf365/provaorale-v1.1.1.zip', disp: /provaorale-v1\.1\.1\.zip/, orderId: 'PROVAORALE0123456',
    fixture: process.env.AF365_FILE_PROVAORALE },
];

test('catalogo valido; offerte AF365 in Sandbox, prezzi e download configurati', () => {
  assert.deepEqual(validateCatalog(), []);
  for (const c of CASES) {
    const p = findProduct(c.sku);
    assert.ok(p, c.sku);
    assert.equal(p.status, 'sandbox', 'niente Live senza autorizzazione del titolare');
    assert.equal(p.price, c.price);
    assert.equal(p.type, 'one_time');
    assert.equal(p.delivery.kind, 'download');
    assert.equal(p.delivery.file, c.file);
    assert.equal(p.project, c.project);
    assert.equal(p.owner_ai, c.owner);
  }
});

for (const c of CASES) {
  test(`Sandbox: acquisto ${c.sku}, consegna senza licenza e download del file`, async () => {
    process.env.PAYPAL_CLIENT_ID = 'cid'; process.env.PAYPAL_CLIENT_SECRET = 'sec';
    mockPayPal(c.sku, c.orderId, c.price);
    const pageRes = await checkout(req(`/checkout?offerta=${c.sku}`));
    assert.equal(pageRes.status, 200);
    assert.match(await pageRes.text(), c.label);
    const start = await checkout(req(`/checkout?offerta=${c.sku}&prezzo=0.01`, 'POST'));
    assert.equal(start.status, 303, 'il prezzo dal browser viene ignorato');
    const cookie = start.headers.get('Set-Cookie').split(';')[0];
    const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
    const done = await checkout(req(`/checkout/ritorno?sessione=${nonce}&token=${c.orderId}`, 'POST', { Cookie: cookie }));
    const html = await done.text();
    assert.equal(done.status, 200);
    assert.doesNotMatch(html, /SF365-[A-Z2-9]{5}-/, 'nessuna licenza per un prodotto a solo download');
    const token = html.match(/consegna\.html\?t=([A-Za-z0-9_-]+)/)[1];

    const info = await (await deliveryFn(req('/api/delivery/' + token), { params: { token } })).json();
    assert.equal(info.license, null);
    assert.equal(info.download, `/d/${token}`);
    const missing = await deliveryFn(req('/d/' + token), { params: { token } });
    assert.equal(missing.status, 404, 'file non ancora caricato: nessun download');

    // File reale se indicato (AF365_FILE_*), altrimenti un segnaposto.
    const bytes = c.fixture ? new Uint8Array(readFileSync(c.fixture)) : new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    (STORES.files ||= new Map()).set(c.file, bytes.buffer);
    const dl = await deliveryFn(req('/d/' + token), { params: { token } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), c.disp);
    const got = new Uint8Array(await dl.arrayBuffer());
    assert.equal(got.length, bytes.length, 'file consegnato integro (stessa dimensione)');
    assert.deepEqual(got, bytes, 'file consegnato identico byte per byte');
    const tx = JSON.parse(STORES.transactions.get(`paypal:${c.orderId}`));
    assert.equal(tx.amount, c.price); assert.equal(tx.project, c.project);
  });
}

// Prodotto stagionale: dopo il saldo IMU del 16/12/2026 la voce non deve restare acquistabile.
// Il test diventa rosso dal 17/12/2026 finché lo status non è "draft" (rilievo della revisione Claude del 26/11).
test('Saldo IMU: fuori vendita dopo il 16/12/2026', () => {
  const p = findProduct('af365-20261124-saldo-imu');
  if (Date.now() >= Date.parse('2026-12-17T00:00:00+01:00')) {
    assert.equal(p.status, 'draft', 'portare af365-20261124-saldo-imu a "draft" dopo il 16/12/2026');
  } else {
    assert.notEqual(p.status, 'live', 'niente Live senza autorizzazione del titolare');
  }
});
