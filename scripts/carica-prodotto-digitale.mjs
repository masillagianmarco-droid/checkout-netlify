import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { signature } from '../lib/abbonamenti-paypal.mjs';
import { digitalOffers } from '../lib/download-digitali.mjs';

const [site, offer, mode, filename] = process.argv.slice(2);
const key = process.env.CHECKOUT_ORDER_SIGNING_KEY;
if (!site || !digitalOffers.has(offer) || !['sandbox', 'live'].includes(mode) || !filename || (key?.length ?? 0) < 32) {
  console.error('Uso: node scripts/carica-prodotto-digitale.mjs https://checkout.netlify.app codice-offerta sandbox|live file.zip');
  process.exitCode = 1;
} else {
  const url = new URL('/checkout/carica-prodotto', site);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Indirizzo HTTPS del checkout obbligatorio.');
  url.searchParams.set('offerta', offer);
  url.searchParams.set('ambiente', mode);
  const expires = String(Math.floor(Date.now() / 1000) + 120);
  const body = await readFile(filename);
  const digest = createHash('sha256').update(body).digest('hex');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signature(key, 'upload-digital-asset', [offer, mode, digest, expires])}`,
      'X-Checkout-Expiration': expires,
      'X-Checkout-SHA256': digest,
      'Content-Type': 'application/zip',
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json();
  console.log(JSON.stringify({ http: response.status, ...result }));
  if (!response.ok) process.exitCode = 1;
}
