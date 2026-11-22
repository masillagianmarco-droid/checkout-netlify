# Checkout condiviso · PayPal Sandbox

La prima offerta di prova è il Kit Annuncio di OspitaBene a 49,00 EUR. Tutte le richieste PayPal usano Sandbox, quindi il checkout simula i pagamenti. Dopo l’approvazione su PayPal una seconda conferma esegue l’incasso simulato e verifica l’esito.

## Configurazione

1. Collega la radice del progetto a un deploy di prova Netlify. La cartella da pubblicare è `public` e le Functions sono in `netlify/functions`. Un upload del solo contenuto di `public` non include le Functions.
2. Nelle variabili d’ambiente del progetto inserisci `PAYPAL_CLIENT_ID` e `PAYPAL_CLIENT_SECRET` dall’app **Checkout siti Netlify** in PayPal Sandbox. Contrassegna il segreto e, se disponibili, limita le variabili alle Functions e al contesto del deploy di prova. Applica la modifica con un nuovo deploy.
3. Apri `/checkout?offerta=ospitabene-kit-annuncio` sul deploy HTTPS. Esegui la prova con un account acquirente Sandbox. Il test automatizzato locale usa risposte PayPal simulate e si esegue con `node --test`.

Il prezzo, la valuta e l’offerta sono definiti nella Function. Per aggiungere un sito o un prodotto, configura prima l’offerta e usa il suo codice nel link. Mantieni privati i valori delle variabili d’ambiente.

La pubblicazione con pagamenti veri richiede il collaudo con Sandbox, una configurazione Live e il collegamento del pagamento all’ordine del cliente. La consegna automatica di file e l’accesso a servizi richiedono la registrazione persistente dell’esito e il controllo degli eventi PayPal. Questo progetto è dedicato al collaudo.
