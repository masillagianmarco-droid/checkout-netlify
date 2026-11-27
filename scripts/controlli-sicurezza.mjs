#!/usr/bin/env node
// Controlli di sicurezza eseguiti in CI e utilizzabili in locale: `node scripts/controlli-sicurezza.mjs`.
// 1) Nessuna credenziale nell'albero di lavoro (tutti i file di testo, qualunque estensione).
// 2) Avviso se un prodotto del catalogo è marcato "live" (serve l'autorizzazione scritta del titolare).
// Complementare alla secret scanning con push protection di GitHub, attiva sul repository e che copre la cronologia.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.netlify']);
const SELF = 'scripts/controlli-sicurezza.mjs';

const PATTERNS = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/, 'chiave privata'],
  [/-----BEGIN PGP PRIVATE KEY BLOCK-----/, 'chiave PGP privata'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'token GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'token GitHub a grana fine'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'chiave Anthropic'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, 'chiave live di un fornitore di pagamenti'],
  [/\bpdl_(?:live|sdbx)_apikey_[A-Za-z0-9_]{16,}/, 'chiave API Paddle'],
  [/\bnfp_[A-Za-z0-9]{30,}\b/, 'token Netlify'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'chiave AWS'],
];

// Valori letterali assegnati a nomi che indicano un segreto (anche in JSON o YAML, senza distinzione di maiuscole).
const SECRET_ASSIGN = /["']?\b([A-Za-z0-9_]*(?:client_secret|secret|signing_key|api_key|apikey|access_token|auth_token|oauth_token|admin_token|password|private_key)[A-Za-z0-9_]*)\b["']?\s*[=:]\s*["'`]?([A-Za-z0-9+/_.~-]{24,})["'`]?/gi;
const PLACEHOLDER = /^(?:process\.env|import\.meta|env\.|secrets\.|\$\{|test[-_]|fake|dummy|example|placeholder|changeme|x{8,}|<)/i;
function looksLikeSecret(value) {
  if (PLACEHOLDER.test(value)) return false;
  if (/\.repeat\(|\(|\)/.test(value)) return false;
  if (/^[a-z]+(?:[-_.][a-z]+)+$/.test(value)) return false; // parole separate da trattini o punti: nomi, non segreti
  if (/^[A-Z0-9_]+$/.test(value) && /_/.test(value)) return false; // nome di un'altra variabile
  return true;
}

function isText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* files(p);
    else if (s.size < 5_000_000) yield p;
  }
}

const problems = [];
for (const file of files(ROOT)) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (rel === SELF) continue;
  if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith('.example')) problems.push(`${rel}: file .env nel repository`);
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(rel)) problems.push(`${rel}: file di chiavi o certificati privati`);
  const buf = readFileSync(file);
  if (!isText(buf)) continue;
  buf.toString('utf8').split('\n').forEach((line, i) => {
    for (const [re, label] of PATTERNS) if (re.test(line)) problems.push(`${rel}:${i + 1}: possibile ${label}`);
    for (const m of line.matchAll(SECRET_ASSIGN)) {
      if (looksLikeSecret(m[2])) problems.push(`${rel}:${i + 1}: possibile valore segreto assegnato a ${m[1]}`);
    }
  });
}

let warnings = 0;
const catalog = join(ROOT, 'catalog/products.mjs');
if (existsSync(catalog)) {
  const { PRODUCTS } = await import(pathToFileURL(catalog).href); // un errore di importazione fa fallire la CI
  for (const p of PRODUCTS ?? []) {
    // Un prodotto «live» fa fallire la CI se non riporta l'autorizzazione scritta e datata del titolare
    // (campo live_authorization: "AAAA-MM-GG — testo dell'autorizzazione").
    if (p.status === 'live') {
      const auth = typeof p.live_authorization === 'string' ? p.live_authorization : '';
      const day = auth.slice(0, 10), d = new Date(day + 'T00:00:00Z');
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
      if (validDate && auth.length >= 21) {
        warnings++;
        console.log(`::warning file=catalog/products.mjs::Il prodotto ${p.sku} è in vendita reale (autorizzazione: ${auth.slice(0, 80)}).`);
      } else {
        problems.push(`Il prodotto ${p.sku} è marcato "live" senza live_authorization datata del titolare.`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  console.error(`Controlli di sicurezza NON superati: ${problems.length} problemi.`);
  process.exit(1);
}
console.log(`Controlli di sicurezza superati (avvisi: ${warnings}).`);
