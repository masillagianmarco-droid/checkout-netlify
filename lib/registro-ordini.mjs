import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const retryWindowMs = 4 * 60 * 60 * 1000;

export async function reserveOrder(order, offerId, offer, origin, store = getStore({
  name: 'live-confirmed-orders',
  consistency: 'strong',
})) {
  const key = order.reference;
  const proposed = {
    nonce: randomUUID().replaceAll('-', ''),
    offerId,
    price: offer.price,
    currency: offer.currency,
    origin,
    createdAt: Date.now(),
  };
  const { modified } = await store.setJSON(key, proposed, { onlyIfNew: true });
  const saved = modified ? proposed : await store.get(key, { type: 'json' });
  if (!saved || saved.offerId !== offerId || saved.price !== offer.price || saved.currency !== offer.currency
      || saved.origin !== origin || Date.now() - saved.createdAt >= retryWindowMs) {
    return null;
  }
  return saved;
}
