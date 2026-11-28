import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { findProduct } from '../catalog/products.mjs';
import checkout from '../netlify/functions/checkout.mjs';
import delivery from '../netlify/functions/sf365-delivery.mjs';

const sku = 'tariffa-chiara-pro';
const amount = { currency_code: 'EUR', value: '9.90' };
const origin = 'https://checkout.example.test';
const order = 'TARIFFACHIARA01234';
const file = 'sf365/tariffa-chiara-pro-v1.0.0.zip';
const request = (path, method = 'GET', headers = {}) =>
  new Request(origin + path, { method, headers: { Origin: origin, ...headers } });

test('Tariffa Chiara Pro: prezzo Sandbox e consegna del solo ZIP', async (t) => {
  const storeBefore = globalThis.__SF365_TEST_STORE__;
  const envBefore = { ...process.env };
  t.after(() => {
    globalThis.__SF365_TEST_STORE__ = storeBefore;
    for (const key of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) {
      if (envBefore[key] === undefined) delete process.env[key];
      else process.env[key] = envBefore[key];
    }
  });
  process.env.PAYPAL_CLIENT_ID = 'fake-id';
  process.env.PAYPAL_CLIENT_SECRET = 'fake-secret';

  const product = findProduct(sku);
  assert.equal(product.status, 'sandbox');
  assert.equal(product.project, 'SF365-0003');
  assert.deepEqual(product.delivery, { kind: 'download', file });
  const stores = new Map();
  globalThis.__SF365_TEST_STORE__ = (_name, scopedName) => {
    assert.match(scopedName, /^sf365-sandbox-/);
    if (!stores.has(scopedName)) stores.set(scopedName, new Map());
    const records = stores.get(scopedName);
    return {
      get: async (key, options) => {
        const value = records.get(key);
        return value && options?.type === 'json' ? JSON.parse(value) : value ?? null;
      },
      setJSON: async (key, value) => records.set(key, JSON.stringify(value)),
    };
  };
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'fake-token' });
    if (url.pathname === '/v2/checkout/orders') {
      const [unit] = JSON.parse(options.body).purchase_units;
      assert.equal(unit.reference_id, sku);
      assert.deepEqual(unit.amount, amount);
      return Response.json({
        id: order,
        links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + order }],
      });
    }
    assert.equal(url.pathname, '/v2/checkout/orders/' + order + '/capture');
    return Response.json({
      id: order,
      status: 'COMPLETED',
      purchase_units: [{
        reference_id: sku,
        payments: { captures: [{ id: 'CAPTARIFFACHIARA01', status: 'COMPLETED', amount }] },
      }],
    });
  });

  const deploy = { context: 'deploy-preview' };
  const page = await checkout(request('/checkout?offerta=' + sku), { deploy });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /9,90 €/);
  const start = await checkout(request('/checkout?offerta=' + sku + '&prezzo=0.01', 'POST'), { deploy });
  assert.equal(start.status, 303);
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
  const completed = await checkout(request('/checkout/ritorno?sessione=' + nonce + '&token=' + order, 'POST', { Cookie: cookie }), { deploy });
  assert.equal(completed.status, 200);
  const token = (await completed.text()).match(/consegna\.html\?t=([A-Za-z0-9_-]+)/)[1];

  const context = { deploy, params: { token } };
  const metadata = await (await delivery(request('/api/delivery/' + token), context)).json();
  assert.equal(metadata.license, null);
  assert.equal(metadata.download, '/d/' + token);
  assert.equal((await delivery(request(metadata.download), context)).status, 404);

  const fixture = process.env.TARIFFA_CHIARA_TEST_ZIP;
  const bytes = fixture ? readFileSync(fixture) : Buffer.from([0x50, 0x4b, 3, 4, 1]);
  if (fixture) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, 'eff0fa740900cff7b82ffbed1ec42c20b99be1f8d762b1e739701f5175f67307');
  }
  stores.get('sf365-sandbox-files').set(file, bytes);
  const downloaded = await delivery(request(metadata.download), context);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /tariffa-chiara-pro-v1\.0\.0\.zip/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});
