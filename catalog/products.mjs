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
    status: "sandbox"
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
    status: "sandbox"
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
