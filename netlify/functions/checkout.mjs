import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { readConfirmedOrder } from '../../lib/ordine-confermato.mjs';
import { reserveOrder } from '../../lib/registro-ordini.mjs';

function paymentSettings(context) {
  const live = process.env.PAYPAL_LIVE_ENABLED === 'true' && context?.deploy?.context === 'production';
  return {
    live,
    api: live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    approveOrigin: live ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
    clientId: live ? process.env.PAYPAL_LIVE_CLIENT_ID : process.env.PAYPAL_CLIENT_ID,
    secret: live ? process.env.PAYPAL_LIVE_CLIENT_SECRET : process.env.PAYPAL_CLIENT_SECRET,
    signingKey: process.env.CHECKOUT_ORDER_SIGNING_KEY,
  };
}
const offers = new Map([
  ['ospitabene-kit-annuncio', {
    name: 'OspitaBene · Kit Annuncio',
    price: '49.00',
    currency: 'EUR',
    description: 'Ottimizzazione del titolo e della descrizione in italiano e inglese. Include una revisione.',
  }],
]);
const nonceFormat = /^[a-f0-9]{32}$/;
const orderFormat = /^[A-Z0-9]{8,36}$/;
const sessionDurationSeconds = 60 * 60;

function page(title, content, status = 200, live = false) {
  return new Response(`<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/checkout.css">
</head>
<body><main><p class="mode">${live ? 'Pagamento con PayPal' : 'PayPal Sandbox · Pagamento di prova'}</p>
<h1>${title}</h1>${content}</main></body>
</html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com; frame-ancestors 'none'",
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}

function signSession(secret, session) {
  return createHmac('sha256', secret).update(`checkout-sandbox:${session}`).digest('base64url');
}

function getSession(request, nonce, orderId, secret) {
  if (!nonceFormat.test(nonce ?? '') || !orderFormat.test(orderId ?? '')) return null;

  const cookieName = `__Host-paypal-${nonce}=`;
  const sessionCookie = request.headers.get('Cookie')?.split(/;\s*/)
    .find(cookie => cookie.startsWith(cookieName))?.slice(cookieName.length);
  if (!sessionCookie) return null;

  const [offerId, storedOrderId, expiry, signature, extra] = sessionCookie.split('.');
  const offer = offers.get(offerId);
  if (!offer || storedOrderId !== orderId || extra !== undefined
      || !/^\d{10}$/.test(expiry ?? '') || Number(expiry) <= Date.now() / 1000) return null;

  const expected = Buffer.from(signSession(secret, `${nonce}.${offerId}.${orderId}.${expiry}`));
  const actual = Buffer.from(signature ?? '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { offerId, offer };
}

async function paypalAccessToken({ api, clientId, secret }) {
  const authorization = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await fetch(`${api}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('Autenticazione PayPal');
  const { access_token: accessToken } = await response.json();
  if (!accessToken) throw new Error('Token PayPal mancante');
  return accessToken;
}

async function paypalOrder(api, path, token, options = {}) {
  const response = await fetch(`${api}/v2/checkout/orders${path}`, {
    method: options.body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body && {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': options.requestId,
      }),
    },
    body: options.body && JSON.stringify(options.body),
    signal: AbortSignal.timeout(6000),
  });
  return { ok: response.ok, result: await response.json() };
}

