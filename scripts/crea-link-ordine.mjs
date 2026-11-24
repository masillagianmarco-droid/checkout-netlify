import { subscriptions } from '../lib/abbonamenti-paypal.mjs';
import { signOrder } from '../lib/ordine-confermato.mjs';

const [site, offerId, reference] = process.argv.slice(2);
const signingKey = process.env.CHECKOUT_ORDER_SIGNING_KEY;
if (!site || !offerId || !reference || !signingKey) {
  console.error('Uso: node scripts/crea-link-ordine.mjs https://il-tuo-checkout.netlify.app codice-offerta riferimento-ordine');
  process.exitCode = 1;
} else {
  const url = new URL(subscriptions.has(offerId) ? '/abbonamento' : '/checkout', site);
  if (url.protocol !== 'https:') throw new Error('Usa l’indirizzo HTTPS del checkout.');
  url.searchParams.set('offerta', offerId);
  url.searchParams.set('ordine', signOrder(offerId, reference, signingKey));
  console.log(url.href);
}
