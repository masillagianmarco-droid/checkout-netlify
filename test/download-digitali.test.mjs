import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { signature } from '../lib/abbonamenti-paypal.mjs';
import { canDeliver, digitalOffers, uploadDigitalAsset } from '../lib/download-digitali.mjs';

const offerId = 'studygrid-exam-planner-1';

test('la consegna richiede l’incasso completo dell’offerta e rifiuta i rimborsi', () => {
  const id = '12345678901234567';
  const offer = digitalOffers.get(offerId);
  const valid = {
    id, status: 'COMPLETED',
    purchase_units: [{
      reference_id: offerId,
      payments: { captures: [{ status: 'COMPLETED', amount: { value: offer.price, currency_code: 'EUR' } }] },
    }],
  };
  assert.equal(canDeliver(valid, id, offerId, offer), true);
  assert.equal(canDeliver({ ...valid, status: 'APPROVED' }, id, offerId, offer), false);
  assert.equal(canDeliver(valid, id, 'another-offer', offer), false);
  valid.purchase_units[0].payments.refunds = [{ status: 'PENDING' }];
  assert.equal(canDeliver(valid, id, offerId, offer), false);
});

test('il caricamento controlla firma, ambiente e contenuto dello ZIP', async () => {
  const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 6, 9]);
  const expiry = String(Math.floor(Date.now() / 1000) + 120);
  const hash = createHash('sha256').update(body).digest('hex');
  const payment = { live: true, signingKey: 'a'.repeat(64) };
  const request = bytes => new Request('https://checkout.netlify.app/checkout/carica-prodotto', {
    method: 'POST', body: bytes,
    headers: {
      Authorization: `Bearer ${signature(payment.signingKey, 'upload-digital-asset', [offerId, 'live', hash, expiry])}`,
      'Content-Length': String(body.length), 'X-Checkout-SHA256': hash, 'X-Checkout-Expiration': expiry,
    },
  });
  const store = live => {
    assert.equal(live, true);
    return { set: async (id, data, options) => {
      assert.equal(id, offerId);
      assert.deepEqual(Buffer.from(data), body);
      assert.equal(options.onlyIfNew, true);
      return { modified: true };
    } };
  };
  assert.equal((await uploadDigitalAsset(request(body), payment, offerId, 'sandbox', store)).status, 404);
  assert.equal((await uploadDigitalAsset(request(Buffer.from('broken')), payment, offerId, 'live', store)).status, 422);
  assert.equal((await uploadDigitalAsset(request(body), payment, offerId, 'live', store)).status, 200);
});