async function startCheckout(url, offerId, offer, token, payment, confirmedOrder) {
  const reserved = confirmedOrder && await reserveOrder(confirmedOrder, offerId, offer, url.origin);
  if (confirmedOrder && !reserved) {
    return page('Ordine da verificare', '<p>Contatta OspitaBene per verificare lo stato dell’ordine.</p>', 409, payment.live);
  }
  const nonce = reserved?.nonce ?? randomUUID().replaceAll('-', '');
  const returnUrl = new URL('/checkout/ritorno', url);
  returnUrl.searchParams.set('sessione', nonce);
  const cancelUrl = new URL('/checkout/annullato', url);
  cancelUrl.searchParams.set('offerta', offerId);

  const { ok, result } = await paypalOrder(payment.api, '', token, {
    requestId: nonce,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: offerId,
        ...(confirmedOrder && { invoice_id: confirmedOrder.reference }),
        description: offer.name,
        amount: { currency_code: offer.currency, value: offer.price },
      }],
      payment_source: {
        paypal: { experience_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: returnUrl.href,
          cancel_url: cancelUrl.href,
        } },
      },
    },
  });

  const approvalLink = result.links?.find(link => ['payer-action', 'approve'].includes(link.rel));
  if (!ok || !orderFormat.test(result.id ?? '')) throw new Error('Ordine PayPal non creato');
  let destination = returnUrl;
  destination.searchParams.set('token', result.id);
  if (approvalLink) {
    destination = new URL(approvalLink.href);
    if (destination.origin !== payment.approveOrigin) throw new Error('URL PayPal imprevisto');
  } else if (!['APPROVED', 'COMPLETED'].includes(result.status)) {
    throw new Error('Approvazione PayPal non disponibile');
  }

  const expiry = Math.floor(Date.now() / 1000) + sessionDurationSeconds;
  const signature = signSession(payment.secret, `${nonce}.${offerId}.${result.id}.${expiry}`);
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
      'Set-Cookie': `__Host-paypal-${nonce}=${offerId}.${result.id}.${expiry}.${signature}; Path=/; Max-Age=${sessionDurationSeconds}; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

async function completeCheckout(orderId, nonce, session, token, payment) {
  let { ok, result } = await paypalOrder(payment.api, `/${orderId}/capture`, token, {
    body: {}, requestId: `cap-${nonce}`,
  });
  if (!ok && result.details?.some(detail => detail.issue === 'ORDER_ALREADY_CAPTURED')) {
    ({ ok, result } = await paypalOrder(payment.api, `/${orderId}`, token));
  }
  if (!ok) throw new Error('Pagamento PayPal da verificare');

  const [unit, extraUnit] = result.purchase_units ?? [];
  const [capture, extraCapture] = unit?.payments?.captures ?? [];
  if (result.id !== orderId || unit?.reference_id !== session.offerId || extraUnit
      || capture?.amount?.currency_code !== session.offer.currency
      || capture.amount.value !== session.offer.price || extraCapture) {
    return page('Pagamento da verificare', '<p>La risposta di PayPal richiede un controllo.</p>', 502, payment.live);
  }
  if (result.status === 'COMPLETED' && capture.status === 'COMPLETED') {
    return payment.live
      ? page('Pagamento completato', '<p>PayPal ha confermato il pagamento per il tuo ordine.</p>', 200, true)
      : page('Pagamento di prova completato', '<p>PayPal Sandbox ha confermato l’importo previsto.</p>');
  }
  return page('Pagamento da verificare', '<p>PayPal indica che il pagamento non è ancora completato.</p>', 202, payment.live);
}

export default async function checkout(request, context) {
  const url = new URL(request.url);
  const isReturn = url.pathname === '/checkout/ritorno';
  const isCancelled = url.pathname === '/checkout/annullato';
  const payment = paymentSettings(context);
  const nonce = url.searchParams.get('sessione');
  const orderId = url.searchParams.get('token');
  const offerId = url.searchParams.get('offerta');
  const offer = offers.get(offerId);

  if (request.method === 'GET' && isCancelled) {
    return page(payment.live ? 'Pagamento annullato' : 'Prova annullata',
      offer && !payment.live ? `<p><a href="/checkout?offerta=${offerId}">Torna all’offerta</a></p>` : '', 200, payment.live);
  }
  if (!isReturn && !offer) return page('Offerta non disponibile', '<p>Apri il link dal sito che propone l’offerta.</p>', 404, payment.live);
  if (!payment.clientId || !payment.secret || (payment.live && (payment.signingKey?.length ?? 0) < 32)) {
    return page('Checkout in preparazione', '<p>Il checkout non è ancora configurato.</p>', 503, payment.live);
  }

  const session = isReturn ? getSession(request, nonce, orderId, payment.secret) : null;
  if (isReturn && !session) return page('Sessione non valida', '<p>Riapri il link al checkout.</p>', 400, payment.live);
  let confirmedOrder;
  if (payment.live && !isReturn) {
    confirmedOrder = readConfirmedOrder(url.searchParams.get('ordine'), offerId, payment.signingKey);
    if (!confirmedOrder) {
      return page('Serve il link dell’ordine confermato', '<p>Usa il link che hai ricevuto dopo la conferma dell’ordine.</p>', 403, true);
    }
  }

  if (request.method === 'GET') {
    const displayedOffer = isReturn ? session.offer : offer;
    const buttonText = isReturn
      ? (payment.live ? 'Conferma il pagamento' : 'Conferma il pagamento di prova')
      : (payment.live ? 'Paga con PayPal' : 'Prova il pagamento con PayPal');
    return page(displayedOffer.name, `<p>${displayedOffer.description}</p>
<p class="price">${displayedOffer.price.replace('.', ',')} €</p>
<form method="post"><button type="submit">${buttonText}</button></form>`, 200, payment.live);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  if (request.headers.get('Origin') !== url.origin) return page('Richiesta non valida', '', 403, payment.live);

  try {
    const token = await paypalAccessToken(payment);
    return isReturn
      ? await completeCheckout(orderId, nonce, session, token, payment)
      : await startCheckout(url, offerId, offer, token, payment, confirmedOrder);
  } catch {
    return page('Verifica PayPal necessaria', '<p>Controlla lo stato in PayPal o riprova dalla stessa pagina.</p>', 502, payment.live);
  }
}

export const config = { path: ['/checkout', '/checkout/ritorno', '/checkout/annullato'] };
