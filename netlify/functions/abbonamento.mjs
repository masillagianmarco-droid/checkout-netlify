import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

import { getVerifiedPlan, matchesSignature, paypalJson, planIdPattern, provisionPlan, signature, subscriptionIdPattern, subscriptions } from '../../lib/abbonamenti-paypal.mjs';
import { readConfirmedOrder } from '../../lib/ordine-confermato.mjs';
import { page, paymentSettings, paypalAccessToken } from '../../lib/paypal.mjs';
import { reserveOrder } from '../../lib/registro-ordini.mjs';

const path = '/abbonamento';
const returnPath = `${path}/ritorno`;
const cancelPath = `${path}/annullato`;
const setupPath = `${path}/configura`;
const sessionLifetime = 60 * 60;
const noncePattern = /^[a-f0-9]{32}$/;

function setupStore(live) {
  return getStore({ name: live ? 'paypal-live-plans' : 'paypal-sandbox-plans', consistency: 'strong' });
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function configure(request, context, url, offerId, offer) {
  const production = paymentSettings(context);
  const mode = url.searchParams.get('ambiente');
  const expiration = request.headers.get('x-checkout-expiration');
  const now = Math.floor(Date.now() / 1000);
  const authenticated = production.live && production.signingKey?.length >= 32
    && ['sandbox', 'live'].includes(mode) && /^\d{10}$/.test(expiration ?? '')
    && Number(expiration) >= now && Number(expiration) - now <= 300
    && matchesSignature(request.headers.get('authorization')?.replace(/^Bearer /, ''),
      signature(production.signingKey, 'configure-subscription', [offerId, mode, expiration]));
  if (request.method !== 'POST' || !authenticated) return json({ error: 'Risorsa non disponibile' }, 404);

  const payment = mode === 'live' ? production : paymentSettings();
  const store = setupStore(payment.live);
  try {
    const token = await paypalAccessToken(payment);
    const saved = await store.get(offerId, { type: 'json' });
    const planId = saved?.id
      ? await getVerifiedPlan(payment, token, offer, saved.id)
      : await provisionPlan(payment, token, offer);
    if (!saved) await store.setJSON(offerId, { id: planId }, { onlyIfNew: true });
    return json({ planId, mode });
  } catch (error) {
    const status = Number(error.cause);
    return json({ error: 'Configurazione PayPal da verificare', ...(Number.isInteger(status) && { paypalStatus: status }) }, 502);
  }
}

function newSession(payment, offerId, confirmedOrder, planId, nonce, subscription) {
  const approval = subscription.links?.find(link => link.rel === 'approve');
  if (!approval || !subscriptionIdPattern.test(subscription.id ?? '')) throw new Error('Approvazione non disponibile');
  const destination = new URL(approval.href);
  if (destination.origin !== payment.approveOrigin || destination.username || destination.password) {
    throw new Error('Indirizzo PayPal non valido');
  }
  const expiry = Math.floor(Date.now() / 1000) + sessionLifetime;
  const fields = [nonce, subscription.id, planId, offerId, confirmedOrder?.reference ?? '-', String(expiry)];
  const value = [...fields.slice(1), signature(payment.secret, 'subscription-session', fields)].join('.');
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination.href,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
      'Set-Cookie': `__Host-subscription-${nonce}=${value}; Path=/; Max-Age=${sessionLifetime}; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

function readSession(request, url, payment, offerId) {
  const nonce = url.searchParams.get('sessione');
  if (!noncePattern.test(nonce ?? '')) return null;
  const prefix = `__Host-subscription-${nonce}=`;
  const value = request.headers.get('cookie')?.split(/;\s*/).find(cookie => cookie.startsWith(prefix))?.slice(prefix.length);
  const [id, planId, storedOffer, reference, expiry, proof, extra] = value?.split('.') ?? [];
  if (extra !== undefined || storedOffer !== offerId || !subscriptionIdPattern.test(id ?? '')
      || !planIdPattern.test(planId ?? '') || !/^\d{10}$/.test(expiry ?? '') || Number(expiry) <= Date.now() / 1000
      || !matchesSignature(proof, signature(payment.secret, 'subscription-session', [nonce, id, planId, offerId, reference, expiry]))) return null;
  return { id, planId, reference };
}

async function viewResult(request, url, payment, offerId, offer) {
  const session = readSession(request, url, payment, offerId);
  if (!session) return page('Sessione non valida', '<p>Riapri il link di abbonamento che hai ricevuto.</p>', 400, payment.live);
  const token = await paypalAccessToken(payment);
  const { ok, data } = await paypalJson(payment, token, `/v1/billing/subscriptions/${session.id}`);
  if (!ok || data.id !== session.id || data.plan_id !== session.planId
      || (payment.live && data.custom_id !== session.reference)) throw new Error('Abbonamento non verificato');

  const paid = data.billing_info?.last_payment?.amount;
  if (data.status !== 'ACTIVE' || paid?.currency_code !== offer.currency || Number(paid?.value) !== Number(offer.price)) {
    return page('Abbonamento da verificare', '<p>Il primo pagamento è in attesa di verifica. Controlla lo stato su PayPal prima di ripetere l’operazione.</p>', 202, payment.live);
  }
  return page(payment.live ? 'Abbonamento attivo' : 'Abbonamento di prova attivo',
    `<p>PayPal ha confermato il primo pagamento per ${offer.name}.</p><p>Per contattare OspitaBene o chiedere la disdetta, scrivi a <a href="mailto:${offer.contact}">${offer.contact}</a>.</p>`, 200, payment.live);
}

export default async function subscription(request, context) {
  const url = new URL(request.url);
  const offerId = url.searchParams.get('offerta');
  const offer = subscriptions.get(offerId);
  const payment = paymentSettings(context);
  if (!offer) return page('Offerta non disponibile', '', 404, payment.live);
  if (url.pathname === setupPath) return configure(request, context, url, offerId, offer);
  if (request.method === 'GET' && url.pathname === cancelPath) return page('Procedura annullata', '', 200, payment.live);
  if (!payment.clientId || !payment.secret || (payment.live && !(payment.signingKey?.length >= 32))) {
    return page('Abbonamento in preparazione', '', 503, payment.live);
  }
  try {
    if (request.method === 'GET' && url.pathname === returnPath) return await viewResult(request, url, payment, offerId, offer);
    if (url.pathname !== path || !['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    const confirmedOrder = payment.live && readConfirmedOrder(url.searchParams.get('ordine'), offerId, payment.signingKey);
    if (payment.live && !confirmedOrder) {
      return page('Serve il link dell’ordine confermato', '<p>Usa il link che ti ha inviato OspitaBene dopo la conferma.</p>', 403, payment.live);
    }
    const saved = await setupStore(payment.live).get(offerId, { type: 'json' });
    if (!planIdPattern.test(saved?.id ?? '')) return page('Abbonamento in preparazione', '', 503, payment.live);
    if (request.method === 'GET') {
      return page(offer.name, `<p>${offer.description}</p><p class="price">${offer.price.replace('.', ',')} € al mese</p>
<p>Rinnovo automatico mensile. Puoi disdire in qualsiasi momento da PayPal o scrivendo a <a href="mailto:${offer.contact}">${offer.contact}</a>. Il servizio resta disponibile fino alla fine del periodo già pagato.</p>
<p><a href="${offer.site}">Informazioni sul servizio</a> · <a href="${offer.privacy}">Informativa privacy</a></p>
<form method="post"><button type="submit">${payment.live ? 'Continua su PayPal per abbonarti' : 'Prova l’abbonamento con PayPal'}</button></form>`, 200, payment.live);
    }
    if (request.headers.get('Origin') !== url.origin) return page('Richiesta non valida', '', 403, payment.live);
    const token = await paypalAccessToken(payment);
    const planId = await getVerifiedPlan(payment, token, offer, saved.id);
    const reservation = confirmedOrder && await reserveOrder(confirmedOrder, offerId, offer, url.origin,
      getStore({ name: 'live-confirmed-subscriptions', consistency: 'strong' }));
    if (confirmedOrder && !reservation) return page('Richiesta da verificare', '<p>Contatta OspitaBene per controllare la richiesta.</p>', 409, payment.live);
    const nonce = reservation?.nonce ?? randomUUID().replaceAll('-', '');
    const returnUrl = new URL(returnPath, url);
    returnUrl.searchParams.set('offerta', offerId);
    returnUrl.searchParams.set('sessione', nonce);
    const cancelUrl = new URL(cancelPath, url);
    cancelUrl.searchParams.set('offerta', offerId);
    const { ok, data } = await paypalJson(payment, token, '/v1/billing/subscriptions', {
      requestId: nonce,
      body: {
        plan_id: planId,
        ...(confirmedOrder && { custom_id: confirmedOrder.reference }),
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: returnUrl.href,
          cancel_url: cancelUrl.href,
        },
      },
    });
    if (!ok) throw new Error('Abbonamento non avviato');
    return newSession(payment, offerId, confirmedOrder, planId, nonce, data);
  } catch {
    return page('Verifica PayPal necessaria', '<p>Controlla lo stato in PayPal o contatta OspitaBene.</p>', 502, payment.live);
  }
}

export const config = { path: ['/abbonamento', '/abbonamento/ritorno', '/abbonamento/annullato', '/abbonamento/configura'] };
