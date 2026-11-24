# Checkout condiviso · PayPal Sandbox

La prima offerta di prova è il Kit Annuncio di OspitaBene a 49,00 EUR. Tutte le richieste PayPal usano Sandbox, quindi il checkout simula i pagamenti. Dopo l’approvazione su PayPal una seconda conferma esegue l’incasso simulato e verifica l’esito.

## Configurazione

1. Collega la radice del progetto a un deploy di prova Netlify. La cartella da pubblicare è `public` e le Functions sono in `netlify/functions`. Un upload del solo contenuto di `public` non include le Functions.
2. Nelle variabili d’ambiente del progetto inserisci `PAYPAL_CLIENT_ID` e `PAYPAL_CLIENT_SECRET` dall’app **Checkout siti Netlify** in PayPal Sandbox. Contrassegna il segreto e, se disponibili, limita le variabili alle Functions e al contesto del deploy di prova. Applica la modifica con un nuovo deploy.
3. Apri `/checkout?offerta=ospitabene-kit-annuncio` sul deploy HTTPS. Esegui la prova con un account acquirente Sandbox. Il test automatizzato locale usa risposte PayPal simulate e si esegue con `node --test`.

Il prezzo, la valuta e l’offerta sono definiti nella Function. Per aggiungere un sito o un prodotto, configura prima l’offerta e usa il suo codice nel link. Mantieni privati i valori delle variabili d’ambiente.

La pubblicazione con pagamenti veri richiede il collaudo con Sandbox, una configurazione Live e il collegamento del pagamento all’ordine del cliente. La consegna automatica di file e l’accesso a servizi richiedono la registrazione persistente dell’esito e il controllo degli eventi PayPal. Questo progetto è dedicato al collaudo.

## Preparazione dei pagamenti reali

Le anteprime usano Sandbox. Sul deploy principale si può usare Live dopo la configurazione delle seguenti variabili nel contesto Production:

- `PAYPAL_LIVE_CLIENT_ID` e `PAYPAL_LIVE_CLIENT_SECRET` dall’app Live. Mantieni il segreto protetto.
- `CHECKOUT_ORDER_SIGNING_KEY` con un valore casuale dedicato di almeno 32 caratteri. Proteggi anche questo valore.
- `PAYPAL_LIVE_ENABLED=true`, quando il flusso reale è pronto per l’attivazione.

Per il servizio OspitaBene, conferma prima il preventivo con il cliente. Assegna un riferimento univoco, ad esempio `OSP-001`. Con lo stesso valore di `CHECKOUT_ORDER_SIGNING_KEY` caricato in modo sicuro nell’ambiente locale, genera il link con:

```sh
node scripts/crea-link-ordine.mjs https://il-tuo-checkout.netlify.app ospitabene-kit-annuncio OSP-001
```

Il link scade dopo quattro ore. Il registro Netlify Blobs riserva una sola operazione di creazione PayPal per riferimento d’ordine e conserva i dati necessari per ripeterla in modo idempotente entro la finestra supportata da PayPal. Il riferimento viene riportato nell’ordine PayPal. Prima di evadere un ordine o inviare un nuovo link dopo una scadenza, verifica lo stato della transazione nel pannello PayPal.

La consegna per OspitaBene è manuale. I prodotti digitali dovranno essere configurati con il loro flusso di consegna e con la verifica degli eventi di pagamento.

## Offerte OspitaBene

| Offerta | Codice per il checkout | Prezzo |
| --- | --- | ---: |
| Kit Annuncio | `ospitabene-kit-annuncio` | 49,00 EUR |
| Kit Ospitalità Completo | `ospitabene-kit-completo` | 99,00 EUR |
| Kit Ospitalità Completo, promozione su conferma | `ospitabene-kit-completo-lancio` | 49,00 EUR |

La promozione richiede la conferma della disponibilità prima di emettere il link. Per Recensioni Serene, a 19 EUR al mese, occorre un piano di abbonamento con gestione delle disdette. Il modulo OspitaBene continua a raccogliere le richieste di preventivo.
