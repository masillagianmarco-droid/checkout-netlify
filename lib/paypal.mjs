export function paymentSettings(context) {
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

export function page(title, content, status = 200, live = false) {
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

export async function paypalAccessToken({ api, clientId, secret }) {
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
