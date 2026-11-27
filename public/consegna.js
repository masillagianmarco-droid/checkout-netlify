(function () {
  'use strict';
  var out = document.getElementById('out');
  var t = new URLSearchParams(location.search).get('t') || '';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) { out.innerHTML = '<p>Collegamento di consegna non valido.</p>'; return; }
  fetch('/api/delivery/' + encodeURIComponent(t)).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); }).then(function (o) {
    if (o.s !== 200) { out.innerHTML = '<p>Consegna non trovata. Scrivici dalla pagina contatti.</p>'; return; }
    var j = o.j, p = j.product || {}, h = '<p>Prodotto: <b>' + esc(p.name || p.sku) + '</b></p>';
    if (j.license) {
      h += '<p>La tua chiave di licenza:</p><div class="lic" id="lic">' + esc(j.license) + '</div>' +
        '<div class="toolbar"><button class="btn" id="copy" type="button">Copia la chiave</button>' +
        (p.return_url ? '<a class="btn accent" href="' + esc(p.return_url) + '">Apri il software</a>' : '') + '</div>' +
        '<p class="small">' + (j.license_expires_at ? 'Valida fino al ' + new Date(j.license_expires_at).toLocaleDateString('it-IT') + '.' : 'Valida finché l\'abbonamento resta attivo.') +
        ' Nel software apri la sezione Licenza e incolla la chiave.</p>';
    }
    if (j.download) h += '<p><a class="btn" href="' + esc(j.download) + '">Scarica il prodotto</a> <span class="small muted">(' + esc(j.downloads_left) + ' scaricamenti disponibili)</span></p>';
    out.innerHTML = h;
    var c = document.getElementById('copy');
    if (c) c.onclick = function () {
      (navigator.clipboard ? navigator.clipboard.writeText(j.license) : Promise.reject()).then(function () { c.textContent = 'Copiata'; })
        .catch(function () { var r = document.createRange(); r.selectNodeContents(document.getElementById('lic')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); c.textContent = 'Selezionata: copia con Ctrl+C'; });
    };
  }).catch(function () { out.innerHTML = '<p>Servizio momentaneamente non raggiungibile. Ricarica la pagina tra poco: la consegna è conservata.</p>'; });
})();
