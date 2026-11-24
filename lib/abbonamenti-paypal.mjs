import { createHmac, timingSafeEqual } from 'node:crypto';

import { PRODUCTS } from '../catalog/products.mjs';
import { SELLER } from '../catalog/seller.mjs';

export const subscriptions = new Map([
  ['ospitabene-recensioni-serene', {
    name: 'OspitaBene · Recensioni Serene',
    description: 'Fino a 15 risposte al mese nella lingua dell’ospite. Le risposte arrivano entro 24 ore lavorative da quando ci inoltri le recensioni.',
    productId: 'OSPITABENE-RECENSIONI-SERENE',
    price: '19.00',
    currency: 'EUR',
    site: 'https://ospitabene.netlify.app',
    privacy: 'https://ospitabene.netlify.app/privacy',
    contact: 'masillagianmarco@gmail.com',
  }],
  // Abbonamenti SITE FACTORY 365 (mensili e annuali) dal registro centrale dei prodotti.
  ...PRODUCTS.filter(p => p.type === 'subscription' && p.status !== 'draft').map(p => [p.sku, {
    name: p.name,
    description: p.description,
    productId: `SF365-${p.sku.toUpperCase()}`,
    price: p.price,
    currency: p.currency,
    interval: p.interval === 'year' ? 'YEAR' : 'MONTH',
    site: p.site,
    privacy: `${SELLER.hub}/privacy.html`,
    contact: SELLER.email,
    sf365: true,
    sku: p.sku,
  }]),
]);

export function periodLabel(offer) {
  return (offer.interval ?? 'MONTH') === 'YEAR' ? 'all’anno' : 'al mese';
}

export const planIdPattern = /^P-[A-Z0-9]{24}$/;
export const subscriptionIdPattern = /^I-[A-Z0-9]{8,17}$/;

export function signature(key, purpose, fields) {
  return createHmac('sha256', key).update(JSON.stringify([purpose, ...fields])).digest('base64url');
}

export function matchesSignature(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export async function paypalJson(payment, token, path, { body, requestId } = {}) {
  const response = await fetch(`${payment.api}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body && {
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
        Prefer: 'return=representation',
      }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const data = await response.json();
  return { status: response.status, ok: response.ok, data };
}

function matchesPlan(plan, offer) {
  const [cycle, extra] = plan.billing_cycles ?? [];
  return plan.status === 'ACTIVE' && plan.product_id === offer.productId && !extra
    && cycle?.tenure_type === 'REGULAR' && cycle.total_cycles === 0
    && cycle.frequency?.interval_unit === (offer.interval ?? 'MONTH') && cycle.frequency.interval_count === 1
    && cycle.pricing_scheme?.fixed_price?.currency_code === offer.currency
    && Number(cycle.pricing_scheme.fixed_price.value) === Number(offer.price)
    && Number(plan.payment_preferences?.setup_fee?.value ?? 0) === 0
    && Number(plan.taxes?.percentage ?? 0) === 0 && plan.quantity_supported !== true
    && plan.payment_preferences?.auto_bill_outstanding === false;
}

function checkedPlan(result, offer) {
  if (!result.ok || !planIdPattern.test(result.data.id ?? '') || !matchesPlan(result.data, offer)) {
    throw new Error('Piano PayPal non disponibile', { cause: result.status });
  }
  return result.data.id;
}

export async function getVerifiedPlan(payment, token, offer, id) {
  if (!planIdPattern.test(id ?? '')) throw new Error('Piano PayPal mancante');
  return checkedPlan(await paypalJson(payment, token, `/v1/billing/plans/${id}`), offer);
}

export async function provisionPlan(payment, token, offer) {
  const productPath = '/v1/catalogs/products';
  const product = await paypalJson(payment, token, `${productPath}/${offer.productId}`);
  if (product.status === 404) {
    const created = await paypalJson(payment, token, productPath, {
      requestId: `${offer.productId}-PRODUCT`,
      body: { id: offer.productId, name: offer.name, description: offer.description.slice(0, 256), type: 'SERVICE', home_url: offer.site },
    });
    if (!created.ok || created.data.id !== offer.productId) {
      throw new Error('Prodotto PayPal non creato', { cause: created.status });
    }
  } else if (!product.ok || product.data.type !== 'SERVICE' || product.data.name !== offer.name) {
    throw new Error('Prodotto PayPal non corrispondente', { cause: product.status });
  }

  const plansPath = '/v1/billing/plans';
  const listed = await paypalJson(payment, token, `${plansPath}?product_id=${offer.productId}&page_size=20`);
  if (!listed.ok || (listed.data.links ?? []).some(link => link.rel === 'next')) {
    throw new Error('Elenco piani PayPal da verificare', { cause: listed.status });
  }
  const existing = listed.data.plans?.find(plan => plan.name === offer.name && plan.status === 'ACTIVE');
  if (existing) return getVerifiedPlan(payment, token, offer, existing.id);

  const created = await paypalJson(payment, token, plansPath, {
    requestId: `${offer.productId}-${(offer.interval ?? 'MONTH') === 'YEAR' ? 'YEARLY' : 'MONTHLY'}-1`,
    body: {
      name: offer.name,
      description: `${offer.price.replace('.', ',')} EUR ${periodLabel(offer)}, con disdetta in qualsiasi momento.`,
      product_id: offer.productId,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: offer.interval ?? 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: offer.price, currency_code: offer.currency } },
      }],
      payment_preferences: { auto_bill_outstanding: false, payment_failure_threshold: 1 },
      quantity_supported: false,
    },
  });
  if (!created.ok) throw new Error('Piano PayPal non creato', { cause: created.status });
  return getVerifiedPlan(payment, token, offer, created.data.id);
}
