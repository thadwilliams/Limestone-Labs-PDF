// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// Fills in this copy's name, domain and retention (from config.js) wherever a page marks a spot
// with data-app="name" / "domain" / "docDays" / "auditYears" / "organization", and shows or hides
// elements marked data-if="signing" / "tipJar", and puts the open-source credit in data-credit spots.
// Loaded right after config.js on every page.
const APP = globalThis.APP_CONFIG;
APP.domain = APP.domain || location.host;   // empty in config.js: wherever this copy is served from
APP.hasTips = !!(APP.tipJar && APP.tipJar.length);
APP.docSpan = APP.docDays + (APP.docDays === 1 ? ' day' : ' days');
APP.auditSpan = APP.auditYears + (APP.auditYears === 1 ? ' year' : ' years');
function applyBrand(root = document) {
  for (const el of root.querySelectorAll('[data-app]')) el.textContent = APP[el.dataset.app];
  for (const el of root.querySelectorAll('[data-if]')) {
    const on = el.dataset.if === 'tipJar' ? APP.hasTips : !!APP[el.dataset.if];
    if (!on) el.hidden = true;
  }
  for (const el of root.querySelectorAll('[data-credit]')) el.replaceChildren(...credit());
  document.title = document.title.replace(/LL PDF/g, APP.name);
}
// The credit Apache 2.0 copies of this project are asked to keep (see NOTICE and README).
// Deliberately not a config.js setting.
const SOURCE_URL = 'https://github.com/thadwilliams/LL_PDF';
function credit() {
  const a = document.createElement('a');
  a.href = SOURCE_URL; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'open source from Limestone Labs';
  return [document.createTextNode(APP.name === 'LL PDF' ? 'LL PDF is ' : 'Built on LL PDF, '), a];
}
// tip links as a list of anchors, with an optional separator and icons
function tipLinks(sep, icons) {
  const out = [];
  APP.tipJar.forEach((t, i) => {
    if (i && sep) out.push(document.createTextNode(sep));
    const a = document.createElement('a');
    a.href = t.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = (icons && t.icon ? t.icon + ' ' : '') + t.label;
    out.push(a);
  });
  return out;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => applyBrand());
else applyBrand();
