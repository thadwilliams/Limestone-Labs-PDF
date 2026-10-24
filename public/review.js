// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// The review panel, on the right:
//   Comments  every comment and mark in the document, including ones made in Acrobat or other apps,
//             with their replies. Click one to go to it; reply, edit or remove.
//   Compare   what changed between this document and another version of it, word by word. Scans are
//             read with OCR first. The changes can be marked up in this document as highlights and notes.
// Text from a PDF (other people's comments, document words) is only ever shown as text, never as HTML.
// Uses tools.js (dialogs, notes, marks, OCR, word boxes).

const rv = {mode: null, annots: new Map(), timer: null, cmp: null};
document.head.appendChild(Object.assign(document.createElement('style'), {textContent: `
#review{width:320px}
#review .rv-sum{font-size:13px;color:var(--muted)}
.rv-page{font-size:12px;font-weight:600;color:var(--muted);margin:10px 0 2px;text-transform:uppercase;letter-spacing:.03em}
.rv-item{border:1px solid var(--line);border-radius:8px;padding:8px 10px;cursor:pointer;background:var(--panel)}
.rv-item:hover{border-color:var(--accent)}
.rv-item + .rv-item{margin-top:6px}
.rv-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.rv-meta b{color:var(--ink);font-weight:600}
.rv-dot{width:10px;height:10px;border-radius:3px;flex:none;border:1px solid rgba(0,0,0,.15)}
.rv-text{white-space:pre-wrap;word-break:break-word;margin-top:4px;font-size:13.5px}
.rv-acts{display:flex;gap:4px;margin-top:6px}
.rv-acts button{font-size:12px;padding:2px 8px}
.rv-replies{margin:6px 0 0 10px;padding-left:8px;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:6px}
.rv-replies .rv-item{border:0;padding:2px 0;background:none}
.rv-removed{opacity:.55}
.rv-removed .rv-text{text-decoration:line-through}
.rv-old{color:#c92a2a;text-decoration:line-through;white-space:pre-wrap;word-break:break-word}
.rv-new{color:#2b8a3e;white-space:pre-wrap;word-break:break-word}
.rv-flash{position:absolute;transform-origin:0 0;outline:calc(3px / var(--s)) solid #f59f00;background:rgba(245,159,0,.18);pointer-events:none;animation:rvfade 1.6s ease-out forwards}
@keyframes rvfade{0%,60%{opacity:1}100%{opacity:0}}
.rv-empty{color:var(--muted);font-size:13.5px;margin-top:8px}
`}));

const panel = el('aside', {id: 'review', className: 'sidepanel', hidden: true});
panel.innerHTML = '<div class="prep-head"><strong id="rvTitle"></strong><span><button id="rvMini" class="panel-mini" title="Show or hide the panel">&#9662;</button><button id="rvClose" title="Close this panel">&times;</button></span></div><div id="rvBody"></div>';
document.querySelector('main').append(panel);
$('#rvClose').onclick = () => closeReview();
$('#rvMini').onclick = () => panel.classList.toggle('mini');
const btnComments = el('button', {id: 'bComments', textContent: 'Comments list', title: 'List every comment and mark in the document, including ones made in Acrobat; reply, edit or remove them', onclick: () => openReview('comments')});
const btnCompare = el('button', {id: 'bCompare', textContent: 'Compare', title: 'Compare this document with another version and see every word that changed', onclick: () => openReview('compare')});
($('#gDoc') || document.querySelector('header')).append(btnComments, btnCompare);   // layout.js moves them into its tabs

