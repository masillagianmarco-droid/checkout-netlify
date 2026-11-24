/*
 * SITE FACTORY 365 — registro centralizzato dei prodotti autorizzati.
 * È la sola fonte dei prezzi: il checkout non accetta mai importi dal browser.
 *
 * Campi
 *   sku        identificativo univoco (minuscole, cifre, trattini)
 *   project    identificativo del progetto nel registro condiviso (es. SF365-0001)
 *   owner_ai   IA responsabile del sito (Claude, ChatGPT, Grokbot, Gemini)
 *   site       origine del sito che vende il prodotto (usata anche per CORS e ritorno)
 *   type       "one_time" | "subscription"
 *   interval   "month" | "year" (solo abbonamenti)
 *   price      importo in EUR come stringa con due decimali, IVA inclusa per i consumatori
 *   delivery   { kind: "license" | "download" | "license+download", license_days?, file? }
 *   status     "draft" (non vendibile) | "sandbox" (solo ambiente di prova) | "live" (vendibile, richiede autorizzazione)
 */
export const PRODUCTS = [
  {
    // SOSPESO il 24/11/2026 (decisione del titolare: nessuno sviluppo commerciale che si sovrapponga ai progetti
    // professionali del padre). status "draft" = non vendibile e non elencato; voci conservate per lo storico.
    sku: "dpa-studio-pro-12m",
    project: "SF365-0001",
    owner_ai: "Claude",
    site: "https://dpa-studio.netlify.app",
    name: "DPA Studio — Licenza professionale 12 mesi",
    description: "Calcolatore dell'induzione magnetica e della DPA degli elettrodotti: circuiti multipli, relazione di calcolo in PDF, esportazione CSV, salvataggio dei progetti. Licenza personale valida 12 mesi.",
    type: "one_time",
    price: "39.00",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license", license_days: 365 },
    return_url: "https://dpa-studio.netlify.app/app",
    status: "draft"
  },
  {
    sku: "dpa-studio-pro-mensile",
    project: "SF365-0001",
    owner_ai: "Claude",
    site: "https://dpa-studio.netlify.app",
    name: "DPA Studio — Abbonamento professionale mensile",
    description: "Le stesse funzioni della licenza professionale, con rinnovo mensile e disdetta in qualsiasi momento.",
    type: "subscription",
    interval: "month",
    price: "5.00",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license" },
    return_url: "https://dpa-studio.netlify.app/app",
    status: "draft"
  },
  {
    sku: "dpa-studio-pro-annuale",
    project: "SF365-0001",
    owner_ai: "Claude",
    site: "https://dpa-studio.netlify.app",
    name: "DPA Studio — Abbonamento professionale annuale",
    description: "Licenza professionale con rinnovo automatico annuale e disdetta in qualsiasi momento.",
    type: "subscription",
    interval: "year",
    price: "39.00",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license" },
    return_url: "https://dpa-studio.netlify.app/app",
    status: "draft"
  },
  {
    // SF365-0002 (Claude, 24/11/2026; già «TurniChiari», rinominato Avvicendo). Listino iniziale deciso dal titolare
    // il 24/11 (15:38), in Sandbox: Free gratuito, Pro mensile 3,90 €, Pro annuale 29 €, licenza 12 mesi senza rinnovo 34,90 €.
    sku: "avvicendo-pro-12m",
    project: "SF365-0002",
    owner_ai: "Claude",
    site: "https://avvicendo.netlify.app",
    name: "Avvicendo — Licenza Pro 12 mesi",
    description: "Pianificatore dei turni di lavoro: fino a 60 persone, piani fino a 4 settimane, esportazione CSV, calendari .ics per ogni persona, 20 piani salvati. Licenza personale valida 12 mesi.",
    type: "one_time",
    price: "34.90",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license", license_days: 365 },
    return_url: "https://avvicendo.netlify.app/app",
    status: "sandbox"
  },
  {
    sku: "avvicendo-pro-mensile",
    project: "SF365-0002",
    owner_ai: "Claude",
    site: "https://avvicendo.netlify.app",
    name: "Avvicendo — Abbonamento Pro mensile",
    description: "Le stesse funzioni della licenza Pro, con rinnovo mensile e disdetta in qualsiasi momento.",
    type: "subscription",
    interval: "month",
    price: "3.90",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license" },
    return_url: "https://avvicendo.netlify.app/app",
    status: "sandbox"
  },
  {
    sku: "avvicendo-pro-annuale",
    project: "SF365-0002",
    owner_ai: "Claude",
    site: "https://avvicendo.netlify.app",
    name: "Avvicendo — Abbonamento Pro annuale",
    description: "Licenza Pro con rinnovo automatico annuale e disdetta in qualsiasi momento.",
    type: "subscription",
    interval: "year",
    price: "29.00",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "license" },
    return_url: "https://avvicendo.netlify.app/app",
    status: "sandbox"
  },
  {
    // Sito e prodotto realizzati da Grok Bot (registro GROKBOT, 24/11/2026). Prezzo 9,90 € indicato
    // da Grok Bot come approvato dal titolare. Il file va caricato nello store Blobs "files" con questa chiave.
    sku: "forfettario-in-ordine-2026",
    project: "SF365-001-GROK",
    owner_ai: "Grokbot",
    site: "https://forfettario-in-ordine.netlify.app",
    name: "Forfettario in Ordine 2026 — kit Excel",
    description: "Foglio di calcolo per partite IVA in regime forfettario: registro incassi, stima di imposta sostitutiva e contributi, scadenze. Include file di esempio e guida PDF. Strumento di organizzazione, non consulenza fiscale.",
    type: "one_time",
    price: "9.90",
    currency: "EUR",
    tax_category: "standard",
    delivery: { kind: "download", file: "sf365/forfettario-in-ordine-2026-v1.0.zip" },
    return_url: "https://forfettario-in-ordine.netlify.app/",
    status: "sandbox"
  }
];

