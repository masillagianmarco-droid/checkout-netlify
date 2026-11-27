// Genera le pagine statiche del negozio e delle condizioni a partire da catalogo e dati del venditore.
// Uso: node tools/build-pages.mjs
import { writeFileSync } from "node:fs";
import { PRODUCTS, validateCatalog } from "../catalog/products.mjs";
import { SELLER } from "../catalog/seller.mjs";

const errs = validateCatalog();
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todo = (v, label) => v ? esc(v) : `<mark>${esc(label)} da completare</mark>`;
const eur = (p) => Number(p).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
const period = (p) => p.type === "subscription" ? (p.interval === "year" ? " / anno" : " / mese") : "";
const kind = (p) => p.type === "subscription" ? `Abbonamento ${p.interval === "year" ? "annuale" : "mensile"} con rinnovo automatico, disdicibile in qualsiasi momento` : "Pagamento unico";
const sellerBlock = `<p><b>${esc(SELLER.brand)}</b> — servizio di ${esc(SELLER.name)}${SELLER.legal_form ? ", " + esc(SELLER.legal_form) : ""}<br>
Sede: ${todo(SELLER.address, "Indirizzo")}<br>Partita IVA: ${todo(SELLER.vat_id, "Partita IVA")}<br>
Email: ${todo(SELLER.email, "Email di assistenza")}${SELLER.pec ? "<br>PEC: " + esc(SELLER.pec) : ""}</p>`;

const head = (title, desc) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/hub.css"></head>
<body><header class="top"><div class="wrap"><a class="brand" href="/"><img src="/favicon.svg" width="34" height="34" alt=""><span>SITE FACTORY 365<small>SOFTWARE E STRUMENTI DIGITALI</small></span></a>
<nav class="main"><a href="/#prodotti">Prodotti</a><a href="/catalogo.html">Altri prodotti</a><a href="/termini-vendita.html">Condizioni</a><a href="/rimborsi.html">Rimborsi</a><a href="/contatti.html">Contatti</a></nav></div></header>`;
const foot = `<footer><div class="wrap" style="display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between">
<span>© 2026 ${esc(SELLER.brand)} · ${esc(SELLER.name)}${SELLER.vat_id ? " · P. IVA " + esc(SELLER.vat_id) : ""}</span>
<span><a href="/termini-vendita.html">Condizioni di vendita</a> · <a href="/rimborsi.html">Rimborsi</a> · <a href="/privacy.html">Privacy</a> · <a href="/contatti.html">Contatti</a></span></div></footer></body></html>
`;

const cards = PRODUCTS.filter((p) => p.status !== "draft").map((p) => `
<article class="card prod">
  <h3>${esc(p.name)}</h3>
  <p>${esc(p.description)}</p>
  <p class="price">${eur(p.price)}<span class="per">${period(p)}</span></p>
  <p class="small muted">${kind(p)}. Prezzo IVA inclusa per i consumatori. Consegna digitale immediata della chiave di licenza dopo il pagamento.</p>
  <p class="small">Sito del prodotto: <a href="${esc(p.site)}">${esc(p.site.replace("https://", ""))}</a></p>
  <a class="btn accent" href="${p.type === "subscription" ? "/abbonamento" : "/checkout"}?offerta=${esc(p.sku)}">${p.type === "subscription" ? "Abbonati" : "Acquista"}</a>
</article>`).join("");

writeFileSync("public/index.html", head("SITE FACTORY 365 — Software e strumenti digitali professionali", "Negozio ufficiale dei software e degli strumenti digitali SITE FACTORY 365: licenze e abbonamenti con consegna immediata.") + `
<main>
<div class="hero"><div class="wrap">
  <div class="kicker">Negozio ufficiale</div>
  <h1>Software e strumenti digitali per professionisti</h1>
  <p class="lead">SITE FACTORY 365 sviluppa applicazioni web, calcolatori tecnici e servizi digitali. Qui acquisti licenze e abbonamenti con PayPal: la consegna è automatica. Gli altri materiali digitali sono nel <a href="/catalogo.html">catalogo</a>.</p>