function openReview(mode) {
  if (!S.pages.length) return;
  if (rv.mode === mode && !panel.hidden) return closeReview();
  rv.mode = mode; panel.hidden = false; panel.classList.remove('mini');
  btnComments.classList.toggle('on', mode === 'comments'); btnCompare.classList.toggle('on', mode === 'compare');
  renderReview();
}
function closeReview() {
  rv.mode = null; panel.hidden = true;
  btnComments.classList.remove('on'); btnCompare.classList.remove('on');
}
function renderReview() { if (rv.mode === 'comments') renderComments(); else if (rv.mode === 'compare') renderCompare(); }
const prevReviewUI = EXT.updateUI;
EXT.updateUI = has => {
  prevReviewUI?.(has);
  btnComments.disabled = btnCompare.disabled = !has;
  if (!has && rv.mode) { closeReview(); rv.cmp = null; }
  // keep the list current as comments are added, moved or removed (not while typing in it)
  if (rv.mode === 'comments' && !panel.contains(document.activeElement)) { clearTimeout(rv.timer); rv.timer = setTimeout(renderComments, 150); }
};
const fmtDate = d => d ? d.toLocaleString(undefined, {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
// a box (overlay space) on a page, flashed so the eye finds it; scrolls it into view
function flashBoxes(p, boxes) {
  const d = DOM.get(p.id); if (!d || !boxes.length) return;
  d.el.querySelectorAll('.rv-layer').forEach(x => x.remove());
  const layer = el('div', {className: 'findlayer rv-layer'});
  Object.assign(layer.style, {width: d.ov.style.width, height: d.ov.style.height, transform: d.ov.style.transform});
  layer.style.setProperty('--s', S.scale);
  for (const b of boxes) {
    const e = el('div', {className: 'rv-flash'});
    Object.assign(e.style, {left: b.x - 2 + 'px', top: b.y - 2 + 'px', width: b.w + 4 + 'px', height: b.h + 4 + 'px'});
    if (b.rot) e.style.transform = `rotate(${-b.rot}deg)`;
    layer.append(e);
  }
  d.el.append(layer);
  layer.firstChild.scrollIntoView({block: 'center', behavior: 'smooth'});
  setTimeout(() => layer.remove(), 1700);
}

// ---------- Comments ----------
const SHOWN = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment']);
const KIND_NAMES = {Text: 'Comment', FreeText: 'Text box', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly underline', Ink: 'Drawing', Square: 'Rectangle', Circle: 'Oval', PolyLine: 'Lines', FileAttachment: 'Attachment'};
// comments already in the PDF, from pdf.js (cached per page of each opened file)
function pdfComments(p) {
  const key = p.src + ':' + p.idx;
  if (!rv.annots.has(key)) rv.annots.set(key, getPage(p.src, p.idx).then(pg => pg.getAnnotations()).then(list => list
    .filter(a => SHOWN.has(a.subtype))
    .map(a => ({id: a.id, subtype: a.subtype, text: a.contentsObj?.str || '', author: a.titleObj?.str || '', irt: a.inReplyTo || null,
      rect: a.rect, color: a.color ? '#' + [...a.color].map(c => c.toString(16).padStart(2, '0')).join('') : '#adb5bd',
      date: pdfjsLib.PDFDateString.toDateObject(a.modificationDate || a.creationDate || '')}))).catch(() => []));
  return rv.annots.get(key);
}
async function renderComments() {
  if (rv.mode !== 'comments') return;
  const baseSrc = S.pages[0]?.src, rows = new Map(), order = [];
  for (const [i, p] of S.pages.entries()) {
    for (const o of p.objs) if (o.type === 'note' || o.type === 'markup') {
      const key = 'o' + o.id;
      rows.set(key, {key, i, p, o, kind: o.type === 'note' ? 'Comment' : MARK_NAMES[o.kind], author: o.author, date: new Date(o.at), text: o.text,
        color: o.type === 'note' ? o.fill : o.color, parent: o.irt ? (o.irt.id != null ? 'o' + o.irt.id : `a${p.src}:${o.irt.ref}`) : null, y: o.y});
      order.push(key);
    }
    for (const a of await pdfComments(p)) {
      const key = `a${p.src}:${a.id}`; if (rows.has(key)) continue;
      rows.set(key, {key, i, p, a, kind: KIND_NAMES[a.subtype] || a.subtype, author: a.author, date: a.date, text: a.text, color: a.color,
        parent: a.irt ? `a${p.src}:${a.irt}` : null, y: p.view[3] - a.rect[3], removed: p.dropAnnots?.includes(a.id), canRemove: p.src === baseSrc});
      order.push(key);
    }
  }
  if (rv.mode !== 'comments') return;
  const kids = new Map();
  for (const k of order) { const r = rows.get(k); if (r.parent && rows.has(r.parent)) (kids.get(r.parent) || kids.set(r.parent, []).get(r.parent)).push(r); }
  const tops = order.map(k => rows.get(k)).filter(r => !r.parent || !rows.has(r.parent)).sort((a, b) => a.i - b.i || a.y - b.y);
  $('#rvTitle').textContent = `Comments (${rows.size})`;
  const body = $('#rvBody'); body.textContent = '';
  if (!tops.length) return body.append(el('div', {className: 'rv-empty', textContent: 'No comments yet. Use Comment, Highlight, Strike or Underline on the Annotate tab. Comments people made in Acrobat show up here too.'}));
  let page = -1;
  for (const r of tops) {
    if (r.i !== page) { page = r.i; body.append(el('div', {className: 'rv-page', textContent: 'Page ' + (page + 1)})); }
    const card = commentCard(r);
    const replies = kids.get(r.key);
    if (replies) card.append(el('div', {className: 'rv-replies'}, ...replies.map(commentCard)));
    body.append(card);
  }
}
function commentCard(r) {
  const meta = el('div', {className: 'rv-meta'}, el('span', {className: 'rv-dot'}), el('b', {textContent: r.parent ? 'Reply' : r.kind}),
    el('span', {textContent: [r.author, fmtDate(r.date)].filter(Boolean).join(' · ')}));
  meta.firstChild.style.background = r.color || '#adb5bd';
  const card = el('div', {className: 'rv-item' + (r.removed ? ' rv-removed' : '')}, meta);
  if (r.text) card.append(el('div', {className: 'rv-text', textContent: r.text}));
  if (r.removed) card.append(el('div', {className: 'lbl', textContent: 'Removed when you save.'}));
  const acts = el('div', {className: 'rv-acts'});
  const act = (label, title, fn, disabled) => acts.append(el('button', {textContent: label, title, disabled: !!disabled, onclick: e => { e.stopPropagation(); fn(); }}));
  if (r.removed) act('Restore', 'Keep this comment', () => restoreComment(r));
  else {
    act('Reply', 'Reply to this comment', () => replyTo(r));
    if (r.o) act('Edit', 'Change this comment', () => editComment(r));
    act('Remove', r.o || r.canRemove ? 'Remove this comment and its replies' : 'Only comments in the first file you opened can be removed', () => removeComment(r), !r.o && !r.canRemove);
  }
  card.append(acts);
  card.onclick = () => goToComment(r);
  return card;
}
function goToComment(r) {
  if (r.o) {
    const target = r.o.irt ? findParentObj(r) : r.o;
    if (target && !target.irt) { select(r.p, target); objEl(r.p, target)?.scrollIntoView({block: 'center', behavior: 'smooth'}); return; }
  }
  const a = r.a || null, p = r.p;
  if (a) flashBoxes(p, [{x: a.rect[0] - p.view[0], y: p.view[3] - a.rect[3], w: a.rect[2] - a.rect[0], h: a.rect[3] - a.rect[1]}]);
  else if (r.o) flashBoxes(p, [{x: r.o.x, y: r.o.y, w: 20, h: 20}]);
}
function findParentObj(r) { return r.o.irt.id != null ? r.p.objs.find(o => o.id === r.o.irt.id) : null; }
async function replyTo(r) {
  const res = await editNote(r.p, null);
  if (!res || res.value !== 'ok') return;
  rememberAuthor(res.who);
  const p = r.p, at = r.o ? [r.o.x, r.o.y] : [r.a.rect[0] - p.view[0], p.view[3] - r.a.rect[3]];
  const irt = r.o ? {id: r.o.id} : {ref: r.a.id};
  pushUndo();
  p.objs.push({id: uid(), type: 'note', x: at[0], y: at[1], w: 20, h: 20, rot: dims(p).R, text: res.text, author: res.who, at: Date.now(), fill: '#ffd43b', irt});
  redraw(p); updateUI();
}
async function editComment(r) {
  const res = await editNote(r.p, r.o);
  if (!res?.value) return;
  if (res.value === 'delete') return removeComment(r);
  pushUndo(); r.o.text = res.text; r.o.author = res.who; rememberAuthor(res.who);
  redraw(r.p); updateUI();
}
// a comment and everything that replies to it, ours or the PDF's
function removeComment(r) {
  const p = r.p;
  pushUndo();
  if (r.o) {
    const gone = new Set([r.o.id]);
    for (let grew = true; grew;) { grew = false; for (const o of p.objs) if (o.irt?.id != null && gone.has(o.irt.id) && !gone.has(o.id)) { gone.add(o.id); grew = true; } }
    p.objs = p.objs.filter(o => !gone.has(o.id));
    if (S.sel && gone.has(S.sel.oid)) S.sel = null;
  } else {
    pdfComments(p).then(list => {
      const ids = new Set([r.a.id]);
      for (let grew = true; grew;) { grew = false; for (const a of list) if (a.irt && ids.has(a.irt) && !ids.has(a.id)) { ids.add(a.id); grew = true; } }
      p.dropAnnots = [...new Set([...(p.dropAnnots || []), ...ids])];
      p.objs = p.objs.filter(o => !(o.irt?.ref && ids.has(o.irt.ref)));
      redraw(p); updateUI();
    });
    return;
  }
  redraw(p); updateUI();
}
function restoreComment(r) {
  pushUndo();
  r.p.dropAnnots = (r.p.dropAnnots || []).filter(id => id !== r.a.id);
  updateUI();
}

// ---------- Compare ----------
function renderCompare() {
  $('#rvTitle').textContent = 'Compare';
  const body = $('#rvBody'); body.textContent = '';
  if (!rv.cmp) {
    const input = el('input', {type: 'file', accept: 'application/pdf,.pdf', hidden: true, onchange: () => { const f = input.files[0]; input.value = ''; if (f) runCompare(f, caps.checked); }});
    const caps = el('input', {type: 'checkbox', checked: true});
    body.append(
      el('p', {textContent: 'See every word that changed between this document and another version of it, such as the copy you sent out and the one that came back.'}),
      el('button', {className: 'primary', textContent: 'Choose the other version…', onclick: () => input.click()}), input,
      el('label', {className: 'chk', style: 'margin-top:8px'}, caps, document.createTextNode(' Ignore capital letters')),
      el('div', {className: 'lbl', style: 'margin-top:8px', textContent: 'Scans are read with OCR first, which takes a few seconds per page; OCR misreads can show up as small false changes. Nothing is uploaded.'}));
    return;
  }
  const {hunks, other} = rv.cmp, n = hunks.length;
  const counts = {Changed: 0, Added: 0, Removed: 0};
  hunks.forEach(h => counts[h.kind]++);
  body.append(
    el('div', {className: 'rv-sum', textContent: n ? `${n} difference${n > 1 ? 's' : ''} from ${other}: ${counts.Changed} changed, ${counts.Added} added, ${counts.Removed} removed.` : `No differences in the text from ${other}.`}),
    el('div', {className: 'rv-acts'},
      ...(n ? [el('button', {className: 'primary', textContent: 'Mark up this document', title: 'Highlight every change in this document, with a comment saying what it was, and a note where text was removed', onclick: markChanges})] : []),
      el('button', {textContent: 'Compare another', onclick: () => { rv.cmp = null; renderCompare(); }})));
  let page = -1;
  for (const h of hunks) {
    if (h.page !== page) { page = h.page; body.append(el('div', {className: 'rv-page', textContent: 'Page ' + (page + 1)})); }
    const card = el('div', {className: 'rv-item'}, el('div', {className: 'rv-meta'}, el('b', {textContent: h.kind}), el('span', {textContent: h.otherPage ? `was on page ${h.otherPage}` : ''})));
    if (h.del.length) card.append(el('div', {className: 'rv-old', textContent: clip(h.del.map(w => w.t).join(' '))}));
    if (h.ins.length) card.append(el('div', {className: 'rv-new', textContent: clip(h.ins.map(w => w.t).join(' '))}));
    card.onclick = () => { const p = S.pages[h.page]; if (p) flashBoxes(p, h.boxes); };
    body.append(card);
  }
}
const clip = t => t.length > 300 ? t.slice(0, 300) + '…' : t;
// Punctuation before or after a word is its own token, so "support." vs "support and reports." is an
// addition, not a change; inside a word it stays ("$412.50", "4417-22"). Boxes are split by letters.
function splitWord(w) {
  const m = /^([("'\[{“‘]*)(.*?)([.,;:!?)"'\]}”’]*)$/su.exec(w.t), out = [];
  const part = (t, a) => {
    if (!t) return;
    const x = {...w, t};
    if (w.w != null) { const n = w.t.length, [dx, dy] = rotVec(w.w * a / n, 0, w.rot || 0); Object.assign(x, {x: w.x + dx, y: w.y + dy, w: w.w * t.length / n}); }
    out.push(x);
  };
  if (!m || !m[2]) return [w];
  part(m[1], 0); part(m[2], m[1].length); part(m[3], m[1].length + m[2].length);
  return out;
}
const norm = (t, caps) => { t = t.normalize('NFKC').replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[‐-―−]/g, '-'); return caps ? t.toLowerCase() : t; };
// this document's words in reading order, with their boxes; pages without text use their OCR words
async function currentWords() {
  const out = [];
  for (const [i, p] of S.pages.entries()) {
    for (const w of textWords((await textContent(p)).items, p.view)) out.push({...w, page: i});
    for (const o of p.objs) if (o.type === 'ocr') for (const w of o.words) out.push({t: w.t, x: o.x + w.x, y: o.y + w.y, w: w.w, h: w.h, rot: o.rot, page: i});
  }
  return out;
}
// the other file's words (its text, or OCR for pages that have none)
async function otherWords(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()), js = await loadPdfjs(bytes, file.name), out = [];
  try {
    let worker = null;
    for (let n = 1; n <= js.numPages; n++) {
      const pg = await js.getPage(n), items = (await pg.getTextContent()).items;
      const words = items.flatMap(it => (it.str || '').match(/\S+/g) || []);
      if (words.join('').length > 20) { for (const t of words) out.push({t, page: n}); continue; }
      busy(`Reading page ${n} of ${js.numPages} of ${file.name} (OCR)...`);
      worker ||= await getOcr();
      const one = pg.getViewport({scale: 1}), k = Math.min(300 / 72, 3400 / Math.max(one.width, one.height)), vp = pg.getViewport({scale: k});
      const c = el('canvas', {width: Math.round(vp.width), height: Math.round(vp.height)}), cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await pg.render({canvasContext: cx, viewport: vp}).promise;
      despeckle(cx, c.width, c.height);
      const {data} = await worker.recognize(c);
      for (const w of data.words || []) if (w.text.trim() && w.confidence >= 40) out.push({t: w.text.trim(), page: n});
      c.width = c.height = 0;
    }
  } finally { js.destroy(); }
  return out;
}
async function runCompare(file, caps) {
  finishEditing();
  // pages of this document with no text and no OCR yet get read first
  const unread = [];
  for (const p of S.pages) if (!p.objs.some(o => o.type === 'ocr') && await pageTextChars(p) <= 20) unread.push(p);
  if (unread.length) await runOcr(unread, true);
  busy('Comparing...');
  try {
    const cur = (await currentWords()).flatMap(splitWord), old = (await otherWords(file)).flatMap(splitWord);
    busy('Comparing...');
    if (!cur.length || !old.length) { busy(); return toast(`${!cur.length ? 'This document' : file.name} has no text to compare.`, true); }
    const ops = diffWords(old.map(w => norm(w.t, caps)), cur.map(w => norm(w.t, caps)));
    if (!ops) { busy(); return toast('These two documents are too different to compare word by word.', true); }
    rv.cmp = {hunks: makeHunks(ops, old, cur), other: file.name};
  } catch (e) { console.error(e); busy(); return toast('Could not compare: ' + e.message, true); }
  busy();
  if (rv.mode === 'compare') renderCompare();
}
// Myers' diff over two word lists: ['=', ai, bi], ['-', ai] (only in a) and ['+', bi] (only in b),
// in order. null when more than maxD words differ (memory grows with the square of that).
function diffWords(a, b, maxD = 4000) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length, off = n + m + 1;
  const v = new Int32Array(2 * off + 2), trace = [];
  let D = -1;
  outer: for (let d = 0; d <= n + m; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));   // what step d reads, kept for walking back
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { D = d; break outer; }
    }
  }
  const ops = [];
  let x = n, y = m;
  for (let d = D; d >= 0; d--) {
    const V = trace[d], get = k => V[k + d + 1], k = x - y;
    const pk = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1, px = get(pk), py = px - pk;
    while (x > px && y > py) { x--; y--; ops.push(['=', x + s, y + s]); }
    if (d > 0) { if (x === px) ops.push(['+', y - 1 + s]); else ops.push(['-', x - 1 + s]); }
    x = px; y = py;
  }
  ops.reverse();
  return ops;
}
// runs of changes, each with the words it took out (del) and put in (ins), and boxes to show it by
function makeHunks(ops, old, cur) {
  const hunks = [];
  let h = null, nextCur = 0;
  const close = () => {
    if (!h) return;
    h.kind = h.del.length && h.ins.length ? 'Changed' : h.ins.length ? 'Added' : 'Removed';
    // where to point: the new words, or for a removal the word just before the gap (else just after)
    const anchor = h.ins.length ? h.ins : [cur[Math.max(0, h.at - 1)] || cur[h.at]].filter(Boolean);
    h.page = anchor[0]?.page ?? 0;
    h.boxes = anchor.filter(w => w.page === h.page).map(({x, y, w, h: hh, rot}) => ({x, y, w, h: hh, rot}));
    h.otherPage = h.del[0]?.page;
    hunks.push(h); h = null;
  };
  for (const op of ops) {
    if (op[0] === '=') { close(); nextCur = op[2] + 1; continue; }
    h ||= {del: [], ins: [], at: nextCur};
    if (op[0] === '-') h.del.push(old[op[1]]); else { h.ins.push(cur[op[1]]); nextCur = op[1] + 1; }
  }
  close();
  return hunks;
}
function markChanges() {
  const hunks = rv.cmp?.hunks; if (!hunks?.length) return;
  pushUndo();
  let marks = 0;
  for (const h of hunks) {
    const p = S.pages[h.page]; if (!p || !h.boxes.length) continue;
    const was = h.del.map(w => w.t).join(' ');
    if (h.ins.length) p.objs.push(makeMarkup('highlight', h.boxes, '#8ce99a', {text: h.del.length ? 'Changed. Was: ' + clip(was) : 'Added', author: 'Compare with ' + rv.cmp.other}));
    else {
      const b = h.boxes[0], [dx, dy] = rotVec(b.w, -6, b.rot || 0);
      p.objs.push({id: uid(), type: 'note', x: b.x + dx, y: b.y + dy, w: 16, h: 16, rot: dims(p).R, text: 'Removed: ' + clip(was), author: 'Compare with ' + rv.cmp.other, at: Date.now(), fill: '#ff8787'});
    }
    marks++;
  }
  S.pages.forEach(drawOverlay); updateUI();
  toast(`Marked ${marks} change${marks > 1 ? 's' : ''}: green highlights for new or changed words, red notes where words were removed. Save to keep them.`);
}
