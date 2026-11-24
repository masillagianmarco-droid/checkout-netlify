#!/usr/bin/env node
// Hook PreToolUse di Claude Code: blocca le operazioni che spettano solo al titolare.
// È un parapetto per agenti collaborativi, non una barriera di sicurezza: le barriere vere sono la regola
// (ruleset) su main, i segreti accessibili solo al titolare e la revisione obbligatoria.
// Riceve su stdin il JSON dell'evento; esce con 2 (azione bloccata, motivo su stderr) oppure 0.
import { readFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let event = {};
try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = String(event.tool_name || '');
const input = event.tool_input || {};
const cwd = event.cwd || process.cwd();

function deny(why) {
  const msg = `Bloccato dall'hook di protezione del repository: ${why}. Questa operazione spetta al titolare.\n`;
  try { writeSync(2, msg); } catch { /* stderr non disponibile */ }
  process.exit(2);
}

const LIVE = /\b(?:PAYPAL_LIVE_ENABLED|LIVE_PAYMENTS_APPROVED)\b\s*(?:=|:|\s)\s*["']?(?:true|si-autorizzato)/i;
const PADDLE_LIVE = /\bPADDLE_ENV\b\s*(?:=|:|\s)\s*["']?live\b/i;
const SENSITIVE_VAR = /\b[A-Z0-9_]*(?:SECRET|_KEY|TOKEN|PASSWORD|LIVE)[A-Z0-9_]*\b/;
const CATALOG_LIVE = /["'`]?status["'`]?\s*:\s*["'`]live/;
const ENV_FILE = /(^|[\s/'"=])\.env(?:\.(?!example\b)[\w.-]+)?(?=["'\s]|$)/;

function currentBranch(dir) {
  try { return execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function checkGitPush(seg) {
  const m = seg.match(/\bgit((?:\s+(?:-C|-c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+push\b(.*)$/);
  if (!m) return;
  const pre = m[1] || '';
  const args = (m[2] || '').trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => /^--force(?:-with-lease|-if-includes)?(?:=.*)?$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+/.test(a))) deny('push forzato');
  const refs = args.filter((a) => !a.startsWith('-'));
  const isMain = (r) => /^(?:main|master)$/.test(r) || /:(?:refs\/heads\/)?(?:main|master)$/.test(r);
  if (refs.slice(1).some(isMain) || (refs.length === 1 && isMain(refs[0]))) deny('push su main');
  if (refs.length <= 1 || refs.slice(1).every((r) => r === 'HEAD')) {
    const dir = (pre.match(/-C\s+(\S+)/) || [])[1] || cwd;
    if (/^(?:main|master)$/.test(currentBranch(dir.replace(/^["']|["']$/g, '')))) deny('push dal ramo main');
  }
}

function checkBash(cmd) {
  if (LIVE.test(cmd)) deny('attivazione delle vendite reali');
  if (PADDLE_LIVE.test(cmd)) deny('attivazione di Paddle Live');
  for (const seg of cmd.split(/\n|;|&&|\|\||\|/)) {
    const s = seg.trim();
    if (!s) continue;
    checkGitPush(s);
    if (/\bgh\s+pr\s+merge\b/.test(s)) deny('unione di una richiesta');
    if (/\bgh\s+(?:secret|variable)\s+(?:set|remove|delete)\b/.test(s)) deny('modifica di segreti o variabili di GitHub');
    if (/\bgh\s+repo\s+(?:delete|edit\b.*--visibility)/.test(s)) deny('eliminazione o cambio di visibilità del repository');
    if (/\bgh\s+api\b/.test(s)) {
      if (/\/(?:pulls\/\d+\/merge|merges)\b/.test(s)) deny("unione tramite l'API");
      const writes = /(?:-X|--method)\s*["']?(?:PUT|POST|PATCH|DELETE)\b/i.test(s) || /\s-(?:f|F)\s|--field\b|--raw-field\b|--input\b/.test(s);
      if (writes && /\/(?:contents|git\/refs|actions\/(?:secrets|variables)|environments|rulesets|branches\/[^/\s]+\/protection)\b/.test(s)) {
        deny("scrittura tramite l'API su contenuti, rami, segreti o regole");
      }
    }
    if (/\b(?:netlify|ntl|netlify-cli)\b.*\bdeploy\b.*(?:--prod(?:uction)?\b|(?:^|\s)-p(?:\s|$))/.test(s)) deny('deploy di produzione');
    if (/\b(?:netlify|ntl|netlify-cli)\b.*\benv:(?:set|unset|import|clone)\b/.test(s) && (SENSITIVE_VAR.test(s) || /env:import/.test(s))) {
      deny('modifica di variabili sensibili su Netlify');
    }
    if (ENV_FILE.test(s) && (/>/.test(s) || /\b(?:tee|cp|mv|install|touch|dd)\b/.test(s))) deny('scrittura di un file .env');
    if (/catalog\/products\.mjs/.test(s) && /\blive\b/.test(s) && /(?:\bsed\b|\bperl\b|\bawk\b|\btee\b|>|\bcp\b|\bmv\b)/.test(s)) {
      deny('status "live" nel catalogo');
    }
  }
}

if (tool === 'Bash') checkBash(String(input.command || ''));

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const path = String(input.file_path || input.notebook_path || '');
  if (/(^|\/)\.env(\.[^/]*)?$/.test(path) && !path.endsWith('.example')) deny('scrittura di un file .env');
  const parts = [input.content, input.new_string, input.new_source, ...(Array.isArray(input.edits) ? input.edits.map((e) => e && e.new_string) : [])];
  const text = parts.filter((x) => typeof x === 'string').join('\n');
  if (/catalog\/products\.mjs$/.test(path) && CATALOG_LIVE.test(text)) deny('status "live" nel catalogo');
  if (LIVE.test(text) && !/\.(?:md|test\.mjs)$/.test(path)) deny('attivazione delle vendite reali nel codice o nella configurazione');
}

if (tool.startsWith('mcp__')) {
  const text = JSON.stringify(input);
  if (/merge/i.test(tool)) deny("unione tramite uno strumento MCP");
  if (LIVE.test(text.replace(/\\"/g, '"')) || PADDLE_LIVE.test(text.replace(/\\"/g, '"'))) deny('attivazione delle vendite reali tramite uno strumento MCP');
  if (/netlify/i.test(tool) && /env/i.test(text) && /PAYPAL|PADDLE|SIGNING_KEY|ADMIN_TOKEN|LIVE_PAYMENTS/.test(text)) {
    deny('modifica di variabili sensibili su Netlify tramite MCP');
  }
}
process.exit(0);
