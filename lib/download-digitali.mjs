import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

import { matchesSignature, signature } from './abbonamenti-paypal.mjs';

export const digitalOffers = new Map([
  ['skywatcher-field-kit-1', {
    name: 'Skywatcher Observer Field Kit v1.0',
    price: '5.99',
    currency: 'EUR',
    description: 'Toolkit in inglese per documentare le osservazioni del cielo. Include guida PDF, modelli Word, registro Excel e CSV da compilare.',
    filename: 'Skywatcher_Observer_Field_Kit_v1.0.zip',
    help: 'Scarica ed estrai lo ZIP. Per i file modificabili servono applicazioni compatibili con DOCX, XLSX e CSV. I modelli sono per uso personale.',
  }],
  ['studygrid-exam-planner-1', {
    name: 'StudyGrid · Exam Study Planner v1.0',
    price: '6.90',
    currency: 'EUR',
    description: 'Planner Excel per distribuire lo studio prima degli esami, registrare i progressi e confrontare le ore richieste con il tempo disponibile.',
    filename: 'StudyGrid_Exam_Study_Planner_1.0.zip',
    help: 'Scarica ed estrai lo ZIP. Include il file XLSX in inglese da aprire in Microsoft Excel e la guida rapida PDF in italiano e inglese.',
  }],
  ['patentino-ia-quaderno-1', {
    name: 'Patentino IA · Quaderno pratico v1.0',
    price: '8.90',
    currency: 'EUR',
    description: 'Otto esercizi in italiano per scrivere richieste efficaci, controllare fonti e dati, studiare e rivedere bozze generate con l’IA.',
    filename: 'Patentino_IA_Quaderno_Pratico_1.0.zip',
    help: 'Scarica ed estrai lo ZIP. Include un quaderno PDF, prompt modificabili in Markdown e un CSV con dati di esercitazione fittizi.',
  }],
]);

const maxAssetBytes = 1000000;
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function storeFor(live) {
  return getStore({ name: live ? 'checkout-files-live' : 'checkout-files-sandbox', consistency: 'strong' });
}

export async function hasDigitalAsset(offerId, live) {
  return Boolean(await storeFor(live).getMetadata(offerId));
}

export function canDeliver(result, orderId, offerId, offer) {
  const [unit, extraUnit] = result.purchase_units ?? [];
  const [capture, extraCapture] = unit?.payments?.captures ?? [];
  return result.id === orderId && result.status === 'COMPLETED' && unit?.reference_id === offerId && !extraUnit
    && capture?.status === 'COMPLETED' && !extraCapture
    && capture.amount?.currency_code === offer.currency && capture.amount.value === offer.price
    && !(unit.payments.refunds ?? []).some(refund => ['COMPLETED', 'PENDING'].includes(refund.status));
}

export async function digitalDownload(offerId, offer, live) {
  const file = await storeFor(live).get(offerId, { type: 'arrayBuffer' });
  if (!file) return new Response('Il pacchetto richiede una verifica. Usa il riferimento PayPal per contattare il venditore.', { status: 503 });
  return new Response(file, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${offer.filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function json(payload, status) {
  return Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function uploadDigitalAsset(request, payment, offerId, mode, openStore = storeFor) {
  const hash = request.headers.get('x-checkout-sha256');
  const expiry = request.headers.get('x-checkout-expiration');
  const now = Math.floor(Date.now() / 1000);
  const authenticated = request.method === 'POST' && payment.live && payment.signingKey?.length >= 32
    && digitalOffers.has(offerId) && ['sandbox', 'live'].includes(mode)
    && /^[\da-f]{64}$/.test(hash ?? '') && /^\d{10}$/.test(expiry ?? '')
    && Number(expiry) >= now && Number(expiry) - now <= 300
    && matchesSignature(request.headers.get('authorization')?.replace(/^Bearer /, ''),
      signature(payment.signingKey, 'upload-digital-asset', [offerId, mode, hash, expiry]));
  if (!authenticated) return json({ error: 'Risorsa non disponibile' }, 404);

  const size = Number(request.headers.get('content-length'));
  if (!Number.isInteger(size) || size < 4 || size > maxAssetBytes) return json({ error: 'Dimensione non valida' }, 413);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length !== size || !bytes.subarray(0, 4).equals(zipHeader)
      || createHash('sha256').update(bytes).digest('hex') !== hash) return json({ error: 'Pacchetto non valido' }, 422);

  const store = openStore(mode === 'live');
  const { modified } = await store.set(offerId, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    onlyIfNew: true,
    metadata: { sha256: hash, bytes: size },
  });
  if (!modified) {
    const saved = await store.getMetadata(offerId);
    if (saved?.metadata?.sha256 !== hash) return json({ error: 'Esiste già un pacchetto diverso per questa versione' }, 409);
  }
  return json({ uploaded: true, bytes: size, mode }, 200);
}
