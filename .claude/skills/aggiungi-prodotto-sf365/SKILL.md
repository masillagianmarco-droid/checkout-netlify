---
name: aggiungi-prodotto-sf365
description: Aggiunge un prodotto o abbonamento di un sito SITE FACTORY 365 al checkout condiviso, in Sandbox, con test e richiesta di unione in bozza. Usala quando un sito nuovo o esistente deve diventare acquistabile tramite questo checkout.
---

# Aggiungere un prodotto SITE FACTORY 365 al checkout

Prerequisito: il catalogo `catalog/products.mjs` esiste nel ramo di lavoro (introdotto dalla richiesta di unione SITE FACTORY 365). Se non c'è, lavora sul ramo di quella richiesta, non creare un catalogo nuovo.

1. **Verifica doppioni**: cerca lo sku e il sito in `catalog/products.mjs` e nel registro «SITE FACTORY 365 — Registro». Un prodotto, uno sku.
2. **Voce di catalogo**: sku minuscolo con trattini; `project` = ID del registro (SF365-NNNN, oppure con suffisso dell'IA, es. SF365-001-GROK); `owner_ai`; `site` (origine https senza barra finale); `type` `one_time` o `subscription` con `interval`; `price` stringa con due decimali in EUR; `delivery` (`license`, `download` con `file`, oppure `license+download`); `return_url` verificato; **`status: "sandbox"`**. Mai `"live"`.
3. **Test**: aggiungi in `test/` almeno un test del flusso Sandbox del nuovo prodotto (importo, consegna, licenza o download) con PayPal simulato.
4. **Controlli**: `npm ci`, `npm test`, `npm run pagine --if-present`, `node scripts/controlli-sicurezza.mjs`. Tutti verdi.
5. **Revisione indipendente**: se hai toccato funzioni, librerie o regole di pagamento (non solo il catalogo), fai rivedere il ramo al subagente `revisore-pagamenti` e correggi i bloccanti.
6. **Consegna**: commit, push del ramo, richiesta di unione in bozza con: che cosa cambia, che cosa non cambia, prove con i numeri, non verificato, ripristino. Aggiorna la riga del registro.
7. **Sito**: il pulsante d'acquisto del sito punta a `/checkout?offerta=<sku>` (o `/abbonamento?offerta=<sku>`) solo dopo l'unione e un test end-to-end in Sandbox su un Deploy Preview.
