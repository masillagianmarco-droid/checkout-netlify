// Webhook PayPal verificati: registro centralizzato di tutte le vendite del checkout, revoca delle licenze SF365.
import { findProduct } from '../../catalog/products.mjs';
import { getJSON, json, listKeys, recordTransaction, setLicenseStatus } from '../../lib/sf365/core.mjs';
import { verifyWebhook } from '../../lib/sf365/paypal-webhook.mjs';

async function byCapture(captureId) {
  const out = [];
  for (const k of await listKeys('transactions', 'paypal:')) {
    const tx = await getJSON('transactions', k);
    if (tx && tx.capture_id === captureId) out.push(tx);
  }
  return out;
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'metodo' }, 405);
  const raw = await req.text();
  let v;
  try { v = await verifyWebhook(req, raw, context); } catch { return json({ error: 'verifica_non_riuscita' }, 502); }
  if (!v.ok) return json({ error: v.reason }, 400);
  const ev = v.event, res = ev.resource || {}, now = new Date().toISOString();
  const log = { at: now, type: 'webhook:' + ev.event_type, detail: ev.id };
  switch (ev.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const orderId = res.supplementary_data?.related_ids?.order_id;
      if (orderId) await recordTransaction({ provider: 'paypal', id: orderId, status: 'completato', capture_id: res.id, amount: res.amount?.value, currency: res.amount?.currency_code, events: [log] });
      break;
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const up = (res.links || []).find((l) => l.rel === 'up');
      const captureId = up ? up.href.split('/').pop() : res.id;
      for (const tx of await byCapture(captureId)) {
        await recordTransaction({ provider: 'paypal', id: tx.id, status: ev.event_type.endsWith('REFUNDED') ? 'rimborsato' : 'stornato', events: [log] });
        await setLicenseStatus(tx.license, 'revoked');
      }
      break;
    }
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const status = { 'BILLING.SUBSCRIPTION.ACTIVATED': 'attivo', 'BILLING.SUBSCRIPTION.RE-ACTIVATED': 'attivo', 'BILLING.SUBSCRIPTION.CANCELLED': 'disdetto', 'BILLING.SUBSCRIPTION.SUSPENDED': 'sospeso', 'BILLING.SUBSCRIPTION.EXPIRED': 'scaduto' }[ev.event_type];
      const tx = await getJSON('transactions', `paypal-sub:${res.id}`);
      await recordTransaction({ provider: 'paypal-sub', id: res.id, status, plan_id: res.plan_id, events: [log] });
      if (tx?.license && findProduct(tx.sku)) {
        if (status === 'attivo') await setLicenseStatus(tx.license, 'active', null);
        else if (status === 'disdetto') await setLicenseStatus(tx.license, 'active', res.billing_info?.next_billing_time || now);
        else await setLicenseStatus(tx.license, status === 'scaduto' ? 'expired' : 'revoked');
      }
      break;
    }
    case 'PAYMENT.SALE.COMPLETED':
      if (res.billing_agreement_id) await recordTransaction({ provider: 'paypal-sub', id: res.billing_agreement_id, last_payment: { id: res.id, amount: res.amount }, events: [log] });
      break;
    default:
      await recordTransaction({ provider: 'paypal-evento', id: ev.id, status: 'ricevuto', events: [log] });
  }
  return json({ ok: true });
};

export const config = { path: '/api/paypal/webhook' };
