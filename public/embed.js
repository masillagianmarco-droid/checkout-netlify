/* SITE FACTORY 365 — collegamento dei siti al checkout centralizzato.
 * <script src="https://lively-croissant-4a8ae9.netlify.app/embed.js" defer></script>
 * <a data-sf365-sku="dpa-studio-pro-12m">Acquista</a>  ·  abbonamenti: <a data-sf365-sku="…" data-sf365-abbonamento>Abbonati</a>
 * SF365.verifyLicense(key, sku) -> Promise<{valid, expires_at, reason}>
 */
(function () {
  'use strict';
  var HUB = 'https://lively-croissant-4a8ae9.netlify.app';
  function link(sku, sub) { return HUB + (sub ? '/abbonamento' : '/checkout') + '?offerta=' + encodeURIComponent(sku); }
  function wire(root) {
    (root || document).querySelectorAll('[data-sf365-sku]').forEach(function (el) {
      var sku = el.getAttribute('data-sf365-sku'); var sub = el.hasAttribute('data-sf365-abbonamento');
      if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(sku)) return;
      if (el.tagName === 'A') { el.href = link(sku, sub); el.rel = 'noopener'; }
      else el.addEventListener('click', function () { location.href = link(sku, sub); });
    });
  }
  function verifyLicense(key, sku) {
    return fetch(HUB + '/api/license/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: String(key || '').trim(), sku: sku }) })
      .then(function (r) { return r.json(); });
  }
  window.SF365 = { hub: HUB, checkoutUrl: link, verifyLicense: verifyLicense, wire: wire };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { wire(); }); else wire();
})();
