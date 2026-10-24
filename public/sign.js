// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// Signing requests.
//
// Editor side: add signers, place their fields, and send. The PDF and layout are encrypted
// in this browser (AES-GCM) before upload; the key only travels in links after '#', which
// browsers never send to servers.
//
// Link side (#s=... for a signer, #m=... for the sender): the same page renders the
// document read-only with the fields on top. When the last signature lands, whoever's
// browser is present builds the finished PDF, appends a Signature Certificate from the
// server's audit trail, and uploads it encrypted.

const SIGNER_COLORS = ['#2563eb', '#d9480f', '#2b8a3e', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5c7cfa'];
const FIELD_KINDS = {
  signature: {label: 'Signature', todo: 'Sign here', w: 170, h: 44},
  initials:  {label: 'Initials', todo: 'Initial', w: 64, h: 34},
  date:      {label: 'Date signed', todo: 'Date', w: 100, h: 18},       // stamps the day they tap it; not editable
  datepick:  {label: 'Date', todo: 'Pick a date', w: 100, h: 18},       // any date they choose, starting at today
  text:      {label: 'Text', todo: 'Type here', w: 170, h: 18},
  checkbox:  {label: 'Checkbox', todo: '', w: 14, h: 14},
  // these come from Make fillable fields sent for signing (forms.js), not from this panel's buttons
  multiline: {label: 'Multi-line', todo: 'Type here', w: 220, h: 60, fromForms: true},
  choice:    {label: 'Choice list', todo: 'Choose', w: 150, h: 20, fromForms: true},
  radio:     {label: 'Pick one', todo: '', w: 14, h: 14, fromForms: true},
};
const CONSENT_TEXT = 'I agree to use electronic records and signatures for this document. ' +
  'I understand that when I sign, the time, my IP address, my approximate location (from my IP address), ' +
  'and my browser and device type are recorded in an audit trail that is attached to the signed document. ' +
  `The document's files are deleted from the server ${APP.docSpan} after it was sent; the audit record is kept for ${APP.auditSpan} ` +
  'so the signed document can be verified.';
const ADOPT_TEXT = 'By clicking Sign, I adopt the signature and initials shown as my electronic signature, ' +
  'and agree that it is the legal equivalent of my handwritten signature on this document.';
const EVENT_LABELS = {
  created: 'Request created', sent: 'Sent for signing', opened: 'Opened (access code verified)',
  code_failed: 'Wrong access code entered', consented: 'Agreed to sign electronically', signed: 'Signed',
  all_signed: 'All signers finished', completed: 'Signed document finalized', voided: 'Request cancelled',
  files_deleted: 'Files deleted (retention)',
};

// ---------- crypto & api ----------
const b64u = buf => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hexOf = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async data => hexOf(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function encryptBytes(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, data));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function decryptBytes(key, data) {
  const u = new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: u.slice(0, 12)}, key, u.slice(12)));
}
const encJSON = (key, obj) => encryptBytes(key, new TextEncoder().encode(JSON.stringify(obj)));
const decJSON = async (key, data) => JSON.parse(new TextDecoder().decode(await decryptBytes(key, data)));

