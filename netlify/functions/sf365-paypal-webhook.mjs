// Webhook PayPal verificati: registro centralizzato di tutte le vendite del checkout, revoca delle licenze SF365.
import { findProduct } from '../../catalog/products.mjs';
import { getJSON, json, listKeys, recordTransaction, setJSON, setLicenseStatus, staleLifecycle, syncSubscriptionLicense } from '../../lib/sf365/core.mjs';
import { verifyWebhook } from '../../lib/sf365/paypal-webhook.mjs';

// Ricerca tramite indice (scritto alla cattura e al pagamento); lettura completa del registro solo per i record
// scritti prima dell'indice.
async function byIndex(name, id, prefix, match) {
  const ix = id ? await getJSON('index', `${name}:${id}`) : null;
  // L'indice si usa solo se punta davvero alla transazione cercata; altrimenti si torna alla scansione.
  if (ix && ix.key) { const tx = await getJSON('transactions', ix.key); if (tx && match(tx)) return [tx]; }
  const out = [];
  for (const k of await listKeys('transactions', prefix)) {
    const tx = await getJSON('transactions', k);
    if (tx && match(tx)) out.push(tx);
  }
  return out;
}
const byCapture = (captureId) => byIndex('capture', captureId, 'paypal:', (tx) => tx.capture_id === captureId);
const bySale = (saleId) => byIndex('sale', saleId, 'paypal-sub:', (tx) => tx.last_payment?.id === saleId || (tx.paid_sales || []).includes(saleId));

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
      // Un evento arrivato in ritardo (più vecchio dell'ultimo applicato) si registra ma non cambia lo stato.
      if (staleLifecycle(tx, ev.create_time)) { await recordTransaction({ provider: 'paypal-sub', id: res.id, events: [{ ...log, detail: 'fuori_ordine' }] }); break; }
      await recordTransaction({ provider: 'paypal-sub', id: res.id, status, plan_id: res.plan_id, ...(ev.create_time && { lifecycle_at: ev.create_time }), ...(status === 'disdetto' && { paid_until: res.billing_info?.next_billing_time || now }), events: [log] });
      // Il ciclo di vita non toglie un blocco per rimborso o storno (payment_hold): vedi syncSubscriptionLicense.
      if (tx?.license && findProduct(tx.sku)) await syncSubscriptionLicense('paypal-sub', res.id);
      break;
    }
    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      // Rimborso o storno dell'ultimo pagamento di un abbonamento: blocco sull'abbonamento e licenza revocata.
      const saleId = res.sale_id || res.id;
      for (const tx of saleId ? await bySale(saleId) : []) {
        if (tx.last_payment?.id !== saleId) continue; // rimborso di un pagamento vecchio: il periodo in corso resta pagato
        await recordTransaction({ provider: 'paypal-sub', id: tx.id, payment_hold: saleId, ultimo_esito: ev.event_type.endsWith('REFUNDED') ? 'rimborsato' : 'stornato', events: [log] });
        if (tx.license) await setLicenseStatus(tx.license, 'revoked');
      }
      break;
    }
    case 'PAYMENT.SALE.COMPLETED': {
      if (!res.billing_agreement_id) break;
      const tx = await getJSON('transactions', `paypal-sub:${res.billing_agreement_id}`);
      const paid = tx?.paid_sales || [];
      // Solo un pagamento mai visto prima conta come «successivo»: una riconsegna di un evento vecchio non
      // toglie il blocco lasciato da un rimborso e non diventa l'ultimo pagamento.
      if (paid.includes(res.id)) { await recordTransaction({ provider: 'paypal-sub', id: res.billing_agreement_id, events: [{ ...log, detail: 'riconsegna:' + res.id }] }); break; }
      const legacyFinal = ['rimborsato', 'stornato'].includes(tx?.status);
      await recordTransaction({
        provider: 'paypal-sub', id: res.billing_agreement_id, last_payment: { id: res.id, amount: res.amount },
        paid_sales: [...paid, res.id].slice(-60), payment_hold: null,
        ...(legacyFinal && { status: 'attivo' }), events: [log],
      });
      await setJSON('index', `sale:${res.id}`, { key: `paypal-sub:${res.billing_agreement_id}` });
      if (tx?.license && findProduct(tx.sku)) await syncSubscriptionLicense('paypal-sub', res.billing_agreement_id);
      break;
    }
    default:
      await recordTransaction({ provider: 'paypal-evento', id: ev.id, status: 'ricevuto', events: [log] });
  }
  return json({ ok: true });
};

export const config = { path: '/api/paypal/webhook' };
