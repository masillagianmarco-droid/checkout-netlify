// Catalogo e configurazione pubblica del checkout unificato (nessun segreto).
import { PRODUCTS, findProduct, publicProduct } from '../../catalog/products.mjs';
import { env, json, mode } from '../../lib/sf365/core.mjs';

export function buyPath(p) {
  return p.type === 'subscription' ? `/abbonamento?offerta=${p.sku}` : `/checkout?offerta=${p.sku}`;
}

export default async (req, context) => {
  const url = new URL(req.url);
  if (url.pathname === '/api/config') {
    return json({ paypal: mode('paypal', context).label, paddle: mode('paddle', context).label, paddle_client_token: env('PADDLE_CLIENT_TOKEN') || null, primary: env('PRIMARY_PROVIDER', 'paypal') });
  }
  if (url.pathname === '/api/catalog') {
    return json({ products: PRODUCTS.filter((p) => p.status !== 'draft').map((p) => ({ ...publicProduct(p), buy: buyPath(p) })) });
  }
  const p = findProduct(context.params?.sku);
  if (!p || p.status === 'draft') return json({ error: 'prodotto_sconosciuto' }, 404);
  return json({ product: { ...publicProduct(p), buy: buyPath(p) } });
};

export const config = { path: ['/api/config', '/api/catalog', '/api/product/:sku'], method: ['GET'] };
