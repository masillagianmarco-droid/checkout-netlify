/* Verifica dei webhook PayPal tramite l'API ufficiale verify-webhook-signature. */
import { env } from './core.mjs';
import { paymentSettings, paypalAccessToken } from '../paypal.mjs';

export async function verifyWebhook(req, rawBody, context) {
  const webhookId = env('PAYPAL_WEBHOOK_ID');
  if (!webhookId) return { ok: false, reason: 'webhook_id_mancante' };
  const h = (n) => req.headers.get(n);
  const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (need.some((n) => !h(n))) return { ok: false, reason: 'intestazioni_mancanti' };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: 'json_non_valido' }; }
  const payment = paymentSettings(context);
  if (!payment.clientId || !payment.secret) return { ok: false, reason: 'paypal_non_configurato' };
  const token = await paypalAccessToken(payment);
  const r = await fetch(`${payment.api}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId, webhook_event: event,
    }),
    signal: AbortSignal.timeout(6000),
  });
  const data = r.ok ? await r.json() : null;
  if (!data || data.verification_status !== 'SUCCESS') return { ok: false, reason: 'firma_non_valida' };
  return { ok: true, event };
}
