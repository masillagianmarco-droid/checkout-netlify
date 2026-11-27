// Collegamento dell'isolamento delle anteprime alle Functions (rilievo della revisione Claude del 27/11/2026).
// Se una Function che usa gli archivi SF365 non è avvolta da withCheckoutStorage, in produzione scriverebbe
// negli archivi sf365-sandbox-* e le licenze vendute non sarebbero più trovate dalla verifica.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../netlify/functions/', import.meta.url));
// Funzioni di core.mjs che leggono o scrivono gli archivi sf365-*.
const STORAGE = ['store', 'getJSON', 'setJSON', 'listKeys', 'recordTransaction', 'fulfil', 'setLicenseStatus', 'syncSubscriptionLicense'];

function coreImports(src) {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/\.\.\/lib\/sf365\/core\.mjs["']/);
  return m ? m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : null;
}

test('ogni Function che usa gli archivi SF365 è avvolta da withCheckoutStorage', () => {
  const checked = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(dir + file, 'utf8');
    const names = coreImports(src);
    if (!names || !names.some((n) => STORAGE.includes(n))) continue;
    checked.push(file);
    assert.ok(names.includes('withCheckoutStorage'), `${file}: importa gli archivi SF365 ma non withCheckoutStorage`);
    assert.match(src, /export\s+default\s+withCheckoutStorage\(/, `${file}: l'export predefinito non è avvolto da withCheckoutStorage`);
  }
  assert.ok(checked.length >= 7, `attese almeno 7 Functions controllate, trovate ${checked.length}: ${checked.join(', ')}`);
});

test('in produzione la verifica licenze legge sf365-licenses, in anteprima sf365-sandbox-licenses', async () => {
  const original = globalThis.__SF365_TEST_STORE__;
  const seen = [];
  globalThis.__SF365_TEST_STORE__ = (name, storeName) => {
    seen.push(storeName);
    return { get: async () => null };
  };
  try {
    const { default: license } = await import('../netlify/functions/sf365-license.mjs');
    const body = JSON.stringify({ key: 'SF365-AAAAA-BBBBB-CCCCC-DDDDD' });
    const req = () => new Request('https://checkout.example.test/api/license/verify', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const prod = await (await license(req(), { deploy: { context: 'production' } })).json();
    const prev = await (await license(req(), { deploy: { context: 'deploy-preview' } })).json();
    assert.deepEqual([prod.reason, prev.reason], ['sconosciuta', 'sconosciuta']);
    assert.deepEqual(seen, ['sf365-licenses', 'sf365-sandbox-licenses']);
  } finally {
    if (original === undefined) delete globalThis.__SF365_TEST_STORE__;
    else globalThis.__SF365_TEST_STORE__ = original;
  }
});
