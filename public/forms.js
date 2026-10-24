// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// Make fillable: place real PDF form fields (text, multi-line, date, checkbox, choice list, and
// pick-one radio buttons) that anyone can fill in with an ordinary PDF reader. In the editor they
// are objects of type 'ffield' that move, resize, copy and delete like anything else; Save turns
// them into AcroForm fields (addFormFields).

const FORM_KINDS = {
  signature:  {label: 'Signature', w: 170, h: 44, about: `A signature box. In a fillable PDF it’s a standard signature field (Acrobat Reader and ${APP.name} let people sign in it); in a signing request the signer draws their signature.`},
  initials:   {label: 'Initials', w: 64, h: 34, about: 'A box for initials, like the signature box.'},
  datesigned: {label: 'Date signed', w: 100, h: 20, about: 'The date they sign. In a signing request it fills itself in when they tap it; in a fillable PDF people type it.'},
  text:      {label: 'Text', w: 180, h: 20, about: 'One line, like a name, phone number or email.'},
  multiline: {label: 'Multi-line', w: 220, h: 60, about: 'Several lines, like an address or notes.'},
  date:      {label: 'Date', w: 100, h: 20, about: 'A box for a date. Readers don’t add a calendar picker, so people type it.'},
  check:     {label: 'Checkbox', w: 14, h: 14, about: 'Ticked or not.'},
  choice:    {label: 'Choice list', w: 150, h: 20, about: 'A dropdown; people pick one of the options you list.'},
  radio:     {label: 'Pick one', w: 14, h: 14, about: 'Round buttons where only one in a group can be on, like Yes / No. Place one button per answer.'},
};
// a fillable field's kind as a signing field, for when the document is sent for signing (sign.js)
const FORM_TO_SIGN = {signature: 'signature', initials: 'initials', datesigned: 'date', date: 'datepick', text: 'text',
  multiline: 'multiline', check: 'checkbox', choice: 'choice', radio: 'radio'};
const FORM_COLOR = '#0c8599';
let formKind = 'text', radioGroup = null;   // radioGroup: where the next "Pick one" button goes