</div></div>
<section id="prodotti"><div class="wrap"><h2>Prodotti</h2><div class="grid3" style="margin-top:18px">${cards}</div></div></section>
<section style="background:#fff;border-top:1px solid var(--line)"><div class="wrap grid3">
  <div><h3>Come avviene l'acquisto</h3><p>Scegli il prodotto, accetta le condizioni e paga con PayPal o con carta. Ricevi subito la chiave di licenza nella pagina di conferma, con le istruzioni per attivarla nel software.</p></div>
  <div><h3>Abbonamenti</h3><p>Gli abbonamenti si rinnovano automaticamente alla fine di ogni periodo e si disdicono in qualsiasi momento dal proprio conto PayPal o dal link nella ricevuta; la licenza resta attiva fino al termine del periodo pagato.</p></div>
  <div><h3>Assistenza e rimborsi</h3><p>Per qualsiasi problema scrivi dalla <a href="/contatti.html">pagina contatti</a>. Rimborso su richiesta entro ${SELLER.refund_days} giorni dall'acquisto: vedi la <a href="/rimborsi.html">politica di rimborso</a>.</p></div>
</div></section>
<section><div class="wrap"><h2>Venditore</h2>${sellerBlock}</div></section>
</main>` + foot);

writeFileSync("public/termini-vendita.html", head("Condizioni di vendita — SITE FACTORY 365", "Condizioni generali di vendita dei prodotti digitali SITE FACTORY 365.") + `
<main class="wrap doc">
<h1>Condizioni generali di vendita</h1><p class="muted">Ultimo aggiornamento: 24 novembre 2026</p>
<h2>1. Venditore</h2>${sellerBlock}
<h2>2. Oggetto</h2><p>Le presenti condizioni regolano la vendita a distanza di licenze software e abbonamenti a servizi digitali pubblicati nel <a href="/#prodotti">catalogo</a>. Le caratteristiche essenziali, la durata e il prezzo di ogni prodotto sono indicati nella relativa scheda e nella pagina di pagamento.</p>
<h2>3. Prezzi e pagamento</h2><p>I prezzi sono espressi in euro e comprendono l'IVA dovuta dai consumatori. Il pagamento avviene tramite PayPal (conto PayPal o carta, elaborati da PayPal) oppure, quando indicato, tramite Paddle. Nel caso di Paddle, il processo d'ordine è gestito dal rivenditore online Paddle.com, che agisce come Merchant of Record e applica anche le proprie condizioni per l'acquirente. Il venditore non riceve né conserva i dati della carta.</p>
<h2>4. Conclusione del contratto e consegna</h2><p>Il contratto si conclude quando il pagamento è confermato. La chiave di licenza è mostrata immediatamente nella pagina di conferma, insieme a un collegamento alla pagina di consegna; il prodotto si attiva inserendo la chiave nel software indicato. Per i file scaricabili il collegamento di download è disponibile dopo la verifica del pagamento.</p>
<h2>5. Abbonamenti</h2><p>Gli abbonamenti mensili e annuali si rinnovano automaticamente al prezzo in vigore al momento della sottoscrizione, salvo disdetta. La disdetta è possibile in qualsiasi momento e ha effetto alla scadenza del periodo già pagato. Eventuali variazioni di prezzo saranno comunicate con almeno 30 giorni di anticipo e non si applicano al periodo in corso.</p>
<h2>6. Diritto di recesso</h2><p>Per i contenuti digitali forniti su supporto non materiale il consumatore, chiedendo l'esecuzione immediata e prendendo atto della conseguente perdita del diritto di recesso (art. 59, comma 1, lettera o, del Codice del Consumo), non può esercitare il recesso dopo la consegna. Resta comunque valida la <a href="/rimborsi.html">politica di rimborso volontario</a> di ${SELLER.refund_days} giorni.</p>
<h2>7. Licenza d'uso</h2><p>La licenza è personale, non esclusiva e non trasferibile, per la durata acquistata. È vietato condividere la chiave o aggirare i controlli di licenza.</p>
<h2>8. Garanzie e responsabilità</h2><p>Il venditore garantisce la conformità del prodotto alla descrizione e corregge i difetti segnalati. Gli strumenti di calcolo sono di supporto ai professionisti: i risultati vanno verificati da un tecnico abilitato. Restano fermi i diritti del consumatore previsti dalla legge.</p>
<h2>9. Reclami e controversie</h2><p>Reclami alla <a href="/contatti.html">pagina contatti</a>. Si applica la legge italiana; per i consumatori è competente il foro di residenza o domicilio del consumatore. Piattaforma europea per le controversie dei consumatori: verificarne la disponibilità sul sito della Commissione europea.</p>
</main>` + foot);

writeFileSync("public/rimborsi.html", head("Politica di rimborso — SITE FACTORY 365", "Rimborsi e disdette per licenze e abbonamenti SITE FACTORY 365.") + `
<main class="wrap doc">
<h1>Politica di rimborso</h1><p class="muted">Ultimo aggiornamento: 24 novembre 2026</p>
<p>Se un prodotto non soddisfa le tue esigenze puoi chiedere il rimborso completo entro <b>${SELLER.refund_days} giorni</b> dall'acquisto, scrivendo dalla <a href="/contatti.html">pagina contatti</a> e indicando il numero d'ordine o l'email usata per il pagamento.</p>
<ul><li>Il rimborso viene eseguito sullo stesso metodo di pagamento entro 14 giorni dall'accettazione della richiesta.</li>
<li>Con il rimborso la chiave di licenza viene disattivata.</li>
<li>Per gli abbonamenti il rimborso riguarda l'ultimo periodo addebitato; la disdetta interrompe i rinnovi successivi.</li>
<li>Gli acquisti effettuati tramite Paddle sono rimborsati da Paddle.com secondo le sue condizioni per l'acquirente.</li></ul>
</main>` + foot);

writeFileSync("public/privacy.html", head("Privacy — SITE FACTORY 365", "Informativa sul trattamento dei dati personali per gli acquisti SITE FACTORY 365.") + `
<main class="wrap doc">
<h1>Informativa privacy</h1><p class="muted">Artt. 13-14 Regolamento (UE) 2016/679 · Ultimo aggiornamento: 24 novembre 2026</p>
<h2>Titolare</h2>${sellerBlock}
<h2>Dati trattati e finalità</h2><ul>
<li><b>Ordini e licenze</b>: identificativi dell'ordine o dell'abbonamento, prodotto, importo, stato, identificativo del pagatore PayPal, chiave di licenza. Finalità: esecuzione del contratto e obblighi di legge (art. 6.1.b e 6.1.c GDPR). Conservazione: 10 anni per i dati contabili, poi cancellazione.</li>
<li><b>Pagamenti</b>: i dati della carta e del conto sono trattati da PayPal (Europe) S.à r.l. et Cie, S.C.A. o, per gli acquisti con Paddle, da Paddle.com Market Ltd come titolari autonomi.</li>
<li><b>Verifica delle licenze</b>: quando un software verifica la chiave, il server riceve chiave, prodotto e indirizzo IP (legittimo interesse alla prevenzione degli abusi, art. 6.1.f).</li>
<li><b>Contatti</b>: email e messaggio, per rispondere alla richiesta.</li></ul>
<h2>Fornitori</h2><p>Hosting e archivio del registro: Netlify, Inc. (USA), responsabile del trattamento; trasferimenti extra UE sulla base delle garanzie del GDPR (Data Privacy Framework o clausole contrattuali standard).</p>
<h2>Cookie</h2><p>Questo sito non usa cookie di profilazione. Le pagine di pagamento caricano i componenti di PayPal o Paddle, che possono impostare cookie tecnici necessari al pagamento e alla prevenzione delle frodi.</p>
<h2>Diritti</h2><p>Accesso, rettifica, cancellazione, limitazione, portabilità e opposizione (artt. 15-22 GDPR) tramite la <a href="/contatti.html">pagina contatti</a>; reclamo al Garante per la protezione dei dati personali (garanteprivacy.it).</p>
</main>` + foot);

writeFileSync("public/contatti.html", head("Contatti — SITE FACTORY 365", "Assistenza clienti SITE FACTORY 365.") + `
<main class="wrap doc" style="max-width:640px">
<h1>Contatti e assistenza</h1>${sellerBlock}
<p>Scrivi a <a href="mailto:${esc(SELLER.email)}">${esc(SELLER.email)}</a> indicando, se ce l'hai, il riferimento PayPal dell'ordine.</p>
</main>` + foot);

// (nessuna pagina "inviato": i contatti avvengono via email)
if (false) writeFileSync("public/inviato.html", head("Messaggio inviato — SITE FACTORY 365", "") + `<main class="wrap doc"><h1>Messaggio inviato</h1><p>Ti risponderemo all'indirizzo indicato.</p><p><a class="btn" href="/">Torna al negozio</a></p></main>` + foot);
console.log("pagine generate");
