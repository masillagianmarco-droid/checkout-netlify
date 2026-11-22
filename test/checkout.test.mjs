import assert from 'node:assert/strict';
import { test } from 'node:test';
import checkout from '../netlify/functions/checkout.mjs';

const origin = 'https://checkout.example.test';
const offerId = 'ospitabene-kit-annuncio';
const orderId = '0123456789ABCDEF0';
const offerPath = `/checkout?offerta=${offerId}`;

function request(path, method = 'GET', headers = {}) {
  return checkout(new Request(origin + path, {
    method,
    headers: { ...(method === 'POST' && { Origin: origin }), ...headers },
  }));
}

test('checkout Sandbox', async t => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Le chiamate PayPal devono essere simulate nei test.');
  });
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;

  await t.test('offerta sconosciuta e credenziali mancanti', async () => {
    assert.equal((await request('/checkout?offerta=sconosciuta')).status, 404);
    assert.equal((await request(offerPath)).status, 503);
  });

  process.env.PAYPAL_CLIENT_ID = 'test-client-for-unit-tests';
  process.env.PAYPAL_CLIENT_SECRET = 'test-secret-for-unit-tests';

  const calls = [];
  let amount = '49.00';
  let captureStatus = 'COMPLETED';
  let alreadyCaptured = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    calls.push({ path: url.pathname, method: options.method, headers: options.headers });
    if (url.pathname === '/v1/oauth2/token') {
      assert.equal(options.body, 'grant_type=client_credentials');
      assert.match(options.headers.Authorization, /^Basic /);
      return Response.json({ access_token: 'test-authorization' });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-authorization');
    if (url.pathname === '/v2/checkout/orders') {
      const order = JSON.parse(options.body);
      assert.equal(order.intent, 'CAPTURE');
      assert.deepEqual(order.purchase_units[0].amount, { currency_code: 'EUR', value: '49.00' });
      assert.equal(order.purchase_units[0].reference_id, offerId);
      const experience = order.payment_source.paypal.experience_context;
      assert.equal(experience.shipping_preference, 'NO_SHIPPING');
      assert.match(experience.return_url, new RegExp(`^${origin}/checkout/ritorno\\?sessione=[a-f0-9]{32}$`));
      return Response.json({
        id: orderId, links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`, rel: 'payer-action' }],
      });
    }
    if (options.method === 'POST' && alreadyCaptured) {
      return Response.json({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, { status: 422 });
    }
    assert.match(url.pathname, new RegExp(`^/v2/checkout/orders/${orderId}(/capture)?$`));
    return Response.json({
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [{ reference_id: offerId, payments: { captures: [
        { status: captureStatus, amount: { currency_code: 'EUR', value: amount } },
      ] } }],
    });
  };

  await t.test('il prezzo visibile coincide con il listino', async () => {
    const response = await request(offerPath + '&prezzo=0.01');
    assert.match(await response.text(), /49,00 €/);
    assert.equal(calls.length, 0);
  });

  await t.test('una richiesta esterna viene respinta', async () => {
    assert.equal((await request(offerPath, 'POST', { Origin: 'https://example.net' })).status, 403);
    assert.equal(calls.length, 0);
  });

  let cookie;
  let returnPath;
  await t.test('l’ordine PayPal usa prezzo e valuta dal server', async () => {
    const response = await request(offerPath + '&prezzo=0.01', 'POST');
    assert.equal(response.status, 303);
    assert.match(response.headers.get('Location'), /^https:\/\/www\.sandbox\.paypal\.com\//);
    assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
    cookie = response.headers.get('Set-Cookie').split(';')[0];
    const nonce = cookie.split('=')[0].slice('__Host-paypal-'.length);
    returnPath = `/checkout/ritorno?sessione=${nonce}&token=${orderId}`;
  });

  await t.test('la pagina di ritorno verifica la sessione e non effettua pagamenti', async () => {
    const callsBefore = calls.length;
    const fakeCookie = cookie.slice(0, -2) + 'xx';
    assert.equal((await request(returnPath, 'GET', { Cookie: fakeCookie })).status, 400);
    assert.equal((await request(returnPath.replace(orderId, '11111111111111111'), 'GET', { Cookie: cookie })).status, 400);
    assert.match(await (await request(returnPath, 'GET', { Cookie: cookie })).text(), /Conferma il pagamento di prova/);
    assert.equal(calls.length, callsBefore);
  });

  await t.test('verifica l’esito e può riprendere una conferma già effettuata', async () => {
    assert.match(await (await request(returnPath, 'POST', { Cookie: cookie })).text(), /Pagamento di prova completato/);
    alreadyCaptured = true;
    assert.match(await (await request(returnPath, 'POST', { Cookie: cookie })).text(), /Pagamento di prova completato/);
    assert.equal(calls.at(-1).method, 'GET');
    const captureCalls = calls.filter(call => call.path.endsWith('/capture'));
    assert.equal(captureCalls.length, 2);
    assert.equal(captureCalls[0].headers['PayPal-Request-Id'], captureCalls[1].headers['PayPal-Request-Id']);
    alreadyCaptured = false;
  });

  await t.test('un pagamento in sospeso o con importo diverso richiede verifica', async () => {
    captureStatus = 'PENDING';
    assert.equal((await request(returnPath, 'POST', { Cookie: cookie })).status, 202);
    captureStatus = 'COMPLETED';
    amount = '0.01';
    assert.equal((await request(returnPath, 'POST', { Cookie: cookie })).status, 502);
  });
});
