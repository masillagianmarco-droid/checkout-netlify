# Regole di revisione — checkout condiviso

Letto da Claude Code Review (se attivato), dal job «revisione» di `.github/workflows/claude.yml`, dal subagente `revisore-pagamenti` e da qualsiasi IA che riveda una richiesta di unione. Scrivi i commenti in italiano.

## Priorità (dalla più grave)
1. **Pagamenti**: l'importo, la valuta e il prodotto devono venire solo dal catalogo lato server, mai dal browser; la cattura PayPal va verificata (stato COMPLETED, importo e valuta uguali al catalogo, reference_id corretto) prima di qualsiasi consegna; webhook accettati solo con firma verificata (PayPal `verify-webhook-signature`, Paddle HMAC); idempotenza su ordini, catture e consegne; rimborsi e storni revocano licenze e download.
2. **Vendite reali**: stato attuale su `main` — il Live PayPal si attiva con `PAYPAL_LIVE_ENABLED=true` sul deploy di produzione (contesto `production`, `lib/paypal.mjs`) e, per le offerte storiche, con il link firmato dell'ordine confermato. La richiesta di unione SITE FACTORY 365 aggiunge, per i soli prodotti del catalogo, due condizioni ulteriori: `LIVE_PAYMENTS_APPROVED` con la frase prevista e `status: "live"` nel catalogo (`sellable()` in `lib/sf365/core.mjs`); per Paddle `PADDLE_ENV=live`. Segnala ogni modifica che allenta una di queste condizioni o che aggiunge un percorso di pagamento che non le rispetta.
3. **Autenticazione e autorizzazione**: endpoint amministrativi protetti da token confrontato in tempo costante; licenze e token di consegna non indovinabili; CORS limitato ai siti del catalogo; controllo dell'`Origin` sulle richieste POST.
4. **Segreti e dati personali**: nessuna credenziale nel codice, nei test, nei log o nelle risposte; nessun dato personale dell'acquirente oltre il necessario; nessun segreto nei messaggi di errore.
5. **Correttezza**: casi limite (sessione scaduta, doppio ritorno da PayPal, errori di rete, prodotto in bozza), messaggi all'utente chiari, nessuna regressione per le offerte storiche (OspitaBene, Skywatcher, StudyGrid, Patentino IA, Recensioni Serene).
6. **Test**: ogni modifica al flusso di pagamento ha un test che fallirebbe senza la modifica.

## Da non commentare
- Stile e formattazione, se il codice è coerente con il file circostante.
- File generati in `public/` dallo script `npm run pagine` (quando presente), salvo errori di contenuto.

## Modifiche che richiedono sempre la revisione del titolare
`.github/`, `.claude/`, `scripts/controlli-sicurezza.mjs`, `REVIEW.md`, `CLAUDE.md`: definiscono i controlli stessi, quindi una richiesta di unione che li indebolisce va segnalata come bloccante.

## Esito
La revisione non approva e non unisce. L'unione spetta al titolare.
