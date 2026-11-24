import assert from 'node:assert/strict';
import test from 'node:test';

import { getVerifiedPlan, matchesSignature, provisionPlan, signature, subscriptions } from '../lib/abbonamenti-paypal.mjs';
import handler from '../netlify/functions/abbonamento.mjs';

const offerId = 'ospitabene-recensioni-serene';
const offer = subscriptions.get(offerId);
const planId = 'P-ABCDEFGHIJKLMNOPQRSTUVWX';
const payment = { api: 'https://api-m.sandbox.paypal.com' };

function plan(price = '19.00') {
  return {
    id: planId,
    status: 'ACTIVE',
    product_id: offer.productId,
    billing_cycles: [{
      tenure_type: 'REGULAR',
      total_cycles: 0,
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      pricing_scheme: { fixed_price: { value: price, currency_code: 'EUR' } },
    }],
    payment_preferences: { auto_bill_outstanding: false },
  };
}

test('il piano accetta il solo importo previsto e un solo ciclo mensile', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(plan()));
  assert.equal(await getVerifiedPlan(payment, 'test', offer, planId), planId);
  fetch.mock.mockImplementation(async () => Response.json(plan('20.00')));
  await assert.rejects(getVerifiedPlan(payment, 'test', offer, planId), /Piano PayPal non disponibile/);
  fetch.mock.mockImplementation(async () => {
    const response = plan();
    response.billing_cycles.push(response.billing_cycles[0]);
    return Response.json(response);
  });
  await assert.rejects(getVerifiedPlan(payment, 'test', offer, planId), /Piano PayPal non disponibile/);
});

test('il provisioning riusa il piano del prodotto senza crearne un duplicato', async t => {
  const call = t.mock.method(globalThis, 'fetch', async (url, { method }) => {
    assert.equal(method, 'GET');
    if (url.includes('/catalogs/products/')) return Response.json({ type: 'SERVICE', name: offer.name });
    if (url.includes('?product_id=')) return Response.json({ plans: [{ id: planId, name: offer.name, status: 'ACTIVE' }] });
    return Response.json(plan());
  });
  assert.equal(await provisionPlan(payment, 'test', offer), planId);
  assert.equal(call.mock.callCount(), 3);
});

test('la firma di configurazione è vincolata all’ambiente e al suo uso', async () => {
  const expiry = '1999999999';
  const key = 'a'.repeat(64);
  const signed = signature(key, 'configure-subscription', [offerId, 'sandbox', expiry]);
  assert.equal(matchesSignature(signed, signature(key, 'configure-subscription', [offerId, 'live', expiry])), false);
  assert.equal(matchesSignature(signed, signature(key, 'subscription-session', [offerId, 'sandbox', expiry])), false);
  const request = new Request(`https://checkout.netlify.app/abbonamento/configura?offerta=${offerId}&ambiente=live`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signed}`, 'X-Checkout-Expiration': expiry },
  });
  assert.equal((await handler(request, { deploy: { context: 'production' } })).status, 404);
});
