// Verifica delle protezioni del repository: hook di Claude Code e controlli di sicurezza della CI.
// Include i casi di aggiramento emersi dalla revisione indipendente del 24/11/2026.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const hook = (event) => spawnSync(process.execPath, [join(ROOT, '.claude/hooks/guardia.mjs')], { input: JSON.stringify(event) }).status;

// Repository temporaneo con due rami, per i push senza destinazione.
const repo = mkdtempSync(join(tmpdir(), 'guardia-'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
git('branch', 'lavoro');
const bash = (command, cwd = repo) => hook({ tool_name: 'Bash', tool_input: { command }, cwd });

const BLOCCATI = [
  'git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main',
  `git -C ${repo} push origin main`, 'git -c push.negotiate=true push origin main',
  'git push --force origin x', 'git push -f origin x', 'git push -uf origin x', 'git push origin +lavoro',
  'git push --force-with-lease origin x', 'git push', 'git push -u origin HEAD',
  'gh pr merge 4 --squash', 'gh api -X PUT repos/o/r/pulls/4/merge', 'gh api -X POST repos/o/r/merges -f base=main',
  'gh api -X PUT repos/o/r/contents/a.txt -f message=x', 'gh api -X PUT repos/o/r/actions/secrets/X',
  'gh secret set X', 'gh secret remove X',
  'netlify deploy --prod', 'npx netlify-cli deploy --prod --dir public', 'ntl deploy --prod', 'netlify deploy -p',
  'netlify env:set PAYPAL_LIVE_ENABLED true', 'netlify env:set PAYPAL_LIVE_ENABLED "true"', "netlify env:set PAYPAL_LIVE_ENABLED 'true'",
  'netlify env:set LIVE_PAYMENTS_APPROVED si-autorizzato-dal-titolare', 'PADDLE_ENV=live node x',
  'netlify env:set PAYPAL_CLIENT_SECRET abc', 'netlify env:import .env.prod',
  'echo A=1 > .env', 'echo A=1 >> config/.env.local', 'cp a .env', 'printf x | tee .env',
  "sed -i 's/sandbox/live/' catalog/products.mjs",
];
const AMMESSI = [
  'git push -u origin ci/automazione-qualita', 'git push origin main-fix', 'git push origin feature/main',
  'npm test && git checkout main', 'gh pr create --draft --title x', 'gh pr view 4', 'gh api repos/o/r/pulls',
  'netlify deploy --dir public', 'netlify env:set SITE_NAME prova', 'cp .env.example .env.example.bak', 'cat .env.example',
  "grep -n live catalog/products.mjs",
];

test('hook: blocca le operazioni riservate al titolare (comprese le varianti di aggiramento)', () => {
  for (const c of BLOCCATI) assert.equal(bash(c), 2, c);
});

test('hook: lascia passare il lavoro ordinario', () => {
  git('checkout', '-q', 'lavoro');
  try {
    for (const c of [...AMMESSI, 'git push', 'git push -u origin HEAD']) assert.equal(bash(c), 0, c);
  } finally { git('checkout', '-q', 'main'); }
});

test('hook: file, catalogo e strumenti MCP', () => {
  const ed = (tool_name, tool_input) => hook({ tool_name, tool_input, cwd: repo });
  assert.equal(ed('Write', { file_path: '/r/.env', content: 'A=1' }), 2);
  assert.equal(ed('Write', { file_path: '/r/.env.example', content: 'A=' }), 0);
  for (const s of ['status: "live"', "status: 'live'", '"status": "live"', 'status: `live`']) {
    assert.equal(ed('Edit', { file_path: '/r/catalog/products.mjs', new_string: s }), 2, s);
  }
  assert.equal(ed('MultiEdit', { file_path: '/r/catalog/products.mjs', edits: [{ old_string: 'a', new_string: 'status: "live"' }] }), 2);
  assert.equal(ed('Edit', { file_path: '/r/catalog/products.mjs', new_string: 'status: "sandbox"' }), 0);
  assert.equal(ed('Edit', { file_path: '/r/netlify.toml', new_string: 'PAYPAL_LIVE_ENABLED = "true"' }), 2);
  assert.equal(ed('mcp__github__merge_pull_request', { pullNumber: 4 }), 2);
  assert.equal(ed('mcp__Netlify__netlify-project-services-updater', { operation: 'manage-env-vars', key: 'PAYPAL_LIVE_ENABLED', value: 'true' }), 2);
  assert.equal(ed('mcp__Netlify__netlify-project-services-updater', { operation: 'manage-env-vars', key: 'PAYPAL_CLIENT_SECRET', value: 'x' }), 2);
  assert.equal(ed('mcp__Netlify__netlify-deploy-services-updater', { operation: 'deploy-site', siteId: 'abc' }), 0);
  assert.equal(ed('Read', { file_path: '/r/.env' }), 0);
});

test('controlli di sicurezza: repository pulito superato, credenziali rifiutate', () => {
  const run = (cwd) => spawnSync(process.execPath, ['scripts/controlli-sicurezza.mjs'], { cwd, encoding: 'utf8' });
  assert.equal(run(ROOT).status, 0, 'il repository non deve contenere credenziali');
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), 'sicurezza-'));
    mkdirSync(join(d, 'scripts'));
    copyFileSync(join(ROOT, 'scripts/controlli-sicurezza.mjs'), join(d, 'scripts/controlli-sicurezza.mjs'));
    return d;
  };
  const ok = fresh();
  writeFileSync(join(ok, 'ok.mjs'), [
    "process.env.PAYPAL_CLIENT_SECRET = 'test-secret-for-unit-tests';",
    'const s = process.env.PAYPAL_CLIENT_SECRET;',
    "process.env.CHECKOUT_ORDER_SIGNING_KEY = 'k'.repeat(40);",
    'secret: live ? process.env.PAYPAL_LIVE_CLIENT_SECRET : process.env.PAYPAL_CLIENT_SECRET,',
  ].join('\n'));
  assert.equal(run(ok).status, 0, 'valori fittizi e riferimenti a process.env sono ammessi');

  // Valori fittizi costruiti a runtime: nel sorgente non compaiono come letterali unici.
  const j = (...p) => p.join('');
  const casi = [
    ['a.toml', `PAYPAL_CLIENT_SECRET=${j('EBWKjlELKMYq', 'RNQ6sYvFo64F', 'taRLRR5BdHEE')}`],
    ['b.env.txt', `CHECKOUT_ORDER_SIGNING_KEY=${j('9f86d081884c7d65', '9a2feaa0c55ad015', 'a3bf4f1b2b0b822c', 'd15d6c15b0f00a08')}`],
    ['c.json', `{"client_secret": "${j('Abc123Def456', 'Ghi789Jkl012')}"}`],
    ['d.md', `token ${j('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCD')}`],
    ['Dockerfile', j('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----')],
    ['chiave.pem', 'x'],
  ];
  for (const [name, content] of casi) {
    const d = fresh();
    writeFileSync(join(d, name), content + '\n');
    const r = run(d);
    assert.equal(r.status, 1, name);
    assert.match(r.stdout, new RegExp(name.replace('.', '\\.')), name);
  }
});
