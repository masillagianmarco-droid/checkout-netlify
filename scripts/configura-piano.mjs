import { signature, subscriptions } from '../lib/abbonamenti-paypal.mjs';

const [site, offer, mode] = process.argv.slice(2);
const key = process.env.CHECKOUT_ORDER_SIGNING_KEY;
if (!site || !subscriptions.has(offer) || !['sandbox', 'live'].includes(mode) || (key?.length ?? 0) < 32) {
  console.error('Uso: node scripts/configura-piano.mjs https://checkout.netlify.app codice-offerta sandbox|live');
  process.exitCode = 1;
} else {
  const url = new URL('/abbonamento/configura', site);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Indirizzo HTTPS del checkout obbligatorio.');
  url.searchParams.set('offerta', offer);
  url.searchParams.set('ambiente', mode);
  const expires = String(Math.floor(Date.now() / 1000) + 120);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signature(key, 'configure-subscription', [offer, mode, expires])}`,
      'X-Checkout-Expiration': expires,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(28000),
  });
  const result = await response.json();
  console.log(JSON.stringify({ http: response.status, ...result }));
  if (!response.ok) process.exitCode = 1;
}
