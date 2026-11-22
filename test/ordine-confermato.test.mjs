import assert from 'node:assert/strict';
import { test } from 'node:test';
import checkout from '../netlify/functions/checkout.mjs';
import { readConfirmedOrder, signOrder } from '../lib/ordine-confermato.mjs';
import { reserveOrder } from '../lib/registro-ordini.mjs';

const offerId = 'ospitabene-kit-annuncio';
const offer = { price: '49.00', currency: 'EUR' };
const signingKey = 'fake-test-signing-key-only-00000000';
const origin = 'https://checkout.example.test';

test('un link firmato è valido solo per l’offerta e per la durata previste', () => {
  const issuedAt = 1784772000;
  const signed = signOrder(offerId, 'OSP-001', signingKey, issuedAt);
  assert.deepEqual(readConfirmedOrder(signed, offerId, signingKey, issuedAt + 60), { reference: 'OSP-001' });
  assert.equal(readConfirmedOrder(signed, 'altro-servizio', signingKey, issuedAt + 60), null);
  assert.equal(readConfirmedOrder(signed.replace('OSP-001', 'OSP-002'), offerId, signingKey, issuedAt + 60), null);
  assert.equal(readConfirmedOrder(signed, offerId, signingKey, issuedAt + 14400), null);
  assert.equal(readConfirmedOrder(signed, offerId, signingKey, issuedAt - 5), null);
});

test('due richieste simultanee riservano una sola operazione PayPal', async () => {
  const data = new Map();
  const store = {
    async setJSON(key, value, { onlyIfNew }) {
      assert.equal(onlyIfNew, true);
      if (data.has(key)) return { modified: false };
      data.set(key, value);
      return { modified: true };
    },
    async get(key) {
      return data.get(key);
    },
  };
  const confirmed = { reference: 'OSP-001' };
  const [first, second] = await Promise.all([
    reserveOrder(confirmed, offerId, offer, origin, store),
    reserveOrder(confirmed, offerId, offer, origin, store),
  ]);
  assert.equal(first.nonce, second.nonce);
  assert.equal(await reserveOrder(confirmed, offerId, { ...offer, price: '1.00' }, origin, store), null);
  assert.equal(await reserveOrder(confirmed, offerId, offer, 'https://another.example.test', store), null);
  data.set(confirmed.reference, { ...first, createdAt: Date.now() - 14401000 });
  assert.equal(await reserveOrder(confirmed, offerId, offer, origin, store), null);
});

test('la pagina Live richiede un ordine firmato; le anteprime usano Sandbox', async t => {
  const env = {
    PAYPAL_LIVE_ENABLED: 'true',
    PAYPAL_LIVE_CLIENT_ID: 'test-live-id',
    PAYPAL_LIVE_CLIENT_SECRET: 'test-live-secret',
    CHECKOUT_ORDER_SIGNING_KEY: signingKey,
    PAYPAL_CLIENT_ID: 'test-sandbox-id',
    PAYPAL_CLIENT_SECRET: 'test-sandbox-secret',
  };
  Object.assign(process.env, env);
  t.after(() => Object.keys(env).forEach(key => delete process.env[key]));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Queste richieste non devono contattare PayPal'));

  const checkoutUrl = `${origin}/checkout?offerta=${offerId}`;
  const liveContext = { deploy: { context: 'production' } };
  const withoutLink = await checkout(new Request(checkoutUrl), liveContext);
  assert.equal(withoutLink.status, 403);
  const signed = signOrder(offerId, 'OSP-001', signingKey);
  const live = await checkout(new Request(`${checkoutUrl}&ordine=${signed}`), liveContext);
  assert.equal(live.status, 200);
  assert.match(await live.text(), /Paga con PayPal/);
  const test = await checkout(new Request(checkoutUrl), { deploy: { context: 'deploy-preview' } });
  assert.equal(test.status, 200);
  assert.match(await test.text(), /Pagamento di prova/);
});

test('le due offerte del Kit Completo hanno prezzi distinti e link non intercambiabili', async t => {
  const env = {
    PAYPAL_LIVE_ENABLED: 'true',
    PAYPAL_LIVE_CLIENT_ID: 'test-live-id',
    PAYPAL_LIVE_CLIENT_SECRET: 'test-live-secret',
    CHECKOUT_ORDER_SIGNING_KEY: signingKey,
  };
  Object.assign(process.env, env);
  t.after(() => Object.keys(env).forEach(key => delete process.env[key]));
  const liveContext = { deploy: { context: 'production' } };
  const regular = 'ospitabene-kit-completo';
  const launch = 'ospitabene-kit-completo-lancio';
  const launchToken = signOrder(launch, 'OSP-002', signingKey);
  const getOffer = (offerCode, orderToken) => checkout(
    new Request(`${origin}/checkout?offerta=${offerCode}&ordine=${orderToken}`),
    liveContext,
  );

  assert.match(await (await getOffer(regular, signOrder(regular, 'OSP-003', signingKey))).text(), /99,00 €/);
  assert.match(await (await getOffer(launch, launchToken)).text(), /49,00 €/);
  assert.equal((await getOffer(regular, launchToken)).status, 403);
});