const SG = {auth: {}};   // the open signing request: id, key, meta, state, me, values
let ghost = null;        // field placement preview (editor)
async function apiCall(path, {method = 'GET', body, headers = {}, raw = false} = {}) {
  const h = {...SG.auth, ...headers};
  if (body && !(body instanceof Uint8Array)) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch('/api/' + path, {method, headers: h, body});
  if (!r.ok) {
    let msg = `Request failed (${r.status})`;
    try { msg = (await r.json()).error || msg; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return raw ? new Uint8Array(await r.arrayBuffer()) : r.json();
}

// ---------- small ui helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}
// Promise-based modal. Buttons resolve with their value; Esc resolves null unless locked.
function modal(title, body, buttons, {locked = false, wide = false} = {}) {
  return new Promise(resolve => {
    const d = h('dialog', {class: 'sg-dlg' + (wide ? ' wide' : '')}, h('h3', {}, title), body,
      h('div', {class: 'row'}, h('span', {style: 'flex:1'}), buttons.map(b => h('button', {class: b.primary ? 'primary' : '', id: b.id || null, onclick: async () => {
        if (b.check && !(await b.check())) return;
        d.close(); d.remove(); resolve(b.value);
      }}, b.label))));
    d.addEventListener('cancel', e => { if (locked) e.preventDefault(); else { d.remove(); resolve(null); } });
    document.body.appendChild(d); d.showModal();
  });
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); } catch { toast('Copy failed; select the text and copy it', true); }
}
const fmtUTC = iso => iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : '';
const fmtLocal = iso => iso ? new Date(iso).toLocaleString() : '';
function uaSummary(ua) {
  if (!ua) return 'unknown';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const v = (ua.match(b === 'Edge' ? /Edg\/(\d+)/ : b === 'Firefox' ? /Firefox\/(\d+)/ : b === 'Chrome' ? /Chrome\/(\d+)/ : b === 'Safari' ? /Version\/(\d+)/ : /x^/) || [])[1];
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${b}${v ? ' ' + v : ''} on ${os}`;
}
const place = e => [e.city, e.region, e.country].filter(Boolean).join(', ') || 'unknown';
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');

// ---------- editor: preparing a request ----------
function activeSigner() { return S.signers.find(s => s.key === S.activeSigner) || S.signers[0] || null; }
function addSigner() {
  const used = new Set(S.signers.map(s => s.color));
  const s = {key: 'sg' + uid(), name: '', code: randomCode(), color: SIGNER_COLORS.find(c => !used.has(c)) || SIGNER_COLORS[S.signers.length % SIGNER_COLORS.length]};
  S.signers.push(s); S.activeSigner = s.key;
  renderPrep(); scheduleSave();
  setTimeout(() => document.querySelector(`#signerList [data-key="${s.key}"] input.sg-name`)?.focus(), 0);
}
function fieldsBySigner() {
  const n = {};
  // signing fields, plus fillable fields assigned to a signer ("Filled by")
  for (const p of S.pages) for (const o of p.objs) if ((o.type === 'field' || o.type === 'ffield') && o.signer) n[o.signer] = (n[o.signer] || 0) + 1;
  return n;
}
// the sender's own name, shown to signers ("Thad Williams sent you ..."); remembered in this browser
const senderName = () => $('#senderName').value.trim();
$('#senderName').value = (() => { try { return localStorage.getItem('pdfedit.senderName') || ''; } catch { return ''; } })();
$('#senderName').oninput = e => { try { localStorage.setItem('pdfedit.senderName', e.target.value); } catch {} };
// access codes are optional, like DocuSign's default; the last choice is remembered
const requireCode = () => $('#requireCode').checked;
try { $('#requireCode').checked = localStorage.getItem('pdfedit.requireCode') === '1'; } catch {}
$('#requireCode').onchange = e => { try { localStorage.setItem('pdfedit.requireCode', e.target.checked ? '1' : '0'); } catch {} renderPrep(); };
function renderPrep() {
  const list = $('#signerList'); if (!list) return;
  hideGhost();   // redrawn on the next mouse move with the current signer's color and name
  if (!S.signers.find(s => s.key === S.activeSigner)) S.activeSigner = S.signers[0]?.key || null;
  const counts = fieldsBySigner();
  list.textContent = '';
  S.signers.forEach((s, i) => {
    const pick = () => { if (S.activeSigner !== s.key) { S.activeSigner = s.key; renderPrep(); } };
    const row = h('div', {class: 'sg-row' + (s.key === S.activeSigner ? ' active' : ''), 'data-key': s.key, style: `--rc:${s.color}`,
      title: 'Fields you place go to the highlighted signer', onclick: e => { if (!e.target.closest('input, button')) pick(); }},
      h('label', {class: 'chk', title: 'New fields go to this signer'},
        h('input', {type: 'radio', name: 'activeSigner', checked: s.key === S.activeSigner, onchange: pick}),
        h('span', {class: 'sg-dot', style: `background:${s.color}`})),
      h('div', {class: 'sg-fields'},
        h('input', {class: 'sg-name', placeholder: `Signer ${i + 1} name`, value: s.name, oninput: e => { s.name = e.target.value; redrawFields(); scheduleSave(); }}),
        h('div', {class: 'sg-sub'},
          requireCode() ? [h('span', {class: 'lbl'}, 'Code'),
            h('input', {class: 'sg-code', value: s.code, maxlength: 32, title: 'Access code this person types to open the document. Give it to them separately from the link. A new one is made after each send.', oninput: e => { s.code = e.target.value; scheduleSave(); }})] : null,
          h('span', {class: 'lbl'}, `${counts[s.key] || 0} field${counts[s.key] === 1 ? '' : 's'}`))),
      h('button', {class: 'sg-x', title: 'Remove this signer and their fields', onclick: () => removeSigner(s.key)}, '×'));
    list.appendChild(row);
  });
  // a fillable PDF made elsewhere: its fields can go to signers as they are (forms.js adoptField)
  const pf = $('#prepForm'); pf.textContent = '';
  const s = activeSigner(), who = s?.name || 'the picked signer';
  const native = S.fields.filter(fd => !fd.adopted && !fd.readOnly), blank = native.filter(isBlank);
  if (native.length) pf.append(h('div', {class: 'sg-formnote'},
    h('div', {}, h('strong', {}, `This PDF has ${native.length} fill-in field${native.length > 1 ? 's' : ''}.`),
      ` Click one on the page to give it to ${who}; they’ll have to fill it in.`),
    blank.length ? h('button', {onclick: adoptAllBlank, title: 'You can still click any of them afterwards to give it to someone else'},
      `Give all ${blank.length} blank field${blank.length > 1 ? 's' : ''} to ${who}`) : null));
  else if (formFields().length) pf.append(h('div', {class: 'lbl'}, `Fill-in fields show in their signer’s color. Click one to give it to ${who}.`));
  renderPrepKinds();
}
function renderPrepKinds() {
  const box = $('#fieldKinds'); if (!box) return;
  if (!box.children.length) for (const [k, f] of Object.entries(FIELD_KINDS)) {
    if (f.fromForms) continue;
    box.appendChild(h('button', {'data-kind': k, title: `Place a ${f.label.toLowerCase()} field for the selected signer`, onclick: () => {
      if (!S.signers.length) addSigner();
      S.fieldKind = k; setTool('field'); renderPrepKinds();
      if (isNarrow()) setPrepMini(true);   // phones: get the sheet out of the way so the page can be tapped
    }}, f.label));
  }
  box.querySelectorAll('button').forEach(b => b.classList.toggle('on', S.tool === 'field' && S.fieldKind === b.dataset.kind));
  if (S.tool !== 'field') hideGhost();
  const s = activeSigner();
  $('#prepTitle').textContent = S.tool === 'field' && isNarrow() && $('#prep').classList.contains('mini')
    ? `Tap the page: ${FIELD_KINDS[S.fieldKind].label} for ${s?.name || 'signer'}` : 'Get signatures';
}
const isNarrow = () => matchMedia('(max-width: 700px)').matches;
// phones: a side panel (Get signatures, Make fillable) shrinks to one line while you tap the page
function setPanelMini(panel, on) {
  panel.classList.toggle('mini', on);
  const b = panel.querySelector('.panel-mini');
  b.innerHTML = on ? '&#9652;' : '&#9662;';
  b.title = on ? 'Show the panel' : 'Shrink the panel so you can tap the page';
  renderPrepKinds();
  if (typeof renderFormKinds === 'function') renderFormKinds();
}
const setPrepMini = on => setPanelMini($('#prep'), on);
function removeSigner(key) {
  const s = S.signers.find(x => x.key === key);
  const n = fieldsBySigner()[key] || 0;
  if (n && !confirm(`Remove ${s.name || 'this signer'} and their ${n} field${n > 1 ? 's' : ''}?`)) return;
  pushUndo();
  S.signers = S.signers.filter(x => x.key !== key);
  for (const p of S.pages) p.objs = p.objs.filter(o => !(o.type === 'field' && o.signer === key));
  S.sel = null; renderPages(); renderPrep();
}
function redrawFields() { S.pages.forEach(p => { if (p.objs.some(o => o.type === 'field')) drawOverlay(p); }); }
// The click point is the middle of the field's left edge, like starting a signature line.
function anchorBox(w, h, u, v, R) {
  const [dx, dy] = rotVec(0, -h / 2, R);
  return {x: u + dx, y: v + dy, w, h, rot: R};
}
function fieldBox(kind, u, v, R) { const k = FIELD_KINDS[kind]; return anchorBox(k.w, k.h, u, v, R); }
function placeField(p, u, v, R) {
  const s = activeSigner(); if (!s) { addSigner(); return placeField(p, u, v, R); }
  const kind = S.fieldKind || 'signature';
  const o = {id: uid(), type: 'field', kind, signer: s.key, ...fieldBox(kind, u, v, R)};
  pushUndo(); p.objs.push(o); select(p, o); renderPrep();
}
// a faint preview of the field under the cursor, so it lands where you expect
function hideGhost() { ghost?.remove(); ghost = null; }
// what's being placed: a signing field (this file) or a fillable form field (forms.js)
function placementSpec() {
  if (S.tool === 'field') {
    const kind = S.fieldKind || 'signature', k = FIELD_KINDS[kind], s = activeSigner();
    return {w: k.w, h: k.h, cls: 'sfield', color: s?.color || '#888', label: kind === 'checkbox' ? '' : `${k.label}: ${s?.name || 'unnamed'}`};
  }
  if (S.tool === 'formfield' && typeof formPlacementSpec === 'function') return formPlacementSpec();
  return null;
}
$('#pages').addEventListener('pointermove', e => {
  const pageEl = e.target.closest('.page'), spec = S.mode === 'edit' ? placementSpec() : null;
  if (!spec || !pageEl || e.target.closest('[data-oid], .fld')) return hideGhost();
  const p = pageById(+pageEl.dataset.pid), d = p && DOM.get(p.id); if (!d) return hideGhost();
  const [u, v] = toUV(p, e.clientX, e.clientY), b = anchorBox(spec.w, spec.h, u, v, dims(p).R);
  const key = spec.cls + spec.label + spec.color;
  if (!ghost || ghost.parentNode !== d.ov || ghost.dataset.key !== key) {
    hideGhost();
    ghost = h('div', {class: `obj ${spec.cls} ghost`, style: `--fc:${spec.color}`, 'data-key': key});
    if (spec.label) ghost.appendChild(h('span', {class: 'sf-label'}, spec.label));
    d.ov.appendChild(ghost);
  }
  Object.assign(ghost.style, {left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px', fontSize: Math.max(5, Math.min(9, b.h * 0.5)) + 'px', transform: b.rot ? `rotate(${-b.rot}deg)` : ''});
});
$('#pages').addEventListener('pointerleave', hideGhost);
function togglePrep(open) {
  const el = $('#prep'); open = open ?? el.hidden;
  el.hidden = !open; $('#bSignReq').classList.toggle('on', open);
  if (open && typeof toggleFormPrep === 'function' && !$('#formPrep').hidden) toggleFormPrep(false);   // one panel at a time
  if (open && !S.signers.length) addSigner();
  if (open) renderPrep(); else { if (S.tool === 'field') setTool('select'); setPrepMini(false); }
  let seen = false;
  try { seen = localStorage.getItem('pdfedit.esignInfoSeen') === '1'; } catch {}
  if (open && !seen) showEsignInfo(true);
}
// The full disclosure: what's collected, what's done with it, what it shows and doesn't, and what that means.
async function showEsignInfo(firstTime) {
  const dont = h('input', {type: 'checkbox'});
  const body = h('div', {},
    h('p', {}, 'Before you send anything for signing, here is exactly what this records about you and your signers, and how much weight that record can carry.'),
    renderEsignInfo(h('div', {class: 'esign-info'})),
    firstTime ? h('label', {class: 'chk', style: 'margin-top:10px'}, dont, "Don't show this again (it's always under “What we record and what it means”)") : null,
    h('p', {class: 'lbl', style: 'margin-top:8px'}, h('a', {href: '/esign', target: '_blank', rel: 'noopener'}, 'Open this as a page'), ' to read later or share with signers.'));
  await modal('E-signing: what it records and what it means', body, [{label: 'Got it', value: true, primary: true}], {wide: true});
  if (dont.checked) { try { localStorage.setItem('pdfedit.esignInfoSeen', '1'); } catch {} }
}

// One builder for a field box in every mode: editor layout, signer, and sender status view.
function buildSignField(o, p, isSel) {
  const el = h('div', {class: 'obj sfield' + (isSel ? ' sel' : ''), 'data-oid': o.id});
  el.style.left = o.x + 'px'; el.style.top = o.y + 'px'; el.style.width = o.w + 'px'; el.style.height = o.h + 'px';
  if (o.rot) el.style.transform = `rotate(${-o.rot}deg)`;
  const k = FIELD_KINDS[o.kind];
  const labelSize = Math.max(5, Math.min(9, o.h * 0.5)) + 'px';
  if (S.mode === 'edit') {
    const s = S.signers.find(x => x.key === o.signer);
    el.style.setProperty('--fc', s?.color || '#888');
    el.style.fontSize = labelSize;
    if (o.kind !== 'checkbox') el.appendChild(h('span', {class: 'sf-label'}, `${k.label}: ${s?.name || 'unnamed'}`));
    el.title = `${k.label} for ${s?.name || 'unnamed signer'}`;
    if (isSel) el.appendChild(h('div', {class: 'handle'}));
    return el;
  }
  const signer = SG.meta.signers[o.signerIdx], mine = isMine(o);
  el.style.setProperty('--fc', signer.color);
  el.classList.toggle('mine', mine); el.classList.toggle('other', !mine);
  // fields from Make fillable carry a name; it's the placeholder and the hover hint
  if (mine && o.name) el.title = o.name + (required(o) ? '' : ' (optional)');
  const typed = e => { o.value = e.target.value.trim() ? {text: e.target.value} : null; el.classList.toggle('todo', !done(o)); renderSignBar(); };
  if (mine && (o.kind === 'text' || o.kind === 'multiline')) {
    el.appendChild(h(o.kind === 'text' ? 'input' : 'textarea', {class: 'sf-input', value: o.kind === 'text' ? o.value?.text || '' : null, placeholder: o.name || k.todo,
      style: `font-size:${o.kind === 'text' ? textSize(o) : 10}px`, oninput: typed}));
    if (o.kind === 'multiline') el.lastChild.value = o.value?.text || '';
    el.classList.toggle('todo', !done(o));
    return el;
  }
  if (mine && o.kind === 'choice') {
    el.appendChild(h('select', {class: 'sf-input', style: `font-size:${textSize(o)}px`, onchange: typed},
      h('option', {value: ''}, o.name || k.todo), (o.options || []).filter(x => x.trim()).map(x => h('option', {value: x, selected: o.value?.text === x}, x))));
    el.classList.toggle('todo', !done(o));
    return el;
  }
  if (mine && o.kind === 'radio') {
    // one question: choosing a button clears the others in its group
    el.appendChild(h('input', {type: 'radio', class: 'sf-check', name: 'rg-' + o.group, checked: !!o.value?.checked, title: o.option, onchange: () => {
      for (const {o: x} of myFields()) if (x.kind === 'radio' && x.group === o.group) x.value = {checked: x === o};
      S.pages.forEach(drawOverlay); renderSignBar();
    }}));
    el.classList.toggle('todo', !done(o));
    el.title = `${o.group}: ${o.option}`;
    return el;
  }
  if (mine && o.kind === 'datepick') {
    el.appendChild(h('input', {type: 'date', class: 'sf-input', value: o.value?.iso || '', style: `font-size:${textSize(o)}px`, title: 'Pick a date',
      onchange: e => { o.value = e.target.value ? dateValue(e.target.value) : null; renderSignBar(); }}));
    el.classList.toggle('todo', !o.value);
    return el;
  }
  if (mine && o.kind === 'checkbox') {
    el.appendChild(h('input', {type: 'checkbox', class: 'sf-check', checked: !!o.value?.checked, onchange: e => { o.value = {checked: e.target.checked}; el.classList.toggle('todo', !done(o)); renderSignBar(); }}));
    el.classList.toggle('todo', !done(o));
    return el;
  }
  if (o.value?.img) el.appendChild(h('img', {src: o.value.img, alt: ''}));
  else if (o.value?.text) el.appendChild(h('span', {class: 'sf-text' + (o.kind === 'multiline' ? ' multi' : ''), style: `font-size:${o.kind === 'multiline' ? 10 : textSize(o)}px`}, o.value.text));
  else if (o.value?.checked) el.appendChild(h('span', {class: 'sf-text', style: `font-size:${o.h * 0.9}px`}, '✔'));
  else {
    el.style.fontSize = labelSize;
    const label = mine ? k.todo : (o.kind === 'checkbox' ? '' : `${signer.name}: ${k.label}`);
    if (label) el.appendChild(h('span', {class: 'sf-label'}, label));
    if (mine) el.classList.add('todo');
  }
  if (mine) el.title = o.value ? 'Click to change' : `Click to ${o.kind === 'date' ? 'add the date' : k.todo.toLowerCase()}`;
  return el;
}
const textSize = o => Math.max(6, Math.min(14, o.h * 0.7));
// a picked date as stored: the ISO day for the picker, and the text written on the PDF
const dateValue = iso => { const [y, m, d] = iso.split('-').map(Number); return {iso, text: DATE_FORMATS[dateFmt](new Date(y, m - 1, d))}; };
const isMine = o => S.mode === 'sign' && o.signerIdx === SG.me && myStatus() === 'pending' && SG.state.status === 'out';

// ---------- editor: sending ----------
const docTitle = () => (S.sources[S.pages[0]?.src]?.name || 'document').replace(/\.pdf$/i, '');
function savedRequests() { try { return JSON.parse(localStorage.getItem('pdfedit.sent')) || []; } catch { return []; } }
function saveRequests(list) { try { localStorage.setItem('pdfedit.sent', JSON.stringify(list)); } catch {} }

async function sendForSigning() {
  if (location.protocol === 'file:') return toast('Sending for signing needs the online version: ' + APP.domain, true);
  finishEditing();
  const signers = S.signers;
  if (!signers.length) return toast('Add at least one signer', true);
  for (const [i, s] of signers.entries()) if (!s.name.trim()) return toast(`Signer ${i + 1} needs a name`, true);
  // fillable fields (Make fillable) go along too; any without a "Filled by" signer get one now.
  // A Pick one question is one field: buttons follow whoever already fills the rest of it.
  for (const o of formFields()) if (o.kind === 'radio' && !signers.some(s => s.key === o.signer)) {
    const owner = formFields().find(x => x.kind === 'radio' && x.group === o.group && signers.some(s => s.key === x.signer));
    if (owner) o.signer = owner.signer;
  }
  const loose = formFields().filter(o => !signers.some(s => s.key === o.signer));
  if (loose.length) {
    let key = signers[0].key;
    if (signers.length > 1) {
      const sel = h('select', {class: 'sg-assign'}, signers.map(s => h('option', {value: s.key}, s.name)));
      const ok = await modal('Who fills these in?', h('div', {},
        h('p', {}, `${loose.length} fillable field${loose.length > 1 ? 's don’t' : ' doesn’t'} have a signer yet. Who fills ${loose.length > 1 ? 'them' : 'it'} in?`), sel,
        h('p', {class: 'lbl', style: 'margin-top:8px'}, 'To split them between people, cancel and set “Filled by” on each field in Make fillable.')),
        [{label: 'Cancel', value: false}, {label: 'Use this signer', value: true, primary: true}]);
      if (!ok) return;
      key = sel.value;
    }
    pushUndo();
    for (const o of loose) o.signer = key;
  }
  const counts = fieldsBySigner();
  for (const s of signers) {
    if (requireCode() && s.code.trim().length < 4) return toast(`${s.name}'s access code must be at least 4 characters`, true);
    if (!counts[s.key]) return toast(`${s.name} has no fields yet. Pick them, then place a field.`, true);
  }
  if (!senderName()) { $('#senderName').focus(); return toast('Add your name so signers know who sent it', true); }
  const fields = [];
  S.pages.forEach((p, i) => p.objs.forEach(o => {
    const at = {page: i, signer: signers.findIndex(s => s.key === o.signer), u: o.x, v: o.y, w: o.w, h: o.h, rot: o.rot || 0};
    if (o.type === 'field') fields.push({...at, kind: o.kind});
    else if (o.type === 'ffield') fields.push({...at, kind: FORM_TO_SIGN[o.kind], name: o.name, options: o.options, group: o.group, option: o.option, required: o.required !== false, prefill: o.prefill});
  }));
  const ok = await modal('Send for signing?', h('div', {},
    h('p', {}, `${signers.length} signer${signers.length > 1 ? 's' : ''}, ${fields.length} field${fields.length > 1 ? 's' : ''}. Your other edits are locked into the document, and form fields are flattened.`),
    h('p', {class: 'lbl'}, `The document is encrypted in this browser before it is uploaded. Files are deleted after ${APP.docSpan}, so download the signed copy when it is done.`)),
    [{label: 'Cancel', value: false}, {label: 'Encrypt and send', value: true, primary: true}]);
  if (!ok) return;
  busy('Encrypting and sending...');
  try {
    const pdfBytes = await buildPdf({flatten: true, formFields: false});   // fields are layout only; signers fill them on the signing page
    const docHash = await sha256hex(pdfBytes);
    const rawKey = crypto.getRandomValues(new Uint8Array(32)), key = await aesKey(rawKey);
    const meta = {v: 1, title: docTitle(), sender: senderName(), signers: signers.map(s => ({name: s.name.trim(), color: s.color})), fields, sentAt: new Date().toISOString()};
    const codes = requireCode();
    const created = await apiCall('envelopes', {method: 'POST', body: {docHash, docBytes: pdfBytes.length, signers: signers.map(s => ({code: codes ? s.code.trim() : null}))}});
    const auth = {'x-sender-secret': created.senderSecret};
    await apiCall(`envelopes/${created.id}/blob/doc`, {method: 'PUT', body: await encryptBytes(key, pdfBytes), headers: auth});
    await apiCall(`envelopes/${created.id}/blob/meta`, {method: 'PUT', body: await encJSON(key, meta), headers: auth});
    await apiCall(`envelopes/${created.id}/send`, {method: 'POST', headers: auth});
    const k = b64u(rawKey), origin = location.origin;
    const rec = {id: created.id, title: meta.title, sender: meta.sender, sentAt: meta.sentAt, manage: `${origin}/#m=${created.id}.${created.senderSecret}.${k}`,
      signers: signers.map((s, i) => ({name: s.name.trim(), code: codes ? s.code.trim() : null, needsCode: codes, link: `${origin}/#s=${created.id}.${created.signers[i].id}.${k}`}))};
    saveRequests([rec, ...savedRequests()]);
    // every send gets fresh codes, so a code from an earlier request never opens a later one
    for (const s of S.signers) s.code = randomCode();
    renderPrep(); scheduleSave();
    busy();
    await afterSend(rec);
  } catch (e) {
    console.error(e); busy();
    toast('Sending failed: ' + e.message, true);
  }
}
// ---------- getting links to people ----------
// Plain mailto: links often do nothing on desktops, so every message can also be copied,
// opened as a Gmail or Outlook.com draft, or (on phones) handed to the share sheet.
const fmtDay = iso => new Date(iso).toLocaleDateString(undefined, {month: 'long', day: 'numeric', year: 'numeric'});
const expiryOf = sentAt => new Date(Date.parse(sentAt) + 30 * 864e5).toISOString();
const isPhone = () => !!navigator.share && matchMedia('(pointer: coarse)').matches;
function sendButtons({subject, body, what}) {
  const e = encodeURIComponent, link = (label, href, title) => h('a', {class: 'btnlink', href, target: '_blank', rel: 'noopener', title}, label);
  return h('div', {class: 'sg-share'},
    isPhone() ? h('button', {class: 'primary', onclick: () => navigator.share({title: subject, text: body}).catch(() => {})}, 'Share…') : null,
    h('button', {title: 'Copy a ready-to-send message, then paste it into any email or text', onclick: () => copyText(body, what)}, 'Copy message'),
    link('Gmail', `https://mail.google.com/mail/?view=cm&fs=1&su=${e(subject)}&body=${e(body)}`, 'Open a Gmail draft in a new tab'),
    link('Outlook.com', `https://outlook.live.com/mail/0/deeplink/compose?subject=${e(subject)}&body=${e(body)}`, 'Open an Outlook.com draft in a new tab'),
    h('a', {class: 'btnlink', href: `mailto:?subject=${e(subject)}&body=${e(body)}`, title: 'Your computer’s email program, if one is set up'}, 'Email app'));
}
function signerMessage(rec, s) {
  return {what: `${s.name}'s message`, subject: `Please sign: ${rec.title}`,
    body: `Hi ${s.name},\n\n${rec.sender || 'I'} sent you "${rec.title}" to sign electronically.\n\nOpen this link to review and sign:\n${s.link}\n\n` +
      (s.code ? `You'll also need an access code, which I'm sending you separately.\n\n` : '') +
      `Keep this message: when everyone has signed, the same link is where you download the signed copy${s.code ? ' (you\'ll need the code again)' : ''}. The link works until ${fmtDay(expiryOf(rec.sentAt))}.`};
}
function codeButtons(rec, s) {
  const text = `Your access code for "${rec.title}": ${s.code}`;
  return h('div', {class: 'sg-share'},
    isPhone() ? h('button', {onclick: () => navigator.share({text}).catch(() => {})}, 'Text it…') : null,
    h('button', {onclick: () => copyText(s.code, `${s.name}'s code`)}, 'Copy code'));
}
function statusMessage(rec) {
  return {what: 'your status message', subject: `Signing status page: ${rec.title}`,
    body: `Your private status page for "${rec.title}", sent ${fmtDay(rec.sentAt)}:\n${rec.manage}\n\n` +
      `The signed PDF appears there when everyone has signed. Files are deleted on ${fmtDay(expiryOf(rec.sentAt))}, so download it before then. ` +
      `Don't share this link: it can cancel the request.\n\nSigners:\n` + rec.signers.map(s => `${s.name}\n  link: ${s.link}` + (s.needsCode === false ? '' : `\n  access code: ${s.code || '(saved in the browser you sent from)'}`)).join('\n')};
}

function showRequest(rec, justSent) {
  const body = h('div', {class: 'sg-sent'},
    h('p', {}, (justSent ? 'Sent. ' : `Sent ${fmtLocal(rec.sentAt)}. `) + (rec.signers.some(s => s.needsCode !== false)
      ? 'Send each person their link, and give them their access code separately (for example, link by email and code by text). Anyone with both can sign as that person.'
      : 'Send each person their link. No access code was required, so anyone who has a link can sign as that person: send it only to them.')),
    rec.signers.map(s => h('div', {class: 'sg-sent-row'},
      h('strong', {}, s.name),
      h('div', {class: 'sg-copy'}, h('input', {readonly: true, value: s.link, onclick: e => e.target.select()}), h('button', {onclick: () => copyText(s.link, `${s.name}'s link`)}, 'Copy link')),
      sendButtons(signerMessage(rec, s)),
      s.code ? h('div', {class: 'sg-copy'}, h('span', {class: 'lbl'}, 'Access code'), h('code', {}, s.code), codeButtons(rec, s))
        : s.needsCode === false ? null
        : h('div', {class: 'lbl'}, 'The access code is only saved in the browser this was sent from (and in your status email, if you sent yourself one).'))),
    h('div', {class: 'sg-sent-row sg-mine'},
      h('strong', {}, 'Your status page'),
      h('div', {class: 'lbl'}, 'Watch progress and download the signed PDF here. Email it to yourself so you can always find it; it also lists every link and code.'),
      h('div', {class: 'sg-copy'}, h('input', {readonly: true, value: rec.manage, onclick: e => e.target.select()}), h('button', {onclick: () => copyText(rec.manage, 'status link')}, 'Copy')),
      sendButtons(statusMessage(rec))),
    justSent ? h('div', {class: 'sg-next'}, h('strong', {}, 'What about the document still open here?'),
      h('p', {}, 'It’s your working copy. The signing copy was locked when you sent it, so changes here don’t affect it. The signed PDF will be on your status page when everyone has signed.')) : null);
  return modal(rec.title, body, justSent
    ? [{label: 'Keep editing', value: 'keep'}, {label: 'Close this document', value: 'close'}, {label: 'Open status page', value: 'status', primary: true}]
    : [{label: 'Done', value: true, primary: true}], {wide: true});
}
async function afterSend(rec) {
  const choice = await showRequest(rec, true);
  if (choice === 'status') { window.open(rec.manage, '_blank', 'noopener'); return; }
  if (choice === 'close') {
    finishEditing(); togglePrep(false); resetDoc(); document.title = APP.name; renderPages(); await persistState();
    try { localStorage.removeItem('pdfedit.pending'); } catch {}
    toast('Closed. Your request is under Get signatures → Your signing requests.');
  }
}
function showRequestList() {
  const list = savedRequests();
  const body = h('div', {class: 'sg-sent'}, list.length ? list.map(r => h('div', {class: 'sg-sent-row sg-list-row'},
    h('div', {}, h('strong', {}, r.title), h('div', {class: 'lbl'}, `${fmtLocal(r.sentAt)} · ${r.signers.map(s => s.name).join(', ')}`)),
    h('div', {class: 'sg-copy'},
      h('a', {href: r.manage, target: '_blank', rel: 'noopener'}, 'Status'),
      h('button', {onclick: () => showRequest(r, false)}, 'Links & codes'),
      h('button', {title: 'Forget this request in this browser (does not cancel it)', onclick: e => { saveRequests(savedRequests().filter(x => x.id !== r.id)); e.target.closest('.sg-list-row').remove(); }}, 'Remove')))) :
    h('p', {}, 'Nothing sent from this browser yet.'));
  return modal('Your signing requests', body, [{label: 'Close', value: true, primary: true}], {wide: true});
}

// ---------- link views ----------
const myStatus = () => SG.state?.signers.find(s => s.idx === SG.me)?.status;
function startFromLink() {
  const m = /^#([sm])=([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(location.hash);
  if (!m) return false;
  S.mode = m[1] === 's' ? 'sign' : 'manage';
  document.body.classList.add('signing');
  $('#empty').hidden = true;
  openRequest(m[2], m[3], m[4]).catch(e => { console.error(e); busy(); showFatal(e.message); });
  return true;
}
function showFatal(msg) {
  const em = $('#empty'); em.hidden = false; em.textContent = '';
  em.append(h('div', {class: 'big'}, 'This signing link can’t be opened'), h('div', {}, msg), h('a', {href: '/', class: 'lbl'}, 'Go to the PDF editor'));
}
async function openRequest(eid, cred, k) {
  SG.id = eid;
  SG.key = await aesKey(unb64u(k));
  if (S.mode === 'manage') SG.auth = {'x-sender-secret': cred};
  else {
    const t = await unlockPrompt(eid, cred);
    SG.auth = {authorization: 'Bearer ' + t.token}; SG.me = t.idx;
  }
  busy('Opening document...');
  const [state, metaC, docC] = await Promise.all([apiCall(`envelopes/${eid}/state`), apiCall(`envelopes/${eid}/blob/meta`, {raw: true}), apiCall(`envelopes/${eid}/blob/doc`, {raw: true})]);
  SG.state = state;
  SG.meta = await decJSON(SG.key, metaC);
  SG.doc = await decryptBytes(SG.key, docC);
  SG.docHash = await sha256hex(SG.doc);
  await workerReady;
  const name = SG.meta.title + '.pdf';
  S.sources = [{name, bytes: SG.doc, js: await loadPdfjs(SG.doc, name), pages: new Map(), text: new Map()}];
  S.pages = [];
  for (let i = 0; i < S.sources[0].js.numPages; i++) {
    const pg = await getPage(0, i);
    S.pages.push({id: uid(), src: 0, idx: i, baseRot: pg.rotate, rot: 0, view: pg.view.slice(), objs: []});
  }
  SG.meta.fields.forEach((f, fi) => S.pages[f.page]?.objs.push({id: uid(), type: 'field', fi, kind: f.kind, signerIdx: f.signer, x: f.u, y: f.v, w: f.w, h: f.h, rot: f.rot, value: null,
    name: f.name, options: f.options, group: f.group, option: f.option, required: f.required, prefill: f.prefill}));
  await loadValues();
  document.title = `${S.mode === 'sign' ? 'Sign' : 'Status'}: ${SG.meta.title}`;
  // "Date" fields start at today; the signer can change them
  for (const p of S.pages) for (const o of p.objs) if (o.type === 'field' && o.kind === 'datepick' && !o.value && isMine(o)) o.value = dateValue(DATE_FORMATS.iso(new Date()));
  // answers the sender's PDF already had show up filled in; the signer can change them
  // (a "Date signed" field always gets the day they sign, so it ignores an old value)
  for (const p of S.pages) for (const o of p.objs) if (o.type === 'field' && !o.value && o.prefill != null && o.prefill !== false && o.kind !== 'date' && isMine(o)) {
    if (typeof o.prefill !== 'string') { o.value = {checked: true}; continue; }
    const d = o.kind === 'datepick' ? new Date(o.prefill) : null;
    o.value = d && !isNaN(d) ? dateValue(DATE_FORMATS.iso(d)) : {text: o.prefill};
  }
  renderPages(); fitIfTooWide(); renderSignBar(); busy();
  if (S.mode === 'sign' && myStatus() === 'pending' && state.status === 'out') await consentPrompt();
  if (S.mode === 'manage') addEventListener('focus', refreshState);
}
async function unlockPrompt(eid, sid) {
  // link-only requests open straight away; otherwise the server says a code is needed (not counted as a try)
  const first = await apiCall(`envelopes/${eid}/signers/${sid}/unlock`, {method: 'POST', body: {code: null}});
  SG.needsCode = !first.token;
  if (first.token) return first;
  return new Promise(resolve => {
    const err = h('div', {class: 'sg-err'});
    const input = h('input', {class: 'sg-codein', autocomplete: 'one-time-code', inputmode: 'text', placeholder: 'Access code'});
    const go = async () => {
      err.textContent = '';
      try { const t = await apiCall(`envelopes/${eid}/signers/${sid}/unlock`, {method: 'POST', body: {code: input.value}}); d.close(); d.remove(); resolve(t); }
      catch (e) { err.textContent = e.message; if (e.status === 410 || e.status === 404 || e.status === 423) { d.close(); d.remove(); showFatal(e.message); } }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const d = h('dialog', {class: 'sg-dlg'}, h('h3', {}, 'You have a document to sign'),
      h('p', {}, 'Enter the access code the sender gave you. It was sent separately from this link.'), input, err,
      h('div', {class: 'row'}, h('span', {style: 'flex:1'}), h('button', {class: 'primary', onclick: go}, 'Open document')));
    d.addEventListener('cancel', e => e.preventDefault());
    document.body.appendChild(d); d.showModal(); input.focus();
  });
}
async function consentPrompt() {
  const cb = h('input', {type: 'checkbox', id: 'sgConsent'});
  const me = SG.meta.signers[SG.me].name, others = SG.meta.signers.filter((_, i) => i !== SG.me).map(s => s.name);
  const ok = await modal(`${me}, please review and sign`, h('div', {},
    h('p', {}, `${SG.meta.sender || 'Someone'} sent you "${SG.meta.title}" to sign.` + (others.length ? ` Also signing: ${others.join(', ')}.` : '')),
    h('p', {class: 'lbl'}, `Not ${me}? Close this page and let the sender know. This link${SG.needsCode ? ' and code are' : ' is'} only for ${me}.`),
    h('p', {class: 'sg-consent'}, CONSENT_TEXT),
    h('details', {}, h('summary', {}, 'What is recorded, what it shows, and what it does not prove'), renderEsignInfo(h('div', {class: 'esign-info'}))),
    h('label', {class: 'chk'}, cb, 'I agree to sign electronically')),
    [{label: 'Not now', value: false}, {label: 'Continue', value: true, primary: true, check: () => cb.checked || (toast('Check the box to agree first'), false)}], {locked: true});
  if (!ok) { showFatal('You chose not to sign. Reopen the link when you are ready.'); S.pages = []; renderPages(); $('#signbar').textContent = ''; return; }
  await apiCall(`envelopes/${SG.id}/consent`, {method: 'POST', body: {consentHash: await sha256hex(CONSENT_TEXT), docHash: SG.docHash}});
  setTimeout(nextField, 300);
}
async function loadValues() {
  for (const s of SG.state.signers) {
    if (s.status !== 'signed') continue;
    const sub = await decJSON(SG.key, await apiCall(`envelopes/${SG.id}/submissions/${s.idx}`, {raw: true}));
    for (const p of S.pages) for (const o of p.objs) if (o.type === 'field' && sub.values[o.fi]) o.value = sub.values[o.fi];
  }
}
async function refreshState() {
  if (!SG.id) return;
  try {
    SG.state = await apiCall(`envelopes/${SG.id}/state`);
    await loadValues(); S.pages.forEach(drawOverlay); renderSignBar();
  } catch (e) { console.warn(e); }
}

function myFields() { return S.pages.flatMap(p => p.objs.filter(o => o.type === 'field' && isMine(o)).map(o => ({p, o}))); }
// required: signing-panel fields are, except checkboxes; Make fillable fields carry their own setting
const required = o => o.required ?? o.kind !== 'checkbox';
// filled: a Pick one question counts once any of its buttons is chosen; a checkbox must be ticked
const filled = o => o.kind === 'radio' ? myFields().some(({o: x}) => x.kind === 'radio' && x.group === o.group && x.value?.checked)
  : o.kind === 'checkbox' ? !!o.value?.checked : !!o.value;
const done = o => !required(o) || filled(o);
function nextField() {
  const todo = myFields().find(({o}) => !done(o)) || myFields()[0];
  if (!todo) return;
  const el = DOM.get(todo.p.id)?.ov.querySelector(`[data-oid="${todo.o.id}"]`);
  el?.scrollIntoView({block: 'center', behavior: 'smooth'});
  el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1200);
}
function renderSignBar() {
  const bar = $('#signbar'); bar.textContent = '';
  const st = SG.state, names = SG.meta.signers;
  bar.append(h('div', {class: 'sg-title'}, h('strong', {}, SG.meta.title),
    h('span', {class: 'lbl'}, S.mode === 'sign' ? ` · signing as ${names[SG.me]?.name}` : ' · your status page')));
  const chips = h('div', {class: 'sg-chips'}, st.signers.map(s => h('span', {class: 'sg-chip ' + s.status, title: s.signedAt ? `Signed ${fmtLocal(s.signedAt)}` : s.openedAt ? `Opened ${fmtLocal(s.openedAt)}, not signed yet` : 'Not opened yet'},
    h('span', {class: 'sg-dot', style: `background:${names[s.idx]?.color}`}), `${names[s.idx]?.name}: ${s.status === 'signed' ? 'signed' : s.openedAt ? 'opened' : 'waiting'}`)));
  bar.append(chips);
  const acts = h('div', {class: 'sg-acts'});
  if (st.docsDeleted) acts.append(h('span', {class: 'lbl'}, 'Files deleted after ' + APP.docSpan));
  else if (st.status === 'voided') acts.append(h('span', {class: 'lbl'}, 'This request was cancelled'));
  else if (st.status === 'complete') acts.append(h('span', {class: 'lbl'}, `Everyone signed. Keep a copy: files are deleted ${fmtDay(st.docsExpireAt)}.`),
    h('button', {class: 'primary', onclick: downloadFinal}, 'Download signed PDF'));
  else if (st.status === 'signed') acts.append(h('button', {class: 'primary', onclick: () => finalizeDoc().catch(e => toast(e.message, true))}, 'Finish document'));
  if (S.mode === 'sign' && myStatus() === 'pending' && st.status === 'out') {
    const mine = myFields(), doneN = mine.filter(({o}) => done(o)).length;
    acts.append(h('span', {class: 'lbl'}, `${doneN} of ${mine.length} done`),
      h('button', {onclick: nextField}, 'Next field'),
      h('button', {class: 'primary', onclick: finishSigning}, 'Finish signing'));
  } else if (S.mode === 'sign' && myStatus() === 'signed' && st.status === 'out') {
    const waiting = st.signers.filter(s => s.status !== 'signed').map(s => names[s.idx].name);
    acts.append(h('span', {class: 'lbl'}, `You signed. Waiting for ${waiting.join(', ')}; the signed PDF will be here.`),
      h('button', {class: 'primary', onclick: afterSignInfo}, 'Save this link'));
  }
  if (S.mode === 'manage') {
    acts.append(h('button', {onclick: refreshState, title: 'Check for new signatures'}, 'Refresh'));
    if (st.status === 'out' || st.status === 'signed') acts.append(h('button', {onclick: shareLinks}, 'Links'), h('button', {onclick: voidRequest, title: 'Cancel this request and delete its files'}, 'Cancel request'));
  }
  bar.append(acts);
}
// the status page rebuilds links from the server; codes exist only in the sending browser
async function shareLinks() {
  const k = location.hash.split('.').pop(), saved = savedRequests().find(r => r.id === SG.id);
  const rec = {title: SG.meta.title, sender: SG.meta.sender, sentAt: SG.meta.sentAt, manage: location.href,
    signers: SG.state.signers.map(s => ({name: SG.meta.signers[s.idx].name + (s.status === 'signed' ? ' (signed)' : ''),
      link: `${location.origin}/#s=${SG.id}.${s.id}.${k}`, code: saved?.signers[s.idx]?.code, needsCode: s.needsCode !== false}))};
  await showRequest(rec, false);
}
async function voidRequest() {
  const ok = await modal('Cancel this request?', h('p', {}, 'Signers will no longer be able to open it, and its files are deleted now. The audit record is kept.'),
    [{label: 'Keep it', value: false}, {label: 'Cancel request', value: true, primary: true}]);
  if (!ok) return;
  try { await apiCall(`envelopes/${SG.id}/void`, {method: 'POST'}); await refreshState(); toast('Request cancelled'); }
  catch (e) { toast(e.message, true); }
}

// signer clicks on their own fields
function signPointer(e) {
  if (e.target.closest('input')) return;
  const pageEl = e.target.closest('.page'), oel = e.target.closest('[data-oid]');
  if (!pageEl || !oel) return;
  const p = pageById(+pageEl.dataset.pid), o = p?.objs.find(x => x.id === +oel.dataset.oid);
  if (!o || !isMine(o)) return;
  e.preventDefault();
  if (o.kind === 'date') { o.value = {text: todayStr()}; return afterFill(p); }
  if (o.kind === 'signature' || o.kind === 'initials') {
    // Always drawn fresh on a signing link: a signature remembered in this browser may belong to
    // someone else (a shared computer, or one person testing several links), so it is never reused
    // here and never saved from here.
    openPad(o.kind === 'signature' ? `${SG.meta.signers[SG.me].name}: draw your signature` : `${SG.meta.signers[SG.me].name}: draw your initials`, url => {
      // this drawing fills this field and the signer's other empty fields of the same kind
      o.value = {img: url};
      fillInk(o, url);
      afterFill(p);
    }, null, {remember: false});
  }
}
function fillInk(o, url) { o.value = {img: url}; for (const {o: x} of myFields()) if (x.kind === o.kind && !x.value) x.value = {img: url}; }
function afterFill(p) { S.pages.forEach(drawOverlay); renderSignBar(); if (myFields().every(({o}) => done(o))) toast('All set. Click Finish signing.'); else if (p) setTimeout(nextField, 250); }

// After signing there is no automatic email, so make sure the signer leaves with their link.
async function afterSignInfo() {
  const st = SG.state, mine = st.signers.find(s => s.idx === SG.me);
  const waiting = st.signers.filter(s => s.status !== 'signed').map(s => SG.meta.signers[s.idx].name);
  const until = fmtDay(st.docsExpireAt);
  const msg = {what: 'your link', subject: `Signed: ${SG.meta.title}`,
    body: `You signed "${SG.meta.title}" on ${fmtDay(mine?.signedAt || new Date().toISOString())}.\n\n` +
      `When everyone has signed, download the signed PDF here${SG.needsCode ? " (you'll need your access code again)" : ''}:\n${location.href}\n\nThis link works until ${until}.`};
  const body = h('div', {class: 'sg-sent'},
    h('p', {}, waiting.length ? `Thanks. Still waiting for ${waiting.join(', ')}.` : 'Everyone has signed.'),
    h('p', {}, `When everyone has signed, the signed PDF will be ready at this same link. Nobody gets an automatic email, so save this link now${SG.needsCode ? "; you'll need your access code to open it again" : ''}. It works until ${until}.`),
    h('div', {class: 'sg-copy'}, h('input', {readonly: true, value: location.href, onclick: e => e.target.select()}), h('button', {onclick: () => copyText(location.href, 'your link')}, 'Copy link')),
    sendButtons(msg),
    h('p', {class: 'lbl'}, 'Or bookmark this page (Ctrl+D, or ⌘D on a Mac).'));
  await modal('You signed', body, [{label: 'Done', value: true, primary: true}], {wide: true});
}
async function finishSigning() {
  const mine = myFields();
  const missing = mine.find(({o}) => !done(o));
  if (missing) { toast('Fill in all your fields first'); return nextField(); }
  const ok = await modal('Adopt and sign', h('div', {}, h('p', {class: 'sg-consent'}, ADOPT_TEXT)),
    [{label: 'Cancel', value: false}, {label: 'Sign', value: true, primary: true}]);
  if (!ok) return;
  busy('Signing...');
  try {
    const values = {};
    for (const {o} of mine) values[o.fi] = o.value || (o.kind === 'checkbox' || o.kind === 'radio' ? {checked: false} : null);
    const method = mine.some(({o}) => o.value?.img) ? 'drawn' : 'none';
    const r = await apiCall(`envelopes/${SG.id}/submission`, {method: 'PUT', body: await encJSON(SG.key, {values, signedAt: new Date().toISOString()}),
      headers: {'x-doc-hash': SG.docHash, 'x-sign-detail': JSON.stringify({fields: mine.length, method})}});
    SG.state = await apiCall(`envelopes/${SG.id}/state`);
    busy(); S.pages.forEach(drawOverlay); renderSignBar();
    if (r.allSigned) await finalizeDoc();
    else await afterSignInfo();
  } catch (e) { console.error(e); busy(); toast('Signing failed: ' + e.message, true); }
}

// ---------- the finished PDF ----------
async function finalizeDoc() {
  busy('Finishing the signed document...');
  try {
    SG.state = await apiCall(`envelopes/${SG.id}/state`);
    await loadValues();
    const doc = await PDFDocument.load(SG.doc);
    const {font, image} = embedders(doc);
    const helv = await font('Helvetica');
    const safe = s => [...String(s ?? '')].map(ch => { try { helv.encodeText(ch); return ch; } catch { return '?'; } }).join('');
    const pages = doc.getPages();
    for (const [i, p] of S.pages.entries()) for (const o of p.objs) {
      if (o.type !== 'field' || !o.value) continue;
      for (const d of await fieldDrawables(o, safe)) await drawObj(pages[i], d, p.view, font, image);
    }
    await appendCertificate(doc, font, image, safe);
    const bytes = await doc.save();
    const finalHash = await sha256hex(bytes);
    try { await apiCall(`envelopes/${SG.id}/final`, {method: 'PUT', body: await encryptBytes(SG.key, bytes), headers: {'x-final-hash': finalHash}}); }
    catch (e) { if (e.status !== 409) throw e; }   // someone else finished it first; theirs is the copy
    SG.state = await apiCall(`envelopes/${SG.id}/state`);
    busy(); renderSignBar();
    toast('Everyone has signed. The signed PDF is ready to download.');
  } catch (e) { busy(); throw e; }
}
// a filled field as ordinary editor objects, so drawObj writes it exactly like any other edit
async function fieldDrawables(o, safe) {
  const at = (lx, ly) => { const [dx, dy] = rotVec(lx, ly, o.rot || 0); return [o.x + dx, o.y + dy]; };
  if (o.value.img) {
    const id = 'fv' + o.fi;
    if (!S.images.has(id)) { const im = await loadImageUrl(o.value.img); S.images.set(id, {url: o.value.img, aspect: im.naturalWidth / im.naturalHeight, natW: im.naturalWidth}); }
    return [fitImage(id, o)];
  }
  if (o.value.text) {
    // multi-line answers start at the top of their box; one-line ones sit in the middle
    const multi = o.kind === 'multiline', size = multi ? 10 : textSize(o), [x, y] = at(2, multi ? 2 : (o.h - size * LH) / 2);
    // clean each line on its own: a line break isn't a character the font draws, but it must stay a line break
    return [{type: 'text', text: o.value.text.split('\n').map(safe).join('\n'), size, font: 'helv', bold: false, color: '#000000', x, y, rot: o.rot}];
  }
  if (o.value.checked) {
    const w = Math.min(o.w, o.h), [x, y] = at((o.w - w) / 2, (o.h - w) / 2);
    return [{type: 'mark', glyph: 'check', x, y, w, color: '#000000', rot: o.rot}];
  }
  return [];
}
async function appendCertificate(doc, font, image, safe) {
  const audit = await apiCall(`envelopes/${SG.id}/audit`);
  const reg = await font('Helvetica'), bold = await font('HelveticaBold'), mono = await font('Courier');
  const W = 612, H = 792, M = 54;
  let pg, y;
  const newPage = () => { pg = doc.addPage([W, H]); y = H - M; };
  const need = n => { if (y - n < M + 20) newPage(); };
  const line = (text, {f = reg, size = 9.5, color = rgb(0.1, 0.1, 0.15), x = M, gap = 4} = {}) => {
    need(size + gap); y -= size; pg.drawText(safe(text), {x, y, size, font: f, color}); y -= gap;
  };
  const kv = (k, v, {f = reg, size = 9} = {}) => {
    need(size + 4); y -= size;
    pg.drawText(safe(k), {x: M + 12, y, size, font: bold, color: rgb(0.35, 0.35, 0.4)});
    pg.drawText(safe(v), {x: M + 150, y, size, font: f, color: rgb(0.1, 0.1, 0.15)}); y -= 4;
  };
  newPage();
  line('Signature Certificate', {f: bold, size: 18, gap: 10});
  kv('Document', SG.meta.title);
  kv('Sent by', SG.meta.sender || 'not recorded');
  kv('Request ID', SG.id, {f: mono});
  kv('Sent', fmtUTC(audit.events.find(e => e.type === 'sent')?.at));
  kv('Finished', fmtUTC(new Date().toISOString()));
  kv('Document SHA-256', audit.docHash, {f: mono, size: 7.5});
  kv('Audit trail', audit.intact ? 'Intact: every event is hash-chained and signed by the server' : 'WARNING: the audit trail failed its integrity check');
  y -= 8;
  line('Signers', {f: bold, size: 12, gap: 6});
  for (const s of SG.state.signers) {
    const name = SG.meta.signers[s.idx].name, evs = audit.events.filter(e => e.signer === s.idx);
    const signed = evs.find(e => e.type === 'signed'), opened = evs.find(e => e.type === 'opened'), consent = [...evs].reverse().find(e => e.type === 'consented');
    const sigField = S.pages.flatMap(p => p.objs).find(o => o.type === 'field' && o.signerIdx === s.idx && o.kind === 'signature' && o.value?.img);
    need(120);
    line(`${s.idx + 1}. ${name}`, {f: bold, size: 11, gap: 5});
    if (sigField) {
      const id = 'fv' + sigField.fi, img = await image(id), a = S.images.get(id).aspect, hh = 34, w = Math.min(160, hh * a);
      pg.drawImage(img, {x: W - M - w, y: y - hh + 8, width: w, height: w / a});
    }
    kv('Signed', signed ? fmtUTC(signed.at) : 'not signed');
    if (signed) {
      kv('IP address', signed.ip || 'unknown');
      kv('Location (from IP)', place(signed));
      kv('Browser / device', uaSummary(signed.ua));
      kv('Document seen', signed.detail?.docHashMatches ? 'Matches the document as sent' : 'DOES NOT MATCH the document as sent');
    }
    kv('Identity', !opened ? 'not verified' : opened.detail?.auth === 'link'
      ? `Opened via link only, no access code required (${fmtUTC(opened.at)})` : `Access code verified ${fmtUTC(opened.at)}`);
    kv('E-sign consent', consent ? `Agreed ${fmtUTC(consent.at)}` : 'not recorded');
    y -= 8;
  }
  y -= 4;
  line('Event history (UTC)', {f: bold, size: 12, gap: 6});
  // the last column holds the full IP (IPv6 included) with the location under it when both don't fit
  const cols = [0, 92, 214, 290], size = 7.5, lastW = W - 2 * M - cols[3];
  const fit = (s, w) => { s = safe(s); while (s && reg.widthOfTextAtSize(s, size) > w) s = s.slice(0, -2) + '…'; return s; };
  const row = (cells, where, f = reg) => {
    const both = where[1] ? `${where[0]}  ·  ${where[1]}` : where[0];
    const lines = reg.widthOfTextAtSize(safe(both), size) <= lastW ? [both] : where.filter(Boolean);
    need(lines.length * (size + 2) + 3); y -= size;
    const opt = x => ({x: M + x, y, size, font: f, color: rgb(0.15, 0.15, 0.2)});
    cells.forEach((c, i) => pg.drawText(fit(c, cols[i + 1] - cols[i] - 6), opt(cols[i])));
    lines.forEach((l, k) => { if (k) y -= size + 2; pg.drawText(fit(l, lastW), opt(cols[3])); });
    y -= 4;
  };
  row(['Time', 'Event', 'By'], ['IP address  ·  location (from IP)'], bold);
  for (const e of audit.events) {
    const who = e.signer != null ? SG.meta.signers[e.signer]?.name : ['created', 'sent', 'voided'].includes(e.type) ? 'Sender' : 'System';
    const label = e.type === 'opened' && e.detail?.auth === 'link' ? 'Opened via link (no code)' : EVENT_LABELS[e.type] || e.type;
    row([fmtUTC(e.at).replace(' UTC', ''), label, who || ''], e.ip ? [e.ip, place(e)] : ['']);
  }
  y -= 10;
  line(`Verify this document at https://${APP.domain}/verify`, {size: 8.5, color: rgb(0.2, 0.3, 0.6)});
  line(`What this certificate shows, and what it does not prove: https://${APP.domain}/esign`, {size: 8.5, color: rgb(0.2, 0.3, 0.6)});
  line(`Times are UTC. Locations are approximate, derived from IP addresses. Added automatically by ${APP.name}, ${APP.organization}.`, {size: 7.5, color: rgb(0.4, 0.4, 0.45)});
}
async function downloadFinal() {
  busy('Downloading...');
  try {
    const bytes = await decryptBytes(SG.key, await apiCall(`envelopes/${SG.id}/final`, {raw: true}));
    const a = h('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'})), download: `${SG.meta.title}-signed.pdf`});
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast(e.message, true); } finally { busy(); }
}

// ---------- wiring ----------
$('#bSignReq').onclick = () => togglePrep();
$('#prepClose').onclick = () => togglePrep(false);
$('#prepMini').onclick = () => setPrepMini(!$('#prep').classList.contains('mini'));
$('#addSigner').onclick = addSigner;
$('#sendSign').onclick = sendForSigning;
$('#sentList').onclick = showRequestList;
$('#esignAbout').onclick = () => showEsignInfo(false);
// initials used to be remembered from signing links; that could hand one signer another's initials
try { localStorage.removeItem('pdfedit.initials'); } catch {}
// startup: a signing link, or the last session; files the computer opens with the app wait for this
const booted = startFromLink() ? Promise.resolve() : restoreSession();
appStarted(booted);   // app-install.js
addEventListener('hashchange', () => { if (/^#[sm]=/.test(location.hash)) location.reload(); });
