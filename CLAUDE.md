# Checkout condiviso — istruzioni per gli agenti (Claude, ChatGPT, Grok Bot, Gemini, Copilot)

Repository pubblico del titolare. È l'unico checkout dell'ecosistema GROKBOT / SITE FACTORY 365: non creare checkout, webhook o registri duplicati.

## Regole
- Lavora su un ramo e apri una richiesta di unione in bozza. Mai push su `main`, mai `--force`, mai unire: l'unione spetta al titolare.
- Prima di consegnare: `npm ci`, `npm test`, `npm run pagine --if-present`, `node scripts/controlli-sicurezza.mjs`. Riporta i numeri reali nella richiesta di unione.
- Le modifiche a pagamenti, autenticazione, webhook, licenze o `.github/` sono sensibili: richiedono una revisione indipendente (subagente `revisore-pagamenti`, oppure etichetta `revisione-claude`, oppure un'altra IA) prima di chiedere l'unione. Segui `REVIEW.md`.
- Nessuna vendita reale: non impostare `PAYPAL_LIVE_ENABLED`, `PADDLE_ENV=live`, `LIVE_PAYMENTS_APPROVED`; non mettere `status: "live"` nel catalogo senza un'autorizzazione scritta e datata del titolare.
- Nessuna credenziale nel repository, nei test o nei messaggi. I segreti stanno solo nelle variabili d'ambiente Netlify e nei segreti di GitHub.
- Non toccare il comportamento delle offerte storiche (OspitaBene, Skywatcher, StudyGrid, Patentino IA, Recensioni Serene).
- Esclusi i progetti di terzi non autorizzati dal titolare.

## Struttura
- `netlify/functions/`: funzioni del checkout (PayPal Orders v2, abbonamenti, consegna).
- `lib/`: logica condivisa. `catalog/` (quando presente): catalogo SITE FACTORY 365, unica fonte dei prezzi.
- `test/`: `node --test`, con PayPal simulato: nessuna chiamata reale.
- `.claude/`: hook di protezione (parapetto per gli agenti, non sostituisce la regola su `main`), subagente revisore, skill per aggiungere un prodotto.

## Registro e memoria condivisa
Registro: foglio «SITE FACTORY 365 — Registro» su Google Drive (cartella condivisa del titolare). Annota lì ID progetto, stato e prossimo intervento.
