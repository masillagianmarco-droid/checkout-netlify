# SITE FACTORY 365 nel checkout condiviso

Questo repository è l'**unica infrastruttura di pagamento** di SITE FACTORY 365 per ChatGPT, Claude, Grokbot e Gemini (decisione del titolare del 24/11/2026: nessun checkout, registro o sistema di licenze separato). Sito: `https://lively-croissant-4a8ae9.netlify.app`. PayPal Business è il fornitore principale e Paddle l'alternativa. Si lavora in **Sandbox**.

## Che cosa aggiunge questa integrazione (senza cambiare le offerte esistenti)

| Funzione | Dove | Note |
|---|---|---|
| Registro unico dei prodotti SF365 | `catalog/products.mjs` | prezzi solo lato server; `status`: draft, sandbox o live |
| Acquisti singoli SF365 | flusso esistente `/checkout?offerta=<sku>` | dopo la cattura verificata: licenza `SF365-…`, registro, pagina `/consegna.html` |
| Abbonamenti mensili **e annuali** | flusso esistente `/abbonamento?offerta=<sku>` | `interval` MONTH/YEAR; piano verificato presso PayPal; licenza senza scadenza finché attivo |
| Configurazione piani Sandbox | `/abbonamento/configura` + `scripts/configura-piano.mjs` | ora possibile in Sandbox anche prima del live (firma HMAC sempre obbligatoria) |
| Webhook PayPal verificati | `POST /api/paypal/webhook` | `verify-webhook-signature`; rimborsi e storni revocano la licenza; stati degli abbonamenti |
| Paddle (alternativa) | `POST /api/paddle/webhook`, `GET /api/paddle/delivery`, `POST /api/admin/sync-paddle` | firma `Paddle-Signature` HMAC con tolleranza 5 min; consegna solo se la transazione contiene il prezzo registrato per lo sku: eseguire prima `sync-paddle`, altrimenti resta `da_verificare` |
| Verifica licenze per i siti | `POST /api/license/verify` | CORS solo verso le origini del catalogo |
| Consegna | `GET /api/delivery/:token`, `/d/:token` | file da `sf365-files`, massimo 10 scaricamenti; bloccato dopo un rimborso o uno storno, anche per i prodotti senza licenza |
| Registro transazioni | Blobs `sf365-transactions` + `GET /api/admin/transactions?format=csv` | registra anche le vendite delle offerte già esistenti |
| Collegamento dei siti | `/embed.js` | `<a data-sf365-sku="…">` o `<a data-sf365-sku="…" data-sf365-abbonamento>` |
| Negozio e condizioni | `/`, `/termini-vendita.html`, `/rimborsi.html`, `/privacy.html`, `/contatti.html` | generati da `npm run pagine` (catalogo + `catalog/seller.mjs`) |

Le offerte già presenti (OspitaBene, Skywatcher, StudyGrid, Patentino IA) mantengono codice, percorsi e regole: i 17 test originali restano verdi.

## Variabili d'ambiente (solo nel pannello Netlify, mai in chat o nel repository)

Già usate: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (app Sandbox «Checkout siti Netlify»), `PAYPAL_LIVE_CLIENT_ID`, `PAYPAL_LIVE_CLIENT_SECRET`, `PAYPAL_LIVE_ENABLED`, `CHECKOUT_ORDER_SIGNING_KEY`.
Nuove: `PAYPAL_WEBHOOK_ID` (webhook dell'app verso `/api/paypal/webhook`), `ADMIN_TOKEN` (≥ 24 caratteri casuali), `LIVE_PAYMENTS_APPROVED` (solo per il live, valore `si-autorizzato-dal-titolare`), facoltative `PADDLE_ENV`, `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PRIMARY_PROVIDER`, `EXTRA_ALLOWED_ORIGINS`.

Eventi webhook PayPal: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.RE-ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `PAYMENT.SALE.COMPLETED`.

## Vendite reali: tre chiavi insieme

1. `PAYPAL_LIVE_ENABLED=true` sul deploy di produzione (regola esistente; per le offerte esistenti resta anche il link d'ordine firmato).
2. `LIVE_PAYMENTS_APPROVED=si-autorizzato-dal-titolare`.
3. `status: "live"` del prodotto in `catalog/products.mjs`.

Prima: verifiche fiscali (con PayPal il venditore è il titolare: partita IVA, documenti fiscali, IVA OSS per i consumatori UE), dati del venditore completi in `catalog/seller.mjs`, prove Sandbox di acquisto, abbonamento, rimborso e disdetta.

## Aggiungere un prodotto (per tutte le IA)

1. Controlla il registro SITE FACTORY 365 su Drive e questo catalogo: niente doppioni.
2. Aggiungi la voce in `catalog/products.mjs` con `status: "sandbox"`, poi `npm test` e `npm run pagine`.
3. Richiesta di modifica su un ramo dedicato; nessuna unione senza revisione.
4. Per gli abbonamenti, dopo il deploy: `node scripts/configura-piano.mjs <sito> <sku> sandbox`.
5. Nel sito del prodotto: `embed.js` e la verifica `SF365.verifyLicense(chiave, sku)`.