const formFields = () => S.pages.flatMap(p => p.objs.filter(o => o.type === 'ffield'));
function nextName(base) {
  const names = new Set(formFields().map(o => o.name));
  let n = 1; while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
function nextOption(group) {
  const used = new Set(formFields().filter(o => o.kind === 'radio' && o.group === group).map(o => o.option));
  let n = 1; while (used.has(`Option ${n}`)) n++;
  return `Option ${n}`;
}

// ---------- a PDF's own fill-in fields, handed to signers ----------
// A fillable PDF made elsewhere already has form fields (S.fields). With Get signatures open,
// clicking one turns it into a fillable-field object for the picked signer, keeping its place,
// size, name and any answer already in it; on export the original is dropped (applyFields).
const isBlank = fd => fd.type === 'list' ? !fd.value?.length : fd.type === 'check' ? !fd.value : !fd.value;
// plain text boxes named like these become the matching signing field
function guessTextKind(name) {
  if (/initial/i.test(name)) return 'initials';
  if (/date/i.test(name)) return /sign/i.test(name) ? 'datesigned' : 'date';
  if (/signature|sign here|^sign\b/i.test(name)) return 'signature';
  return 'text';
}
function adoptAs(fd, signerKey) {
  const kind = fd.type === 'check' ? 'check' : fd.type === 'radio' ? 'radio' : fd.type === 'dropdown' || fd.type === 'list' ? 'choice'
    : fd.type === 'sig' ? (fd.initials ? 'initials' : 'signature') : fd.multiline ? 'multiline' : guessTextKind(fd.name);
  for (const w of fd.widgets) {
    const p = S.pages.find(pg => pg.src === fd.src && pg.idx === w.page); if (!p) continue;
    const o = {id: uid(), type: 'ffield', kind, name: fd.name, ...widgetBox(p, w.rect, w.rot), required: kind !== 'check', signer: signerKey, adopted: true};
    if (kind === 'radio') { o.group = fd.name; o.option = w.on; }
    if (kind === 'choice') o.options = [...fd.options];
    // keep an answer that's already there (the signer sees it filled in and can change it)
    if (!isBlank(fd)) o.prefill = fd.type === 'radio' ? fd.value === w.on : fd.type === 'list' ? fd.value[0] : fd.value;
    p.objs.push(o);
  }
  fd.adopted = true;
}
function adoptField(fi) {
  const fd = S.fields[fi], s = activeSigner();
  if (!fd || fd.adopted) return;
  if (!s) return toast('Add a signer first', true);
  pushUndo(); adoptAs(fd, s.key);
  S.pages.forEach(drawOverlay); renderPrep(); updateUI();
  toast(`${fd.name} goes to ${s.name || 'this signer'}`);
}
function adoptAllBlank() {
  const s = activeSigner(), todo = S.fields.filter(fd => !fd.adopted && !fd.readOnly && isBlank(fd));
  if (!s || !todo.length) return;
  pushUndo(); for (const fd of todo) adoptAs(fd, s.key);
  S.pages.forEach(drawOverlay); renderPrep(); updateUI();
  toast(`${todo.length} field${todo.length > 1 ? 's' : ''} go to ${s.name || 'this signer'}. Click any to give it to someone else.`);
}
// clicking a fillable field with Get signatures open gives it (a whole Pick one question) to the picked signer
function assignToPicked(o) {
  const s = activeSigner(); if (!s || o.signer === s.key) return;
  pushUndo();
  for (const x of o.kind === 'radio' ? formFields().filter(x => x.kind === 'radio' && x.group === o.group) : [o]) x.signer = s.key;
  S.pages.forEach(drawOverlay); renderPrep();
}

// ---------- placing ----------
function formPlacementSpec() {
  const k = FORM_KINDS[formKind];
  return {w: k.w, h: k.h, cls: 'ffield', color: FORM_COLOR, label: ['check', 'radio'].includes(formKind) ? '' : k.label};
}
function placeFormField(p, u, v, R) {
  const k = FORM_KINDS[formKind];
  const o = {id: uid(), type: 'ffield', kind: formKind, ...anchorBox(k.w, k.h, u, v, R)};
  if (formKind === 'radio') { o.group = radioGroup ||= nextName('Choice group'); o.name = o.group; o.option = nextOption(o.group); }
  else o.name = nextName(k.label);
  if (formKind === 'choice') o.options = ['Option 1', 'Option 2', 'Option 3'];
  o.required = formKind !== 'check';
  // another button for an existing Pick one question shares the question's settings
  const sibling = formKind === 'radio' && formFields().find(x => x.kind === 'radio' && x.group === o.group);
  if (sibling) { o.required = sibling.required; if (sibling.signer) o.signer = sibling.signer; }
  pushUndo(); p.objs.push(o); select(p, o); renderFormPrep();
}
// a pasted or duplicated field is a separate field, so it gets its own name (or answer, for Pick one)
function freshFormName(o) {
  if (o.kind === 'radio') { o.option = nextOption(o.group); return; }
  const names = new Set(formFields().map(x => x.name));
  if (!names.has(o.name)) return;
  const base = o.name.replace(/ \d+$/, '');
  let n = 2; while (names.has(`${base} ${n}`)) n++;
  o.name = `${base} ${n}`;
}
function buildFormFieldEl(o, isSel) {
  const s = S.signers.find(x => x.key === o.signer), who = s ? ` (${s.name || 'signer'} fills it)` : '';
  const el = h('div', {class: `obj ffield ${o.kind}` + (isSel ? ' sel' : ''), 'data-oid': o.id,
    title: (o.kind === 'radio' ? `Pick one: ${o.group} → ${o.option}` : `${FORM_KINDS[o.kind].label}: ${o.name}`) + who});
  el.style.cssText = `left:${o.x}px;top:${o.y}px;width:${o.w}px;height:${o.h}px;font-size:${Math.max(5, Math.min(10, o.h * 0.5))}px`;
  if (s) el.style.setProperty('--fc', s.color);   // in the color of whoever fills it
  if (o.rot) el.style.transform = `rotate(${-o.rot}deg)`;
  const label = o.kind === 'choice' ? `${o.name} ▾` : ['check', 'radio'].includes(o.kind) ? '' : o.name;
  if (label) el.appendChild(h('span', {class: 'sf-label'}, label));
  if (isSel) el.appendChild(h('div', {class: 'handle'}));
  return el;
}

// ---------- the panel ----------
function toggleFormPrep(open) {
  const el = $('#formPrep'); open = open ?? el.hidden;
  if (open && !$('#prep').hidden) togglePrep(false);   // one panel at a time
  el.hidden = !open; $('#bFormPrep').classList.toggle('on', open);
  if (open) renderFormPrep();
  else { if (S.tool === 'formfield') setTool('select'); setPanelMini(el, false); }
}
function renderFormKinds() {
  const box = $('#formKinds'); if (!box) return;
  if (!box.children.length) for (const [k, f] of Object.entries(FORM_KINDS)) {
    box.appendChild(h('button', {'data-kind': k, title: `${f.label}: ${f.about}`, onclick: () => {
      formKind = k; setTool('formfield'); renderFormKinds();
      if (isNarrow()) setPanelMini($('#formPrep'), true);   // phones: get the sheet out of the way so the page can be tapped
    }}, f.label));
  }
  box.querySelectorAll('button').forEach(b => b.classList.toggle('on', S.tool === 'formfield' && formKind === b.dataset.kind));
  $('#formTitle').textContent = S.tool === 'formfield' && isNarrow() && $('#formPrep').classList.contains('mini')
    ? `Tap the page: ${FORM_KINDS[formKind].label}` : 'Make fillable';
}
// edits to a field's settings: one undo step per focused input
function propInput(label, value, onValue, {multiline = false, hint} = {}) {
  const s = findSel();
  const input = h(multiline ? 'textarea' : 'input', {value: multiline ? null : value, rows: multiline ? 4 : null,
    onfocus: e => { e.target._before = snap(); },
    oninput: e => { onValue(e.target.value); redraw(s.p); },
    onchange: e => { if (e.target._before) { commit(e.target._before); e.target._before = null; } }});
  if (multiline) input.value = value;
  return h('label', {class: 'ff-prop'}, h('span', {}, label), input, hint ? h('span', {class: 'lbl'}, hint) : null);
}
function renderFormPrep() {
  renderFormKinds();
  const props = $('#formProps'); props.textContent = '';
  const s = findSel();
  if (s?.o.type === 'ffield') {
    const o = s.o;
    props.appendChild(h('div', {class: 'lbl'}, `Selected: ${FORM_KINDS[o.kind].label}. ${FORM_KINDS[o.kind].about}`));
    if (o.kind === 'radio') {
      props.append(
        propInput('Group', o.group, v => { const old = o.group; for (const x of formFields()) if (x.kind === 'radio' && x.group === old) { x.group = v; x.name = v; } radioGroup = v; },
          {hint: 'Buttons with the same group name are one question; only one can be on.'}),
        propInput('This button’s answer', o.option, v => { o.option = v; }),
        h('button', {onclick: () => { radioGroup = nextName('Choice group'); formKind = 'radio'; setTool('formfield'); renderFormPrep(); toast(`Next buttons go in ${radioGroup}`); }}, 'Start a new question'));
    } else {
      props.append(propInput('Name', o.name, v => { o.name = v; }, {hint: 'Readers show it as the hint when someone hovers or taps the field.'}));
      if (o.kind === 'choice') props.append(propInput('Options, one per line', (o.options || []).join('\n'), v => { o.options = v.split('\n'); }, {multiline: true}));
    }
    // a Pick one question is one field: these settings apply to all of its buttons
    const same = o.kind === 'radio' ? formFields().filter(x => x.kind === 'radio' && x.group === o.group) : [o];
    const setAll = (k, v) => { pushUndo(); for (const x of same) x[k] = v; S.pages.forEach(drawOverlay); renderFormPrep(); };
    props.append(h('label', {class: 'chk', style: 'margin-top:8px', title: o.kind === 'check' ? 'They must tick it, like an “I agree” box' : 'They can’t finish without filling it in'},
      h('input', {type: 'checkbox', checked: o.required !== false, onchange: e => setAll('required', e.target.checked)}),
      o.kind === 'check' ? 'Required (must be ticked)' : 'Required'));
    if (S.signers.length) {
      const sel = h('select', {onchange: e => setAll('signer', e.target.value || undefined)},
        h('option', {value: ''}, 'Decide when sending'), S.signers.map(sg => h('option', {value: sg.key, selected: o.signer === sg.key}, sg.name || 'Unnamed signer')));
      props.append(h('label', {class: 'ff-prop'}, h('span', {}, 'Filled by (when sent for signing)'), sel));
    }
  } else if (S.tool === 'formfield') {
    props.appendChild(h('div', {class: 'lbl'}, `${FORM_KINDS[formKind].label}: ${FORM_KINDS[formKind].about} Click the page to place it.`));
  }
  const n = formFields().length;
  $('#formCount').textContent = n ? `${n} fillable field${n > 1 ? 's' : ''}. Click one to name it. Save gives you the fillable PDF.` : 'No fields yet.';
}

// ---------- saving: editor fields become real PDF form fields ----------
// entries: [{p, pg, view}] for each output page (pdf-lib page and the page's crop box)
function addFormFields(doc, entries) {
  const items = entries.flatMap(e => e.p.objs.filter(o => o.type === 'ffield').map(o => ({o, ...e})));
  if (!items.length) return;
  const form = doc.getForm();
  const taken = new Set(form.getFields().map(f => f.getName()));
  // names must be unique across the file (including fields it already had) and can't contain dots
  const unique = name => {
    const base = (name || 'Field').replace(/\./g, '_').trim() || 'Field';
    let n = base, i = 2; while (taken.has(n)) n = `${base} ${i++}`;
    taken.add(n); return n;
  };
  const hint = (field, text) => field.acroField.dict.set(PDFName.of('TU'), PDFLib.PDFHexString.fromText(text));
  const groups = new Map();
  for (const {o, pg, view} of items) {
    // the field's rectangle in PDF space; on a rotated page width and height swap, and the
    // widget is turned to match so its text reads upright
    const pts = [[0, 0], [o.w, 0], [0, o.h], [o.w, o.h]].map(([a, b]) => { const [dx, dy] = rotVec(a, b, o.rot || 0); return [view[0] + o.x + dx, view[3] - (o.y + dy)]; });
    const minX = Math.min(...pts.map(q => q[0])), minY = Math.min(...pts.map(q => q[1]));
    // pdf-lib takes the unrotated size plus an anchor corner and rotates the box itself, so give it
    // the corner that lands the rotated box on [minX, minY]
    const rot = ((Math.round((o.rot || 0) / 90) * 90) % 360 + 360) % 360;
    const anchor = {0: [minX, minY], 90: [minX + o.h, minY], 180: [minX + o.w, minY + o.h], 270: [minX, minY + o.w]}[rot];
    const look = {x: anchor[0], y: anchor[1], width: o.w, height: o.h,
      rotate: degrees(rot), borderColor: rgb(0.55, 0.6, 0.7), borderWidth: 0.75, backgroundColor: rgb(0.93, 0.96, 1), textColor: rgb(0, 0, 0)};
    const req = f => { if (o.required !== false) f.enableRequired(); };
    if (o.kind === 'radio') {
      let g = groups.get(o.group);
      if (!g) { g = {field: form.createRadioGroup(unique(o.group)), used: new Set()}; groups.set(o.group, g); hint(g.field, o.group || 'Pick one'); req(g.field); }
      const base = (o.option || 'Option').trim() || 'Option';
      let opt = base, i = 2; while (g.used.has(opt)) opt = `${base} ${i++}`;
      g.used.add(opt);
      g.field.addOptionToPage(opt, pg, look);
      if (o.prefill === true) g.field.select(opt);   // an answer the PDF already had
    } else if (o.kind === 'check') {
      const f = form.createCheckBox(unique(o.name)); f.addToPage(pg, look); hint(f, o.name); req(f);
      if (o.prefill) f.check();
    } else if (o.kind === 'choice') {
      const f = form.createDropdown(unique(o.name));
      const opts = [...new Set((o.options || []).map(x => x.trim()).filter(Boolean))];
      if (opts.length) f.addOptions(opts);
      f.addToPage(pg, look); hint(f, o.name); req(f);
      if (o.prefill && opts.includes(o.prefill)) f.select(o.prefill);
    } else if (o.kind === 'signature' || o.kind === 'initials') {
      addSignatureField(doc, form, unique(o.name), o.name, pg, {minX, minY, rot, w: o.w, h: o.h, required: o.required !== false});
    } else {
      const f = form.createTextField(unique(o.name));
      if (o.kind === 'multiline') f.enableMultiline();
      f.addToPage(pg, look);
      f.setFontSize(o.kind === 'multiline' ? 10 : Math.max(6, Math.min(12, o.h * 0.62)));
      // say it's a date, unless the name already does
      const what = {date: 'date', datesigned: 'date signed'}[o.kind];
      hint(f, what && !/date/i.test(o.name) ? `${o.name} (${what})` : o.name);
      req(f);
      if (typeof o.prefill === 'string' && o.prefill) f.setText(o.prefill);
    }
  }
}
// pdf-lib has no builder for signature fields, so this writes one the standard way: an unsigned
// /Sig field whose widget sits on the page, drawn as the same tinted, outlined box as the others.
// Acrobat Reader offers to sign it; this editor lets people draw their signature into it.
function addSignatureField(doc, form, name, label, pg, {minX, minY, rot, w, h, required}) {
  const ctx = doc.context, swap = rot % 180 !== 0;
  const rect = [minX, minY, minX + (swap ? h : w), minY + (swap ? w : h)];
  // the appearance is drawn upright at w x h; its matrix turns it to match the page
  const matrix = {0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0]}[rot];
  const L = PDFLib, ap = ctx.formXObject([
    L.pushGraphicsState(), L.setFillingRgbColor(0.93, 0.96, 1), L.rectangle(0, 0, w, h), L.fill(),
    L.setStrokingRgbColor(0.55, 0.6, 0.7), L.setLineWidth(0.75), L.rectangle(0.375, 0.375, w - 0.75, h - 0.75), L.stroke(), L.popGraphicsState(),
  ], {BBox: [0, 0, w, h], Matrix: matrix});
  const ref = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: L.PDFHexString.fromText(name), TU: L.PDFHexString.fromText(label || name),
    Ff: required ? 2 : 0, F: 4, Rect: rect, P: pg.ref, MK: {R: rot}, AP: {N: ctx.register(ap)},
  }));
  pg.node.addAnnot(ref);
  form.acroForm.addField(ref);
}

$('#bFormPrep').onclick = () => toggleFormPrep();
$('#formClose').onclick = () => toggleFormPrep(false);
$('#formMini').onclick = () => setPanelMini($('#formPrep'), !$('#formPrep').classList.contains('mini'));