const SKU_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function validateCatalog(list = PRODUCTS) {
  const errors = [];
  const seen = new Set();
  for (const p of list) {
    const where = p.sku || "(senza sku)";
    if (!SKU_RE.test(p.sku || "")) errors.push(`${where}: sku non valido`);
    if (seen.has(p.sku)) errors.push(`${where}: sku duplicato`);
    seen.add(p.sku);
    if (!/^\d+\.\d{2}$/.test(p.price || "") || Number(p.price) <= 0) errors.push(`${where}: prezzo non valido`);
    if (p.currency !== "EUR") errors.push(`${where}: valuta non supportata`);
    if (!["one_time", "subscription"].includes(p.type)) errors.push(`${where}: tipo non valido`);
    if (p.type === "subscription" && !["month", "year"].includes(p.interval)) errors.push(`${where}: periodo non valido`);
    if (!["draft", "sandbox", "live"].includes(p.status)) errors.push(`${where}: stato non valido`);
    if (!/^https:\/\/[a-z0-9.-]+$/.test(p.site || "")) errors.push(`${where}: sito non valido`);
    if (!p.delivery || !["license", "download", "license+download"].includes(p.delivery.kind)) errors.push(`${where}: consegna non valida`);
    if (p.delivery && p.delivery.kind.includes("download") && !p.delivery.file) errors.push(`${where}: manca il file da consegnare`);
  }
  return errors;
}

export function findProduct(sku) {
  return PRODUCTS.find((p) => p.sku === sku) || null;
}

export function publicProduct(p) {
  return {
    sku: p.sku, name: p.name, description: p.description, type: p.type, interval: p.interval || null,
    price: p.price, currency: p.currency, site: p.site, return_url: p.return_url, status: p.status,
    delivery: p.delivery.kind
  };
}

export function allowedOrigins() {
  return [...new Set(PRODUCTS.map((p) => p.site))];
}
