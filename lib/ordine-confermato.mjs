import { createHmac, timingSafeEqual } from 'node:crypto';

const referenceFormat = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const offerFormat = /^[a-z0-9-]{1,80}$/;
const ttlSeconds = 4 * 60 * 60;

export function signOrder(offerId, reference, signingKey, issuedAt = Math.floor(Date.now() / 1000)) {
  if (!offerFormat.test(offerId) || !referenceFormat.test(reference) || signingKey.length < 32) {
    throw new Error('Offerta o riferimento non valido, oppure chiave troppo corta.');
  }
  const payload = `${offerId}.${reference}.${issuedAt}`;
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readConfirmedOrder(token, offerId, signingKey, now = Math.floor(Date.now() / 1000)) {
  if (!token || token.length > 200) return null;
  const [signedOffer, reference, issuedAt, signature, extra] = token.split('.');
  if (extra !== undefined || !/^\d{10}$/.test(issuedAt ?? '') || !referenceFormat.test(reference ?? '')
      || signedOffer !== offerId || Number(issuedAt) > now || now - Number(issuedAt) >= ttlSeconds) return null;

  const expected = Buffer.from(signOrder(signedOffer, reference, signingKey, Number(issuedAt)));
  const actual = Buffer.from(token);
  if (!signature || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { reference };
}
