// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// Acrobat-style extras, all in the browser like the rest of the editor (nothing is uploaded):
//   Redact (really removes what's underneath), Strikethrough, Underline, Comments (sticky notes),
//   Find (with Highlight all / Redact all), Print, Insert blank page, Extract or split pages, Crop,
//   Headers, footers, page numbers and Bates numbers, Watermarks, Password protection, Smaller file.
// It plugs into index.html through EXT (see there). Every save also drops objects nothing refers to
// any more, so deleted pages and redacted content don't linger inside the file.

const N = n => PDFName.of(n);
const find = {open: false, hits: [], cur: -1, timer: null};   // Find's state (see Find below)
const scanChecked = new WeakSet();   // sources already checked for "this looks like a scan" (see OCR)

// ---------- styles and toolbar ----------
document.head.appendChild(Object.assign(document.createElement('style'), {textContent: `
.ov.t-redact,.ov.t-strike,.ov.t-underline,.ov.t-crop{cursor:crosshair;touch-action:none}
.ov.t-note{cursor:copy}
svg.vec polygon.hit{pointer-events:fill}
.ov.t-select svg.vec polygon.hit{cursor:move}
.ov:not(.t-select) [data-stamp]{pointer-events:none}
.obj.redact{background:#000;outline:calc(1.5px / var(--s)) solid #e03131}
.obj.note{background:#ffd43b;border:calc(1px / var(--s)) solid #b08900;border-radius:calc(3px / var(--s));display:flex;align-items:center;justify-content:center;cursor:move;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.obj.note svg{width:72%;height:72%;pointer-events:none}
.croprect{position:absolute;border:calc(1.5px / var(--s)) dashed var(--accent);background:rgba(37,99,235,.08);box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none}
.findlayer{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none}
.findhit{position:absolute;transform-origin:0 0;background:rgba(255,170,0,.3);outline:calc(1px / var(--s)) solid rgba(230,120,0,.8)}
.findhit.cur{background:rgba(255,80,0,.4);outline:calc(2px / var(--s)) solid #f03e3e}
#findbar{position:fixed;right:16px;bottom:16px;z-index:7;display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);max-width:calc(100vw - 32px)}
#findbar input{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 7px;width:220px;min-width:0}
#findCount{min-width:64px;text-align:center}
.tl-menu{position:fixed;z-index:12;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);padding:4px;display:flex;flex-direction:column;min-width:220px}
.tl-menu button{border:0;text-align:left;padding:8px 10px;border-radius:6px;background:none}
.tl-menu button:hover{background:var(--accent-weak)}
.tl-form{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 10px;align-items:center;margin:10px 0}
.tl-form input:not([type=checkbox]):not([type=radio]):not([type=color]),.tl-form select,.tl-form textarea{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 7px;min-width:0;width:100%}
.tl-form .full{grid-column:1/-1}
.tl-form .lbl{font-size:12px}
.tl-three{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.tl-warn{background:color-mix(in srgb,#ffd43b 22%,transparent);border:1px solid #e0b100;border-radius:8px;padding:8px 10px;font-size:13px}
@media (max-width:700px){body.m-menu #gDoc{display:flex}.tl-form{grid-template-columns:1fr}.tl-form > span:empty{display:none}#findbar{left:8px;right:8px;bottom:8px}#findbar input{flex:1;width:auto}.tl-three{grid-template-columns:1fr}}
`}));

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
function toolButton(tool, label, title) {
  const b = el('button', {textContent: label, title});
  b.dataset.tool = tool;
  b.onclick = () => { finishEditing(); setTool(tool); phoneMenu(null); };
  return b;
}
$('#tools [data-tool="whiteout"]').after(toolButton('redact', 'Redact', 'Redact: drag over anything to remove it for good. When you save, the text and images under the black boxes are deleted from the file, not just covered.'));
$('#tools [data-tool="highlight"]').after(
  toolButton('strike', 'Strike', 'Strikethrough: drag across text (or click a word) to strike it out'),
  toolButton('underline', 'Underline', 'Underline: drag across text (or click a word) to underline it'));
$('#tools [data-tool="date"]').after(toolButton('note', 'Comment', 'Comment: click to add a sticky note. It is saved as a real PDF comment that Acrobat, Edge and Chrome show.'));
Object.assign(HINTS, {
  highlight: 'Drag across text to highlight it; it snaps to the letters. On a picture or unread scan it highlights the box you drag. Double-click a highlight to add a comment.',
  redact: 'Drag over anything to redact it. On Save, those pages are rebuilt as flat images with the black boxes burned in, so the hidden text can’t be copied or recovered. Ctrl+F finds words to redact everywhere.',
  strike: 'Drag across text, or click a word, to strike it out (uses the color picker; black means red). Double-click it to add a comment.',
  underline: 'Drag across text, or click a word, to underline it (uses the color picker; black means blue). Double-click it to add a comment.',
  note: 'Click where the comment goes. Double-click a comment to read or change it.',
  crop: 'Drag a box around the part of the page to keep.',
});

function menuButton(label, title, items) {
  const b = el('button', {innerHTML: label + ' &#9662;', title});
  b.onclick = e => { e.stopPropagation(); showMenu(b, items()); };
  return b;
}
let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
function showMenu(anchor, items) {
  closeMenu();
  const m = el('div', {className: 'tl-menu'});
  for (const [label, fn] of items) m.append(el('button', {textContent: label, onclick: () => { closeMenu(); phoneMenu(null); fn(); }}));
  document.body.append(m); openMenu = m;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
}
addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);

const docBtns = [
  el('button', {textContent: 'Find', id: 'bFind', title: 'Find text in the document (Ctrl+F)', onclick: () => { phoneMenu(null); openFind(); }}),
  el('button', {textContent: 'OCR', id: 'bOcr', title: 'Read the text in scans and photos (OCR), so it can be searched, copied and redacted', onclick: () => { phoneMenu(null); ocrDialog(); }}),
  el('button', {textContent: 'Print', id: 'bPrint', title: 'Print the document with your changes (Ctrl+P)', onclick: () => { phoneMenu(null); printDoc(); }}),
  menuButton('Pages', 'Insert, extract, split and crop pages', () => [
    ['Insert a blank page at the end', () => insertBlank(S.pages.length - 1)],
    ['Extract or split pages…', extractDialog],
    ['Crop pages…', startCrop],
    ...(S.pages.some(p => p.full) ? [['Remove all crops', uncropAll]] : []),
  ]),
  menuButton('Stamp', 'Page numbers, headers, footers, Bates numbers and watermarks', () => [
    ['Page numbers, headers and footers…', headerFooterDialog],
    ['Watermark…', watermarkDialog],
  ]),
  el('button', {textContent: 'Protect', id: 'bProtect', title: 'Save a copy that needs a password to open, and optionally block printing, copying or editing', onclick: () => { phoneMenu(null); protectDialog(); }}),
  el('button', {textContent: 'Smaller file', id: 'bShrink', title: 'Save a copy with smaller pictures and scans, for email', onclick: () => { phoneMenu(null); shrinkDialog(); }}),
];
const gDoc = el('div', {className: 'grp edit-only', id: 'gDoc'}, ...docBtns);
gDoc.dataset.label = 'Document';
$('#gEdit').before(gDoc);

EXT.updateUI = has => {
  docBtns.forEach(b => b.disabled = !has);
  if (find.open && find.hits.length && !document.querySelector('.findlayer')) drawFindHits();
  S.sources.forEach((s, si) => { if (!scanChecked.has(s)) { scanChecked.add(s); suggestOcr(si); } });
};

// ---------- small helpers ----------
const baseName = () => (S.sources[S.pages[0]?.src]?.name || 'document.pdf').replace(/\.pdf$/i, '');
const mb = n => n < 1e6 ? Math.round(n / 1e3) + ' KB' : (n / 1e6).toFixed(1) + ' MB';
function viewSize(p) { const {W, H, R} = dims(p); return R % 180 ? [H, W] : [W, H]; }
// a point as seen on screen (points from the page's top-left, after rotation) in overlay space
function viewToUV(p, x, y) { const {W, H, R} = dims(p); return {0: [x, y], 90: [y, H - x], 180: [W - x, H - y], 270: [W - y, x]}[R]; }
async function saveBytes(bytes, name) {
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({suggestedName: name, types: [{description: 'PDF', accept: {'application/pdf': ['.pdf']}}]});
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      toast('Saved ' + h.name); return true;
    } catch (e) { if (e.name === 'AbortError') return false; console.warn('save picker failed, downloading instead', e); }
  }
  download(bytes, name); toast('Downloaded ' + name); return true;
}
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'})), download: name});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function built(msg, opts) {
  finishEditing(); busy(msg);
  try { return await buildPdf(opts); }
  catch (e) { console.error(e); toast('Could not build the PDF: ' + e.message, true); return null; }
  finally { busy(); }
}
// "1-3, 5, 8-" -> [[1,3],[5,5],[8,n]] (1-based), or a message saying what's wrong
function parseRanges(str, n) {
  const out = [];
  for (const part of str.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(?:(-)\s*(\d*))?$/);
    if (!m || (!m[1] && !m[3])) return `"${part}" isn't a page or range like 2-5`;
    const a = m[1] ? +m[1] : 1, b = m[2] ? (m[3] ? +m[3] : n) : a;
    if (a < 1 || b > n || a > b) return `"${part}" is outside pages 1 to ${n}`;
    out.push([a, b]);
  }
  return out.length ? out : 'Enter at least one page';
}
const rangePages = rs => [...new Set(rs.flatMap(([a, b]) => Array.from({length: b - a + 1}, (_, i) => a + i - 1)))];

// A dialog from an HTML form; resolves with the clicked button's value (or null) and the dialog,
// so the caller can read its inputs. Labels are fixed strings; user text is only ever set as .value,
// by init(d) before the dialog shows.
function dialog(title, html, buttons, check, init) {
  const d = el('dialog', {className: 'sg-dlg wide'});
  d.innerHTML = `<h3></h3><div class="body">${html}</div><div class="sg-err"></div><div class="row tl-btns" style="justify-content:flex-end"></div>`;
  d.querySelector('h3').textContent = title;
  document.body.append(d);
  return new Promise(res => {
    const row = d.querySelector('.tl-btns');
    for (const [value, label, primary] of buttons) row.append(el('button', {textContent: label, className: primary ? 'primary' : '', onclick: () => {
      if (value && check) { const err = check(value, d); if (err) { d.querySelector('.sg-err').textContent = err; return; } }
      d.close(); d.remove(); res({value, d});
    }}));
    d.addEventListener('cancel', () => { d.remove(); res({value: null, d}); });
    init?.(d);
    d.showModal();
    d.querySelector('input, textarea, select')?.focus();
  });
}
const val = (d, id) => d.querySelector('#' + id).value;
const checked = (d, id) => d.querySelector('#' + id).checked;

// ---------- Redact ----------
EXT.tools.redact = (p, u, v, e) => { startRect(p, u, v, e); p.objs.at(-1).color = '#000000'; };
EXT.draw.redact = (pg, o, view, {L, rotate}) => {
  const [x, y] = L(0, o.h);
  pg.drawRectangle({x, y, width: o.w, height: o.h, rotate, color: rgb(0, 0, 0)});
};
// Pages with redactions are rendered to an image with the black boxes painted in, then the page's
// content, comments, links and form fields are replaced by that image. Same page object, so
// bookmarks and links into it keep working; dropUnreachable then removes the old content.
async function burnRedactions(doc, bytes, idxs) {
  const js = await pdfjsLib.getDocument({data: bytes.slice(), standardFontDataUrl: STD_FONTS}).promise;
  try {
    const form = hasForm(doc) ? doc.getForm() : null, ctx = doc.context;
    for (const i of idxs) {
      const pg = await js.getPage(i + 1), one = pg.getViewport({scale: 1, rotation: 0});
      const k = Math.min(200 / 72, Math.sqrt(16e6 / (one.width * one.height)));
      const vp = pg.getViewport({scale: k, rotation: 0});
      const c = el('canvas', {width: Math.round(vp.width), height: Math.round(vp.height)}), cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await pg.render({canvasContext: cx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE}).promise;
      cx.fillStyle = '#000';
      for (const o of S.pages[i].objs) if (o.type === 'redact') {
        cx.save(); cx.translate(o.x * k, o.y * k); cx.rotate(-(o.rot || 0) * Math.PI / 180);
        cx.fillRect(-1, -1, o.w * k + 2, o.h * k + 2); cx.restore();
      }
      // every word not under a box stays, as invisible text over the image, so the page can still be searched
      const hidden = S.pages[i].objs.filter(o => o.type === 'redact').map(bounds);
      const keep = textWords((await pg.getTextContent()).items, pg.view).filter(w => !hidden.some(r => overlaps(r, bounds(w))));
      const jpg = await doc.embedJpg(c.toDataURL('image/jpeg', 0.92));
      const page = doc.getPage(i), node = page.node, crop = page.getCropBox();
      // a form field with a box on this page could still hold the redacted text as its value
      if (form) {
        const here = new Set(), a = node.Annots();
        if (a) for (let j = 0; j < a.size(); j++) here.add(ctx.lookup(a.get(j)));
        for (const f of form.getFields())
          if (f.acroField.getWidgets().some(w => here.has(w.dict) || w.P() === page.ref)) removeFormField(doc, form, f);
      }
      for (const key of ['Thumb', 'PieceInfo', 'Metadata', 'StructParents', 'Group']) node.delete(N(key));
      // in the shapes pdf-lib expects, so comments and OCR text can still be added to the page
      node.set(N('Annots'), ctx.obj([]));
      node.set(N('Resources'), ctx.obj({XObject: {Redacted: jpg.ref}, Font: {}, ExtGState: {}}));
      node.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream(`q ${crop.width} 0 0 ${crop.height} ${crop.x} ${crop.y} cm /Redacted Do Q`))]));
      if (keep.length) writeInvisibleText(page, pg.view, keep, await invisibleFont(doc));
    }
    // the accessibility tree can carry the page's words as alternate text, so it goes too
    doc.catalog.delete(N('StructTreeRoot')); doc.catalog.delete(N('MarkInfo'));
  } finally { js.destroy(); }
}

// ---------- garbage collection ----------
// pdf-lib writes every object it has, reachable or not: without this, deleted pages and replaced
// content are still inside the saved file
function dropUnreachable(doc) {
  const ctx = doc.context, seen = new Set(), todo = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (todo.length) {
    let o = todo.pop(); if (!o) continue;
    if (o instanceof PDFLib.PDFRef) { if (seen.has(o.tag)) continue; seen.add(o.tag); o = ctx.lookup(o); if (!o) continue; }
    if (o instanceof PDFLib.PDFStream) o = o.dict;
    if (o instanceof PDFLib.PDFDict) for (const [, v] of o.entries()) todo.push(v);
    else if (o instanceof PDFLib.PDFArray) for (const v of o.asArray()) todo.push(v);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

// ---------- the last pass over every built PDF ----------
EXT.finish = async (doc, opts, entries) => {
  const bytes = await doc.save();
  const out = await PDFDocument.load(bytes, {updateMetadata: false});
  const red = S.pages.flatMap((p, i) => p.objs.some(o => o.type === 'redact') ? [i] : []);
  dropComments(out);
  if (red.length) await burnRedactions(out, bytes, red);
  await addOcrText(out, entries);
  addComments(out, entries);
  dropUnreachable(out);
  return out.save({updateFieldAppearances: false});
};

// ---------- Highlight, strikethrough, underline ----------
// Real PDF text markup (Highlight, StrikeOut and Underline annotations), like Acrobat's: they snap to
// the characters under the drag (the PDF's text, or OCR words), show in any reader's comments list and
// can carry a comment of their own (double-click). Where there is no text (a picture, an unread scan)
// the dragged box itself is marked. One 'markup' object per drag; its quads are boxes measured from its
// corner (x, y), each with its own rotation, so it moves, copies and pastes like anything else.
const MARK_COLORS = {highlight: '#ffe600', strike: '#e03131', underline: '#1971c2'};
const MARK_TYPES = {highlight: 'Highlight', strike: 'StrikeOut', underline: 'Underline'};
const MARK_NAMES = {highlight: 'Highlight', strike: 'Strikethrough', underline: 'Underline'};
EXT.tools.highlight = EXT.tools.strike = EXT.tools.underline = (p, u0, v0, e) => {
  const kind = S.tool, tmp = {id: uid(), type: 'highlight', x: u0, y: v0, w: 0, h: 0, rot: 0, color: '#74c0fc'};
  p.objs.push(tmp);
  drag(e, ev => {
    const [u, v] = toUV(p, ev.clientX, ev.clientY);
    Object.assign(tmp, {x: Math.min(u, u0), y: Math.min(v, v0), w: Math.abs(u - u0), h: Math.abs(v - v0)});
    redraw(p);
  }, async () => {
    p.objs.splice(p.objs.indexOf(tmp), 1);
    let quads = await textQuads(p, tmp);
    if (!quads.length && tmp.w >= 4 && tmp.h >= 2) quads = [{x: tmp.x, y: tmp.y, w: tmp.w, h: tmp.h, rot: 0}];
    if (!quads.length) { redraw(p); return toast('No text there. Drag across the words to mark.'); }
    const o = makeMarkup(kind, quads, props.color !== '#000000' ? props.color : MARK_COLORS[kind]);
    authorName().then(n => { o.author ||= n; });
    pushUndo(); p.objs.push(o); redraw(p);
  });
};
function makeMarkup(kind, quads, color, extra) {
  const b = quads.map(bounds), x = Math.min(...b.map(q => q[0])), y = Math.min(...b.map(q => q[1]));
  return {id: uid(), type: 'markup', kind, color, x, y, w: Math.max(...b.map(q => q[2])) - x, h: Math.max(...b.map(q => q[3])) - y,
    quads: quads.map(q => ({x: q.x - x, y: q.y - y, w: q.w, h: q.h, rot: q.rot || 0})), text: '', author: '', at: Date.now(), ...extra};
}
// a quad's corners in overlay space: top-left, top-right, bottom-right, bottom-left
function quadCorners(o, q) {
  return [[0, 0], [q.w, 0], [q.w, q.h], [0, q.h]].map(([a, b]) => { const [dx, dy] = rotVec(a, b, q.rot); return [o.x + q.x + dx, o.y + q.y + dy]; });
}
const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
const LINE_AT = {strike: 0.55, underline: 0.92};   // where the line runs, as a share of the box height
EXT.build.markup = (o, p, isSel) => {
  const {W, H} = dims(p), svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'vec markup' + (isSel ? ' sel' : '')); svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.dataset.oid = o.id;
  const add = (tag, at) => { const e = document.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); svg.append(e); return e; };
  for (const q of o.quads) {
    const c = quadCorners(o, q), pts = c.map(pt => pt.join(',')).join(' ');
    if (o.kind === 'highlight') add('polygon', {points: pts, fill: o.color, 'fill-opacity': 0.5, style: 'mix-blend-mode:multiply'});
    else { const f = LINE_AT[o.kind], a = lerp(c[0], c[3], f), b = lerp(c[1], c[2], f); add('line', {x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: o.color, 'stroke-width': Math.max(0.6, q.h * 0.07)}); }
    add('polygon', {points: pts, class: 'hit', fill: 'transparent'});
  }
  // the whole mark's box: Delete/Copy sit above it, and it outlines the mark when selected
  add('path', {class: 'vis', d: `M${o.x} ${o.y}h${o.w}v${o.h}h${-o.w}z`, stroke: 'none'});
  if (isSel) add('rect', {class: 'bbox', x: o.x - 2, y: o.y - 2, width: o.w + 4, height: o.h + 4});
  if (o.text) svg.append(Object.assign(document.createElementNS(NS, 'title'), {textContent: (o.author ? o.author + ': ' : '') + o.text}));
  return svg;
};
EXT.draw.markup = () => {};   // saved as a real annotation by addComments
// the characters under box r, snapped to their edges; a click (tiny box) takes the whole run or word
async function textQuads(p, r) {
  const tc = await textContent(p), out = [], click = r.w < 2 && r.h < 2, near = [];
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([u, v]) => [p.view[0] + u, p.view[3] - v]);
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !it.width) continue;
    const F = itemFrame(p, it), pr = corners.map(([x, y]) => F.proj(x, y));
    const a0 = Math.min(...pr.map(q => q[0])), a1 = Math.max(...pr.map(q => q[0]));
    const p0 = Math.min(...pr.map(q => q[1])), p1 = Math.max(...pr.map(q => q[1]));
    if (a1 < 0 || a0 > it.width) continue;
    // how far the drag is above or below the letters (0 when it touches them)
    const gap = p1 < -0.2 * F.h ? -0.2 * F.h - p1 : p0 > 0.9 * F.h ? p0 - 0.9 * F.h : 0;
    if (gap > (click ? 0 : 0.5 * F.h)) continue;
    near.push({it, F, a0, a1, gap});
  }
  // a drag touching text marks what it touches; one just off the letters marks only the nearest line
  const best = Math.min(...near.map(n => n.gap));
  for (const {it, F, a0, a1, gap} of near) {
    if (gap > best + 1) continue;
    const edges = charEdges(it);
    let i0 = click ? 0 : Math.max(0, edges.findLastIndex(x => x <= Math.max(0, a0) + 0.5));
    let i1 = click ? it.str.length : edges.findIndex(x => x >= Math.min(it.width, a1) - 0.5);
    if (i1 < 0) i1 = it.str.length;
    while (i0 < i1 && it.str[i0] === ' ') i0++;
    while (i1 > i0 && it.str[i1 - 1] === ' ') i1--;
    if (i1 <= i0) continue;
    out.push(textBox(F, edges[i0], edges[i1]));
    if (click) return out;
  }
  const rb = click ? [r.x - 1, r.y - 1, r.x + 1, r.y + 1] : [r.x, r.y, r.x + r.w, r.y + r.h];
  for (const o of p.objs) if (o.type === 'ocr') for (const w of o.words) {
    const box = {x: o.x + w.x, y: o.y + w.y, w: w.w, h: w.h, rot: o.rot};
    if (overlaps(rb, bounds(box))) out.push(box);
  }
  return out;
}
// where each character of a text item starts along its baseline (Arial widths, scaled to the item)
function charEdges(it) {
  const full = measureCtx.measureText(it.str).width || 1;
  return Array.from({length: it.str.length + 1}, (_, i) => it.width * measureCtx.measureText(it.str.slice(0, i)).width / full);
}
// the box from a to b along a text item's baseline, ascender to descender, in overlay space
function textBox(F, a, b) {
  const top = F.h * 0.9, bot = -F.h * 0.22, [x, y] = F.toUv(F.local(a, top));
  return {x, y, w: b - a, h: top - bot, rot: F.rot};
}
// every word of some pdf.js text items, as boxes in overlay space of a page whose crop box is view
function textWords(items, view) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.width) continue;
    const F = itemFrame({view}, it), edges = charEdges(it);
    for (const m of it.str.matchAll(/\S+/g)) out.push({t: m[0], ...textBox(F, edges[m.index], edges[m.index + m[0].length])});
  }
  return out;
}
// geometry of a pdf.js text item: its baseline frame in page space and a mapper into overlay space
function itemFrame(p, it) {
  const [a, b, c, d, e, f] = it.transform, th = Math.atan2(b, a), h = Math.hypot(c, d) || it.height;
  const local = (al, pe) => [e + al * Math.cos(th) - pe * Math.sin(th), f + al * Math.sin(th) + pe * Math.cos(th)];
  const proj = (x, y) => [(x - e) * Math.cos(th) + (y - f) * Math.sin(th), -(x - e) * Math.sin(th) + (y - f) * Math.cos(th)];
  const toUv = ([x, y]) => [x - p.view[0], p.view[3] - y];
  return {th, h, local, proj, toUv, rot: Math.round(th * 180 / Math.PI * 100) / 100};
}
// ---------- Comments ----------
const NOTE_ICON = '<svg viewBox="0 0 24 24"><path d="M4 4h16v12H8l-4 4z" fill="#fff" stroke="#7a5d00" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 8.5h8M8 12h5" stroke="#7a5d00" stroke-width="1.6" stroke-linecap="round"/></svg>';
let authorP = null;
// who is commenting: a name typed earlier, else the signed-in user when the host has one (Azure
// Static Web Apps and App Service answer /.auth/me), else blank
function authorName() {
  return authorP ||= (async () => {
    try { const n = localStorage.getItem('pdfedit.author'); if (n) return n; } catch {}
    if (location.protocol !== 'file:') try {   // the offline copy has no host to ask
      const r = await fetch('/.auth/me', {credentials: 'same-origin'});
      if (r.ok && /json/.test(r.headers.get('content-type') || '')) {
        const j = await r.json(), cp = j.clientPrincipal || j[0];
        const name = cp?.claims?.find?.(c => c.typ === 'name')?.val || cp?.userDetails || cp?.user_id;
        if (name) return name;
      }
    } catch {}
    return '';
  })();
}
async function editNote(p, o) {
  const who = o ? o.author : await authorName();
  const {value, d} = await dialog(o?.type === 'markup' ? MARK_NAMES[o.kind] + ' comment' : o ? 'Comment' : 'Add a comment', `
    <div class="tl-form">
      <textarea id="nText" class="full" rows="5" placeholder="Type your comment"></textarea>
      <label for="nWho">Your name</label><input id="nWho" placeholder="Shown with your comments">
    </div>${o ? '<div class="lbl" id="nWhen"></div>' : ''}`,
    [[null, 'Cancel'], ...(o ? [['delete', 'Delete']] : []), ['ok', o ? 'Save' : 'Add', true]],
    (v, d) => v === 'ok' && o?.type !== 'markup' && !d.querySelector('#nText').value.trim() ? 'Type a comment first' : null,
    d => {
      d.querySelector('#nText').value = o?.text || '';
      d.querySelector('#nWho').value = who || '';
      if (o) d.querySelector('#nWhen').textContent = (o.author ? o.author + ', ' : '') + new Date(o.at).toLocaleString();
    });
  // the dialog is gone by now; its inputs still hold what was typed
  return value && {value, text: val(d, 'nText').trim(), who: val(d, 'nWho').trim()};
}
EXT.tools.note = async (p, u, v, e, R) => {
  const r = await editNote(p, null);
  if (!r || r.value !== 'ok') return;
  rememberAuthor(r.who);
  const [dx, dy] = rotVec(-10, -10, R);
  const o = {id: uid(), type: 'note', x: u + dx, y: v + dy, w: 20, h: 20, rot: R, text: r.text, author: r.who, at: Date.now(), fill: '#ffd43b'};
  pushUndo(); p.objs.push(o); select(p, o);
};
function rememberAuthor(who) {
  authorP = Promise.resolve(who);
  try { who ? localStorage.setItem('pdfedit.author', who) : localStorage.removeItem('pdfedit.author'); } catch {}
}
EXT.build.note = (o, p, isSel) => {
  if (o.irt) return el('span', {hidden: true});   // a reply shows in the Comments list, not on the page
  const e = el('div', {className: 'obj note' + (isSel ? ' sel' : ''), innerHTML: NOTE_ICON, title: (o.author ? o.author + ': ' : '') + o.text});
  e.dataset.oid = o.id;
  Object.assign(e.style, {left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px', background: o.fill});
  if (o.rot) e.style.transform = `rotate(${-o.rot}deg)`;
  return e;
};
EXT.draw.note = () => {};   // saved as a real comment by addComments, not drawn on the page
$('#pages').addEventListener('dblclick', async e => {
  const oel = e.target.closest('[data-oid]'), pageEl = e.target.closest('.page');
  if (!oel || !pageEl || S.mode !== 'edit') return;
  const p = pageById(+pageEl.dataset.pid), o = p?.objs.find(o => o.id === +oel.dataset.oid);
  if (o?.type !== 'note' && o?.type !== 'markup') return;
  const r = await editNote(p, o);
  if (!r?.value) return;
  pushUndo();
  if (r.value === 'delete') { p.objs.splice(p.objs.indexOf(o), 1); S.sel = null; }
  else { o.text = r.text; o.author = r.who; rememberAuthor(r.who); }
  redraw(p); updateUI();
});
// Notes and marks become annotations. Replies point at what they answer (/IRT): one of ours by its
// object id, or one already in the PDF by its object number (only pages of the first file keep theirs).
function addComments(doc, entries) {
  const ctx = doc.context, refs = new Map(), baseSrc = S.pages[0].src;
  const items = S.pages.flatMap((p, i) => p.objs.filter(o => o.type === 'note' || o.type === 'markup').map(o => ({p, i, o})));
  items.sort((a, b) => !!a.o.irt - !!b.o.irt);
  for (const {p, i, o} of items) {
    const view = entries[i].view, page = doc.getPage(i), toPdf = ([u, v]) => [view[0] + u, view[3] - v];
    let annot;
    if (o.type === 'note') {
      const pts = [[0, 0], [o.w, 0], [0, o.h], [o.w, o.h]].map(([a, b]) => { const [dx, dy] = rotVec(a, b, o.rot || 0); return toPdf([o.x + dx, o.y + dy]); });
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), c = hexRgb(o.fill || '#ffd43b');
      annot = ctx.obj({Type: 'Annot', Subtype: 'Text', Name: 'Comment', F: 4, Open: false,
        Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], C: [c.red, c.green, c.blue]});
    } else {
      const quads = o.quads.map(q => quadCorners(o, q).map(toPdf)), all = quads.flat(), c = hexRgb(o.color);
      const rect = [Math.min(...all.map(q => q[0])) - 1, Math.min(...all.map(q => q[1])) - 1, Math.max(...all.map(q => q[0])) + 1, Math.max(...all.map(q => q[1])) + 1];
      annot = ctx.obj({Type: 'Annot', Subtype: MARK_TYPES[o.kind], F: 4, Rect: rect, C: [c.red, c.green, c.blue], CA: 1,
        QuadPoints: quads.flatMap(([tl, tr, br, bl]) => [...tl, ...tr, ...bl, ...br])});
      annot.set(N('AP'), ctx.obj({N: markupAppearance(ctx, o, quads, rect, c)}));
    }
    if (o.text) annot.set(N('Contents'), PDFLib.PDFHexString.fromText(o.text));
    annot.set(N('T'), PDFLib.PDFHexString.fromText(o.author || ''));
    annot.set(N('M'), PDFLib.PDFString.fromDate(new Date(o.at)));
    if (o.irt) {
      const parent = o.irt.id != null ? refs.get(o.irt.id) : p.src === baseSrc ? pdfRef(ctx, o.irt.ref) : null;
      if (parent) { annot.set(N('IRT'), parent); annot.set(N('RT'), N('R')); }
    }
    const ref = ctx.register(annot);
    refs.set(o.id, ref); page.node.addAnnot(ref);
  }
}
// "12R" (pdf.js's annotation id) to that object, if it is an annotation in this file
function pdfRef(ctx, id) {
  const m = /^(\d+)R(\d*)$/.exec(id || ''); if (!m) return null;
  const ref = PDFLib.PDFRef.of(+m[1], +(m[2] || 0)), o = ctx.lookup(ref);
  return o instanceof PDFLib.PDFDict && o.get(N('Subtype')) ? ref : null;
}
// what readers draw for a mark: a multiplied fill for highlights, a line for the others
function markupAppearance(ctx, o, quads, rect, c) {
  const col = `${c.red} ${c.green} ${c.blue}`, f = n => +n.toFixed(2);
  let ops;
  if (o.kind === 'highlight') ops = `/GS0 gs ${col} rg ` + quads.map(([tl, tr, br, bl]) => `${f(tl[0])} ${f(tl[1])} m ${f(tr[0])} ${f(tr[1])} l ${f(br[0])} ${f(br[1])} l ${f(bl[0])} ${f(bl[1])} l h f`).join(' ');
  else ops = `${col} RG ` + quads.map(([tl, tr, br, bl]) => {
    const a = lerp(tl, bl, LINE_AT[o.kind]), b = lerp(tr, br, LINE_AT[o.kind]), h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    return `${f(Math.max(0.6, h * 0.07))} w ${f(a[0])} ${f(a[1])} m ${f(b[0])} ${f(b[1])} l S`;
  }).join(' ');
  return ctx.register(ctx.flateStream(ops, {Type: 'XObject', Subtype: 'Form', BBox: rect,
    Resources: {ExtGState: {GS0: {Type: 'ExtGState', BM: 'Multiply'}}}}));
}
// comments already in the PDF that someone removed in the Comments list (pages of the first file only)
function dropComments(doc) {
  const ctx = doc.context, baseSrc = S.pages[0].src;
  S.pages.forEach((p, i) => {
    if (!p.dropAnnots?.length || p.src !== baseSrc) return;
    const gone = new Set(p.dropAnnots.map(id => pdfRef(ctx, id)?.tag).filter(Boolean)), annots = doc.getPage(i).node.Annots();
    if (!annots) return;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const r = annots.get(k), a = ctx.lookup(r), parent = a instanceof PDFLib.PDFDict && a.get(N('Parent'));
      if (gone.has(r.tag) || (parent instanceof PDFLib.PDFRef && gone.has(parent.tag))) annots.remove(k);   // its popup goes too
    }
  });
}

// ---------- Find ----------
const findBar = el('div', {id: 'findbar', hidden: true});
findBar.innerHTML = `<input id="findQ" placeholder="Find in document" autocomplete="off"><span id="findCount" class="lbl"></span>
  <button id="findPrev" title="Previous (Shift+Enter)">&#8593;</button><button id="findNext" title="Next (Enter)">&#8595;</button>
  <button id="findHl" class="edit-only" title="Highlight every match">Highlight all</button>
  <button id="findRed" class="edit-only" title="Mark every match for redaction (removed for good on Save)">Redact all</button>
  <button id="findX" title="Close (Esc)">&times;</button>`;
document.body.append(findBar);
function openFind() {
  if (!S.pages.length) return;
  find.open = true; findBar.hidden = false;
  const q = $('#findQ'); q.focus(); q.select();
  if (q.value) runFind();
}
function closeFind() {
  find.open = false; findBar.hidden = true; find.hits = []; find.cur = -1;
  document.querySelectorAll('.findlayer').forEach(l => l.remove());
}
$('#findX').onclick = closeFind;
$('#findQ').oninput = () => { clearTimeout(find.timer); find.timer = setTimeout(runFind, 200); };
$('#findQ').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(find.timer); if (find.timer && !find.hits.length) runFind(); else step(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
};
$('#findNext').onclick = () => step(1); $('#findPrev').onclick = () => step(-1);
$('#findHl').onclick = () => markAll('highlight');
$('#findRed').onclick = () => markAll('redact');
const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '10px Arial, Helvetica, sans-serif';
async function runFind() {
  find.timer = null;
  const q = $('#findQ').value.trim();
  find.hits = []; find.cur = -1;
  if (q) {
    const re = new RegExp(q.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi');
    for (const p of S.pages) {
      const tc = await textContent(p);
      // the page's text as one string, with each character's text item and position in it
      let str = ''; const at = [];
      tc.items.forEach((it, k) => {
        if (it.str) { for (let j = 0; j < it.str.length; j++) at.push([k, j]); str += it.str; }
        if (it.hasEOL) { at.push(null); str += ' '; }
      });
      for (const m of str.matchAll(re)) {
        if (!m[0].length) continue;
        const segs = new Map();   // item -> [first char, last char + 1]
        for (let c = m.index; c < m.index + m[0].length; c++) {
          const a = at[c]; if (!a) continue;
          const s = segs.get(a[0]); segs.set(a[0], s ? [s[0], a[1] + 1] : [a[1], a[1] + 1]);
        }
        const rects = [...segs].map(([k, [a, b]]) => charRect(p, tc.items[k], a, b)).filter(Boolean);
        if (rects.length) find.hits.push({pid: p.id, rects});
      }
      // words read by OCR, the same way (one space between words)
      for (const o of p.objs) if (o.type === 'ocr') {
        let ostr = ''; const oat = [];
        o.words.forEach((w, k) => { for (let j = 0; j < w.t.length; j++) oat.push([k, j]); ostr += w.t; oat.push(null); ostr += ' '; });
        for (const m of ostr.matchAll(re)) {
          if (!m[0].length) continue;
          const segs = new Map();
          for (let c = m.index; c < m.index + m[0].length; c++) {
            const a = oat[c]; if (!a) continue;
            const s = segs.get(a[0]); segs.set(a[0], s ? [s[0], a[1] + 1] : [a[1], a[1] + 1]);
          }
          const rects = [...segs].map(([k, [a, b]]) => ocrRect(o, o.words[k], a, b));
          if (rects.length) find.hits.push({pid: p.id, rects});
        }
      }
    }
  }
  find.cur = find.hits.length ? 0 : -1;
  drawFindHits(); showCount(); scrollToHit();
}
// a box around characters a..b of a text item, in overlay space (sized like Edit text's cover)
function charRect(p, it, a, b) {
  if (!it.width) return null;
  const F = itemFrame(p, it), full = measureCtx.measureText(it.str).width || 1;
  const x0 = it.width * measureCtx.measureText(it.str.slice(0, a)).width / full;
  const x1 = it.width * measureCtx.measureText(it.str.slice(0, b)).width / full;
  const pad = Math.max(1, F.h * 0.12), top = F.h * 0.95 + pad, bot = -F.h * 0.25 - pad;
  const [x, y] = F.toUv(F.local(x0 - pad, top));
  return {x, y, w: x1 - x0 + 2 * pad, h: top - bot, rot: F.rot};
}
function showCount() {
  $('#findCount').textContent = !$('#findQ').value.trim() ? '' : find.hits.length ? `${find.cur + 1} of ${find.hits.length}` : 'No matches';
  ['#findPrev', '#findNext', '#findHl', '#findRed'].forEach(s => $(s).disabled = !find.hits.length);
}
function drawFindHits() {
  document.querySelectorAll('.findlayer').forEach(l => l.remove());
  if (!find.open) return;
  const cur = find.hits[find.cur];
  for (const [pid, d] of DOM) {
    const hits = find.hits.filter(h => h.pid === pid); if (!hits.length) continue;
    const layer = el('div', {className: 'findlayer'});
    Object.assign(layer.style, {width: d.ov.style.width, height: d.ov.style.height, transform: d.ov.style.transform});
    layer.style.setProperty('--s', S.scale);
    for (const h of hits) for (const r of h.rects) {
      const e = el('div', {className: 'findhit' + (h === cur ? ' cur' : '')});
      Object.assign(e.style, {left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px'});
      if (r.rot) e.style.transform = `rotate(${-r.rot}deg)`;
      layer.append(e);
    }
    d.el.append(layer);
  }
}
function step(dir) {
  if (!find.hits.length) return;
  find.cur = (find.cur + dir + find.hits.length) % find.hits.length;
  drawFindHits(); showCount(); scrollToHit();
}
function scrollToHit() { document.querySelector('.findhit.cur')?.scrollIntoView({block: 'center', inline: 'nearest'}); }
function markAll(type) {
  if (!find.hits.length || S.mode !== 'edit') return;
  finishEditing(); pushUndo();
  for (const h of find.hits) {
    const p = pageById(h.pid); if (!p) continue;
    if (type === 'redact') for (const r of h.rects) p.objs.push({id: uid(), type, ...r, color: '#000000'});
    else p.objs.push(makeMarkup('highlight', h.rects, MARK_COLORS.highlight));
  }
  const n = find.hits.length;
  closeFind(); S.pages.forEach(drawOverlay); updateUI();
  toast(type === 'redact' ? `Marked ${n} match${n > 1 ? 'es' : ''} for redaction. They are removed for good when you save.` : `Highlighted ${n} match${n > 1 ? 'es' : ''}`);
}

// ---------- Print ----------
async function printDoc() {
  if (!S.pages.length) return;
  const bytes = await built('Preparing to print...'); if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
  // phones and tablets can't print from a hidden frame: open the PDF and print from there
  if (matchMedia('(pointer: coarse)').matches) { open(url, '_blank'); return; }
  const f = el('iframe', {src: url});
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  f.onload = () => setTimeout(() => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { open(url, '_blank'); }
  }, 300);
  document.body.append(f);
  setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 10 * 60e3);
}
// Ctrl+P prints the document (with edits) instead of the editor screen; Ctrl+F opens Find
addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'p' && S.pages.length) { e.preventDefault(); e.stopImmediatePropagation(); printDoc(); }
  if (mod && k === 'f' && S.pages.length) { e.preventDefault(); e.stopImmediatePropagation(); openFind(); }
  if (e.key === 'Escape' && find.open && !e.target.closest('dialog')) closeFind();
}, true);

// ---------- Insert blank page ----------
EXT.thumbActs = (btn, p, i) => btn('+', 'Insert a blank page after this one', () => insertBlank(i));
async function insertBlank(after) {
  const ref = S.pages[after]; if (!ref) return;
  finishEditing();
  const [w, h] = viewSize(ref), d = await PDFDocument.create();
  d.addPage([w, h]);
  const bytes = await d.save(), js = await loadPdfjs(bytes, 'blank.pdf');
  const si = S.sources.push({name: S.sources[ref.src].name, bytes, js, pages: new Map(), text: new Map(), blank: true}) - 1;
  const pg = await getPage(si, 0);
  pageOp(() => S.pages.splice(after + 1, 0, {id: uid(), src: si, idx: 0, baseRot: 0, rot: 0, view: pg.view.slice(), objs: []}));
  await persistSources();
  toast(`Blank page inserted as page ${after + 2}`);
}

// ---------- Extract or split ----------
async function extractDialog() {
  const n = S.pages.length;
  const {value, d} = await dialog('Extract or split pages', `
    <div class="tl-form">
      <label class="chk full"><input type="radio" name="xMode" value="extract" checked> Extract these pages into one new file:</label>
      <span></span><input id="xRange" placeholder="for example 1-3, 5">
      <label class="chk full"><input type="radio" name="xMode" value="every"> Split into files of</label>
      <span></span><input id="xEvery" type="number" min="1" value="1" style="width:90px"> <span class="lbl full">pages each</span>
      <label class="chk full"><input type="radio" name="xMode" value="ranges"> Split into one file per range:</label>
      <span></span><input id="xRanges" placeholder="for example 1-4, 5-9, 10-">
    </div>
    <div class="lbl">This document has ${n} page${n > 1 ? 's' : ''}. Your edits are included and form answers are locked in. The original stays as it is.</div>`,
    [[null, 'Cancel'], ['ok', 'Save', true]],
    (v, d) => {
      const mode = d.querySelector('[name=xMode]:checked').value;
      if (mode === 'every') return +val(d, 'xEvery') >= 1 ? null : 'Enter how many pages per file';
      const r = parseRanges(val(d, mode === 'extract' ? 'xRange' : 'xRanges'), n);
      return typeof r === 'string' ? r : null;
    });
  if (value !== 'ok') return;
  const mode = d.querySelector('[name=xMode]:checked').value;
  let groups;
  if (mode === 'extract') groups = [rangePages(parseRanges(val(d, 'xRange'), n))];
  else if (mode === 'ranges') groups = parseRanges(val(d, 'xRanges'), n).map(r => rangePages([r]));
  else { const k = Math.floor(+val(d, 'xEvery')); groups = []; for (let a = 0; a < n; a += k) groups.push(Array.from({length: Math.min(k, n - a)}, (_, i) => a + i)); }
  const bytes = await built('Building pages...', {flatten: true}); if (!bytes) return;
  busy('Splitting...');
  const files = [];
  try {
    const src = await PDFDocument.load(bytes);
    for (const g of groups) {
      const out = await PDFDocument.create();
      (await out.copyPages(src, g)).forEach(pg => out.addPage(pg));
      const label = g.length === 1 ? `page-${g[0] + 1}` : `pages-${g[0] + 1}-${g.at(-1) + 1}`;
      files.push({name: `${baseName()}-${label}.pdf`, bytes: await out.save()});
    }
  } catch (e) { console.error(e); busy(); return toast('Could not split: ' + e.message, true); }
  busy();
  if (files.length === 1) return saveBytes(files[0].bytes, files[0].name);
  // several files: into a folder the person picks when the browser allows, otherwise downloads
  if (window.showDirectoryPicker) {
    try {
      const dir = await showDirectoryPicker({mode: 'readwrite'});
      for (const f of files) { const w = await (await dir.getFileHandle(f.name, {create: true})).createWritable(); await w.write(f.bytes); await w.close(); }
      return toast(`Saved ${files.length} files to ${dir.name}`);
    } catch (e) { if (e.name === 'AbortError') return; console.warn('folder save failed, downloading instead', e); }
  }
  for (const f of files) { download(f.bytes, f.name); await new Promise(r => setTimeout(r, 400)); }
  toast(`Downloaded ${files.length} files`);
}

// ---------- Crop ----------
// A crop moves the page's crop box (p.view); p.full keeps the original so it can be undone.
// Overlay space is measured from the crop box's corner, so everything placed on the page shifts with it.
function startCrop() { if (!S.pages.length) return; select(null); setTool('crop'); toast('Drag a box around the part of the page to keep'); }
EXT.tools.crop = (p, u0, v0, e) => {
  const d = DOM.get(p.id), box = el('div', {className: 'croprect'}); d.ov.append(box);
  let r = {x: u0, y: v0, w: 0, h: 0};
  drag(e, ev => {
    const [u, v] = toUV(p, ev.clientX, ev.clientY), {W, H} = dims(p);
    const cu = Math.max(0, Math.min(W, u)), cv = Math.max(0, Math.min(H, v));
    r = {x: Math.min(cu, u0), y: Math.min(cv, v0), w: Math.abs(cu - u0), h: Math.abs(cv - v0)};
    Object.assign(box.style, {left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px'});
  }, async () => {
    if (r.w < 10 || r.h < 10) { box.remove(); return; }
    const {value} = await dialog('Crop pages', '<p>Keep only the area in the box?</p><div class="lbl">Undo (Ctrl+Z) or Pages, Remove all crops puts it back.</div>',
      [[null, 'Cancel'], ['all', 'All pages'], ['one', 'This page', true]]);
    box.remove(); setTool('select');
    if (!value) return;
    pageOp(() => (value === 'all' ? S.pages : [p]).forEach(q => {
      const {W, H} = dims(q), x = Math.min(r.x, W - 10), y = Math.min(r.y, H - 10);
      cropPage(q, {x, y, w: Math.min(r.w, W - x), h: Math.min(r.h, H - y)});
    }));
  });
};
function shiftObjs(p, du, dv) {
  for (const o of p.objs) { if (o.type === 'ink') o.pts = o.pts.map(([a, b]) => [a + du, b + dv]); else { o.x += du; o.y += dv; } }
}
function cropPage(p, r) {
  const v = p.view;
  p.full ||= v.slice();
  p.view = [v[0] + r.x, v[3] - r.y - r.h, v[0] + r.x + r.w, v[3] - r.y];
  shiftObjs(p, -r.x, -r.y);
}
function uncropAll() {
  pageOp(() => S.pages.forEach(p => {
    if (!p.full) return;
    shiftObjs(p, p.view[0] - p.full[0], p.full[3] - p.view[3]);
    p.view = p.full; delete p.full;
  }));
}

// ---------- Page numbers, headers, footers, Bates ----------
// Stamps are ordinary text objects tagged with o.stamp, so they can be moved or deleted one by one,
// and running the dialog again replaces them.
function stampText(p, text, {font, size, bold, color, opacity}, place) {
  const o = {id: uid(), type: 'text', text, size, font, bold, color, rot: dims(p).R, stamp: place.stamp};
  if (opacity != null) o.opacity = opacity;
  const [VW, VH] = viewSize(p), w = textWidth(o), h = size * LH, m = place.margin;
  const x = place.align === 'left' ? m : place.align === 'right' ? VW - m - w : (VW - w) / 2;
  const y = place.vpos === 'top' ? m * 0.6 : VH - m * 0.6 - h;
  [o.x, o.y] = viewToUV(p, x, y);
  return o;
}
const HF_KEY = 'pdfedit.hf';
async function headerFooterDialog() {
  let last = {}; try { last = JSON.parse(localStorage.getItem(HF_KEY)) || {}; } catch {}
  const pos = ['hl', 'hc', 'hr', 'fl', 'fc', 'fr'];
  const has = S.pages.some(p => p.objs.some(o => o.stamp === 'hf'));
  const {value, d} = await dialog('Page numbers, headers and footers', `
    <div class="lbl">Type text for any spot. These fill in automatically: <b>{page}</b> page number, <b>{pages}</b> total pages, <b>{date}</b> today, <b>{file}</b> file name, <b>{bates}</b> Bates number.</div>
    <div class="tl-form">
      <span>Header</span><div class="tl-three"><input id="hl" placeholder="Left"><input id="hc" placeholder="Center"><input id="hr" placeholder="Right"></div>
      <span>Footer</span><div class="tl-three"><input id="fl" placeholder="Left"><input id="fc" placeholder="Center"><input id="fr" placeholder="Right"></div>
      <label for="hfFont">Font</label><div class="row" style="margin:0"><select id="hfFont" style="width:auto"><option value="helv">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select>
        <input id="hfSize" type="number" min="4" max="72" value="10" style="width:70px" title="Size in points"> <input id="hfColor" type="color" value="#000000"></div>
      <label for="hfMargin">Margin (inches)</label><input id="hfMargin" type="number" min="0.1" max="3" step="0.05" value="0.5" style="width:90px">
      <label for="hfStart">First page number</label><input id="hfStart" type="number" value="1" style="width:90px">
      <label for="hfRange">Pages</label><input id="hfRange" placeholder="All pages, or for example 2-10">
      <span>Bates numbers</span><div class="tl-three"><input id="bPrefix" placeholder="Prefix, e.g. SAN"><input id="bStart" type="number" min="0" value="1" title="Start at"><input id="bDigits" type="number" min="1" max="12" value="6" title="Digits"></div>
    </div>`,
    [[null, 'Cancel'], ...(has ? [['remove', 'Remove existing']] : []), ['ok', 'Apply', true]],
    (v, d) => {
      if (v !== 'ok') return null;
      if (!pos.some(k => val(d, k).trim())) return 'Type something in at least one spot';
      const r = val(d, 'hfRange').trim() && parseRanges(val(d, 'hfRange'), S.pages.length);
      return typeof r === 'string' ? r : null;
    },
    dl => {   // last time's settings; a first run starts with "Page 1 of 9" centered in the footer
      for (const k of pos) dl.querySelector('#' + k).value = last[k] ?? (k === 'fc' && !Object.keys(last).length ? 'Page {page} of {pages}' : '');
      for (const k of ['hfFont', 'hfSize', 'hfColor', 'hfMargin', 'bPrefix', 'bDigits']) if (last[k] != null) dl.querySelector('#' + k).value = last[k];
    });
  if (!value) return;
  finishEditing(); pushUndo();
  S.pages.forEach(p => p.objs = p.objs.filter(o => o.stamp !== 'hf'));
  if (value === 'ok') {
    const saved = {}; for (const k of [...pos, 'hfFont', 'hfSize', 'hfColor', 'hfMargin', 'bPrefix', 'bDigits']) saved[k] = val(d, k);
    try { localStorage.setItem(HF_KEY, JSON.stringify(saved)); } catch {}
    const r = val(d, 'hfRange').trim(), idxs = r ? rangePages(parseRanges(r, S.pages.length)) : S.pages.map((_, i) => i);
    const style = {font: val(d, 'hfFont'), size: +val(d, 'hfSize') || 10, bold: false, color: val(d, 'hfColor')};
    const margin = (+val(d, 'hfMargin') || 0.5) * 72, start = Math.round(+val(d, 'hfStart') || 1);
    const bStart = Math.round(+val(d, 'bStart') || 0), digits = Math.round(+val(d, 'bDigits') || 6), prefix = val(d, 'bPrefix').trim();
    const date = todayStr(), file = S.sources[S.pages[0].src].name.replace(/\.pdf$/i, '');
    idxs.forEach((pi, k) => {
      const p = S.pages[pi];
      const fill = t => t.replace(/\{page\}/gi, start + k).replace(/\{pages\}/gi, start + idxs.length - 1).replace(/\{date\}/gi, date)
        .replace(/\{file\}/gi, file).replace(/\{bates\}/gi, prefix + String(bStart + k).padStart(digits, '0'));
      for (const key of pos) {
        const t = val(d, key).trim(); if (!t) continue;
        p.objs.push(stampText(p, fill(t), style, {stamp: 'hf', margin, vpos: key[0] === 'h' ? 'top' : 'bottom', align: {l: 'left', c: 'center', r: 'right'}[key[1]]}));
      }
    });
    toast(`Added to ${idxs.length} page${idxs.length > 1 ? 's' : ''}. Each one can be moved or deleted like any text.`);
  }
  S.sel = null; S.pages.forEach(drawOverlay); updateUI();
}

// ---------- Watermark ----------
async function watermarkDialog() {
  const has = S.pages.some(p => p.objs.some(o => o.stamp === 'wm'));
  const {value, d} = await dialog('Watermark', `
    <div class="tl-form">
      <label for="wText">Text</label><input id="wText" value="CONFIDENTIAL">
      <label for="wFont">Font</label><div class="row" style="margin:0"><select id="wFont" style="width:auto"><option value="helv">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select>
        <label class="chk"><input type="checkbox" id="wBold" checked> Bold</label> <input id="wColor" type="color" value="#c92a2a"></div>
      <label for="wSize">Size</label><input id="wSize" placeholder="Automatic (fills the page)">
      <label for="wOpacity">See-through</label><select id="wOpacity"><option value="0.15">Very light</option><option value="0.25" selected>Light</option><option value="0.4">Medium</option><option value="0.7">Strong</option></select>
      <label for="wAngle">Direction</label><select id="wAngle"><option value="45">Diagonal</option><option value="0">Across</option></select>
      <label for="wRange">Pages</label><input id="wRange" placeholder="All pages, or for example 1-3">
    </div>`,
    [[null, 'Cancel'], ...(has ? [['remove', 'Remove existing']] : []), ['ok', 'Apply', true]],
    (v, d) => {
      if (v !== 'ok') return null;
      if (!val(d, 'wText').trim()) return 'Type the watermark text';
      const r = val(d, 'wRange').trim() && parseRanges(val(d, 'wRange'), S.pages.length);
      return typeof r === 'string' ? r : null;
    });
  if (!value) return;
  finishEditing(); pushUndo();
  S.pages.forEach(p => p.objs = p.objs.filter(o => o.stamp !== 'wm'));
  if (value === 'ok') {
    const r = val(d, 'wRange').trim(), idxs = r ? rangePages(parseRanges(r, S.pages.length)) : S.pages.map((_, i) => i);
    const angle = +val(d, 'wAngle'), fixed = parseFloat(val(d, 'wSize'));
    for (const pi of idxs) {
      const p = S.pages[pi], [VW, VH] = viewSize(p), R = dims(p).R;
      const o = {id: uid(), type: 'text', text: val(d, 'wText').trim(), font: val(d, 'wFont'), bold: checked(d, 'wBold'), color: val(d, 'wColor'),
        size: 100, opacity: +val(d, 'wOpacity'), rot: (R + angle) % 360, stamp: 'wm'};
      const span = angle ? Math.hypot(VW, VH) * 0.75 : VW * 0.85;
      o.size = fixed > 0 ? fixed : Math.max(8, Math.min(Math.round(100 * span / textWidth(o)), VH * 0.6));
      const [cu, cv] = viewToUV(p, VW / 2, VH / 2), [dx, dy] = rotVec(textWidth(o) / 2, o.size * LH / 2, o.rot);
      o.x = cu - dx; o.y = cv - dy;
      p.objs.push(o);
    }
    toast(`Watermark added to ${idxs.length} page${idxs.length > 1 ? 's' : ''}`);
  }
  S.sel = null; S.pages.forEach(drawOverlay); updateUI();
}

// ---------- Password protection (AES-256, PDF 2.0 / Acrobat X and later) ----------
async function protectDialog() {
  const {value, d} = await dialog('Protect with a password', `
    <div class="tl-form">
      <label for="pw1">Password to open</label><input id="pw1" type="password" autocomplete="new-password">
      <label for="pw2">Type it again</label><input id="pw2" type="password" autocomplete="new-password">
      <span class="full lbl">Also block (in readers that honor it, like Acrobat):</span>
      <span></span><div><label class="chk"><input type="checkbox" id="noPrint"> Printing</label>
        <label class="chk"><input type="checkbox" id="noCopy"> Copying text</label>
        <label class="chk"><input type="checkbox" id="noEdit"> Editing</label></div>
      <label for="pwOwner">Password to change these</label><input id="pwOwner" type="password" autocomplete="new-password" placeholder="Optional; must differ from the open password">
    </div>
    <div class="tl-warn">Write the password down. No one, including IT, can recover it or open the file without it.</div>`,
    [[null, 'Cancel'], ['ok', 'Save protected copy', true]],
    (v, d) => {
      if (val(d, 'pw1').length < 4) return 'Use a password of at least 4 characters';
      if (val(d, 'pw1') !== val(d, 'pw2')) return 'The two passwords don’t match';
      if (val(d, 'pwOwner') && val(d, 'pwOwner') === val(d, 'pw1')) return 'The second password must be different from the open password';
      return null;
    });
  if (value !== 'ok') return;
  const bytes = await built('Building...'); if (!bytes) return;
  busy('Encrypting...');
  let out;
  try {
    out = await encryptPdf(bytes, {user: val(d, 'pw1'), owner: val(d, 'pwOwner'),
      allow: {print: !checked(d, 'noPrint'), copy: !checked(d, 'noCopy'), edit: !checked(d, 'noEdit')}});
  } catch (e) { console.error(e); busy(); return toast('Could not protect the file: ' + e.message, true); }
  busy();
  saveBytes(out, baseName() + '-protected.pdf');
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const sha = async (alg, d) => new Uint8Array(await crypto.subtle.digest(alg, d));
// AES-CBC without padding (input is a whole number of blocks): Web Crypto always pads, so drop the extra block
async function aesNoPad(keyBytes, data, iv = new Uint8Array(16)) {
  const k = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv}, k, data)).slice(0, data.length);
}
// ISO 32000-2 algorithm 2.B (the revision 6 password hash)
async function hash2B(pw, salt, u) {
  let k = await sha('SHA-256', cat(pw, salt, u)), e = new Uint8Array(1), i = 0;
  while (i < 64 || e[e.length - 1] > i - 32) {
    const one = cat(pw, k, u), k1 = new Uint8Array(one.length * 64);
    for (let j = 0; j < 64; j++) k1.set(one, j * one.length);
    e = await aesNoPad(k.slice(0, 16), k1, k.slice(16, 32));
    let sum = 0; for (let j = 0; j < 16; j++) sum += e[j];
    k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], e);
    i++;
  }
  return k.slice(0, 32);
}
async function encryptPdf(bytes, {user, owner, allow}) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false}), ctx = doc.context;
  dropUnreachable(doc);
  const utf8 = s => new TextEncoder().encode(s.normalize('NFKC')).slice(0, 127);
  const upw = utf8(user), opw = owner ? utf8(owner) : rnd(32), fk = rnd(32);
  // permissions (table 22): bits 7-8 and 13-32 set; 3 print, 4 modify, 5 copy, 6 comment, 9 fill forms,
  // 10 accessibility copy, 11 assemble, 12 high-quality print
  let P = 0xFFFFF0C0 | 1 << 8 | 1 << 9;   // filling forms and accessibility copying stay allowed
  if (allow.print) P |= 1 << 2 | 1 << 11;
  if (allow.edit) P |= 1 << 3 | 1 << 5 | 1 << 10;
  if (allow.copy) P |= 1 << 4;
  P |= 0;
  const uvs = rnd(8), uks = rnd(8), ovs = rnd(8), oks = rnd(8);
  const U = cat(await hash2B(upw, uvs, new Uint8Array(0)), uvs, uks);
  const UE = await aesNoPad(await hash2B(upw, uks, new Uint8Array(0)), fk);
  const O = cat(await hash2B(opw, ovs, U), ovs, oks);
  const OE = await aesNoPad(await hash2B(opw, oks, U), fk);
  const Perms = await aesNoPad(fk, cat(new Uint8Array([P & 255, P >>> 8 & 255, P >>> 16 & 255, P >>> 24 & 255, 255, 255, 255, 255, 84, 97, 100, 98]), rnd(4)));
  // every string and stream gets AES-256-CBC with its own random IV in front (AESV3)
  const key = await crypto.subtle.importKey('raw', fk, 'AES-CBC', false, ['encrypt']);
  const aes = async data => { const iv = rnd(16); return cat(iv, new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv}, key, data))); };
  const strings = async o => {
    if (o instanceof PDFLib.PDFString || o instanceof PDFLib.PDFHexString) return PDFLib.PDFHexString.of(hex(await aes(o.asBytes())));
    if (o instanceof PDFLib.PDFDict) for (const [k, v] of o.entries()) { const r = await strings(v); if (r) o.set(k, r); }
    else if (o instanceof PDFLib.PDFArray) for (let i = 0; i < o.size(); i++) { const r = await strings(o.get(i)); if (r) o.set(i, r); }
    return null;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFLib.PDFStream) {
      await strings(obj.dict);
      ctx.assign(ref, PDFLib.PDFRawStream.of(obj.dict, await aes(obj.getContents())));
    } else { const r = await strings(obj); if (r) ctx.assign(ref, r); }
  }
  const enc = ctx.obj({Filter: 'Standard', V: 5, R: 6, Length: 256, P, EncryptMetadata: true, StmF: 'StdCF', StrF: 'StdCF',
    CF: {StdCF: {AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32}}});
  for (const [k, v] of Object.entries({O, U, OE, UE, Perms})) enc.set(N(k), PDFLib.PDFHexString.of(hex(v)));
  ctx.trailerInfo.Encrypt = ctx.register(enc);
  const id = PDFLib.PDFHexString.of(hex(rnd(16)));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  // no object streams (they'd be written unencrypted) and no regenerated field appearances
  return doc.save({useObjectStreams: false, updateFieldAppearances: false});
}

// ---------- Smaller file ----------
// Photos and scans (JPEG images) are scaled down to at most 2000 pixels on the long side and
// re-compressed; anything that doesn't get at least 10% smaller is left as it was.
async function shrinkDialog() {
  const bytes = await built('Building...'); if (!bytes) return;
  busy('Making it smaller...');
  let res;
  try { res = await shrinkPdf(bytes); } catch (e) { console.error(e); busy(); return toast('Could not make it smaller: ' + e.message, true); }
  busy();
  const saved = 1 - res.bytes.length / bytes.length;
  if (saved < 0.03) return toast(`It’s already about as small as it gets (${mb(bytes.length)}).`);
  const {value} = await dialog('Smaller file', `<p>${mb(bytes.length)} &rarr; <b>${mb(res.bytes.length)}</b> (${Math.round(saved * 100)}% smaller).</p>
    <div class="lbl">${res.images ? `${res.images} picture${res.images > 1 ? 's' : ''} scaled down or compressed more. Zoomed in, they may look slightly softer.` : 'Unused data removed.'} The original stays as it is.</div>`,
    [[null, 'Cancel'], ['ok', 'Save smaller copy', true]]);
  if (value === 'ok') saveBytes(res.bytes, baseName() + '-smaller.pdf');
}
async function shrinkPdf(bytes) {
  const doc = await PDFDocument.load(bytes, {updateMetadata: false}), ctx = doc.context;
  dropUnreachable(doc);
  let images = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFLib.PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(N('Subtype')) !== N('Image') || d.get(N('Decode')) || d.get(N('ImageMask'))) continue;
    let f = d.get(N('Filter')); if (f instanceof PDFLib.PDFArray) f = f.size() === 1 ? f.get(0) : null;
    if (f !== N('DCTDecode')) continue;
    const cs = d.lookup(N('ColorSpace'));
    const comps = cs === N('DeviceRGB') ? 3 : cs === N('DeviceGray') ? 1
      : cs instanceof PDFLib.PDFArray && cs.get(0) === N('ICCBased') ? ctx.lookup(cs.get(1))?.dict?.get(N('N'))?.asNumber?.() : 0;
    if (comps !== 1 && comps !== 3) continue;   // CMYK and others: leave alone
    const w = d.lookup(N('Width')).asNumber(), h = d.lookup(N('Height')).asNumber();
    if (w * h < 200 * 200) continue;
    let bmp; try { bmp = await createImageBitmap(new Blob([obj.contents], {type: 'image/jpeg'})); } catch { continue; }
    const s = Math.min(1, 2000 / Math.max(w, h)), c = el('canvas', {width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s))});
    const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const out = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72))).arrayBuffer());
    if (out.length > obj.contents.length * 0.9) continue;
    d.set(N('Width'), PDFLib.PDFNumber.of(c.width)); d.set(N('Height'), PDFLib.PDFNumber.of(c.height));
    d.set(N('ColorSpace'), N('DeviceRGB')); d.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(8));
    d.set(N('Filter'), N('DCTDecode')); d.delete(N('DecodeParms'));
    ctx.assign(ref, PDFLib.PDFRawStream.of(d, out));
    images++;
  }
  return {bytes: await doc.save({updateFieldAppearances: false}), images};
}

// ---------- OCR (read the text in scans) ----------
// Tesseract runs in a Web Worker on this computer; the engine (about 7 MB) and English data (3 MB)
// load from vendor/tesseract the first time and the browser keeps them. Each page's words become
// one invisible 'ocr' object: Find and Redact all use it right away, and Save writes it as
// invisible text over the scan, so the saved PDF can be searched and copied in any reader.
// Words under a redaction are left out.
let ocrWorker = null;
const vendorUrl = p => new URL('vendor/tesseract/' + p, location.href).href;
function loadScript(src) {
  return new Promise((res, rej) => document.head.appendChild(el('script', {src, onload: res, onerror: () => rej(new Error('could not load ' + src))})));
}
function getOcr() {
  return ocrWorker ||= (async () => {
    if (!window.Tesseract) await loadScript(vendorUrl('tesseract.min.js'));
    return Tesseract.createWorker('eng', 1, {workerPath: vendorUrl('worker.min.js'), corePath: vendorUrl(''), langPath: vendorUrl('lang'), gzip: false, workerBlobURL: false});
  })().catch(e => { ocrWorker = null; throw e; });
}
async function pageTextChars(p) {
  const tc = await textContent(p);
  return tc.items.reduce((n, it) => n + (it.str || '').replace(/\s/g, '').length, 0);
}
// a freshly opened file whose first pages have no text is almost certainly a scan: say so once
async function suggestOcr(si) {
  const s = S.sources[si];
  if (!s || s.blank || s.bytes.length < 2000 || S.mode !== 'edit') return;
  const pages = S.pages.filter(p => p.src === si);
  if (!pages.length || pages.some(p => p.objs.some(o => o.type === 'ocr'))) return;
  try {
    for (const p of pages.slice(0, 3)) if (await pageTextChars(p) > 20) return;
  } catch { return; }
  toast('This looks like a scan. Click OCR to make its words searchable, copyable and redactable.');
  const b = $('#bOcr'); b.classList.add('primary'); setTimeout(() => b.classList.remove('primary'), 8000);
}
async function ocrDialog() {
  if (!S.pages.length) return;
  const {value, d} = await dialog('Read text (OCR)', `
    <div class="tl-form">
      <label for="oRange">Pages</label><input id="oRange" placeholder="All pages, or for example 1-3">
      <span></span><label class="chk"><input type="checkbox" id="oSkip" checked> Skip pages that already have text</label>
    </div>
    <div class="lbl">Reads English text in scans and photos, right here on this computer; nothing is uploaded. The first time, it downloads the reading engine (about 10 MB). It then takes a few seconds per page. Check important numbers by eye: OCR can misread smudged or handwritten text.</div>`,
    [[null, 'Cancel'], ['ok', 'Read text', true]],
    (v, d) => { const r = val(d, 'oRange').trim() && parseRanges(val(d, 'oRange'), S.pages.length); return typeof r === 'string' ? r : null; });
  if (value !== 'ok') return;
  const r = val(d, 'oRange').trim(), idxs = r ? rangePages(parseRanges(r, S.pages.length)) : S.pages.map((_, i) => i);
  await runOcr(idxs.map(i => S.pages[i]), checked(d, 'oSkip'));
}
async function runOcr(pages, skipText) {
  finishEditing();
  let cancelled = false, words = 0, done = 0, skipped = 0;
  const stop = el('button', {textContent: 'Stop', onclick: () => { cancelled = true; stop.disabled = true; }});
  stop.style.marginLeft = '12px';
  busy('Loading the text reader...'); $('#busy').append(stop);
  try {
    const worker = await getOcr();
    pushUndo();
    for (const [k, p] of pages.entries()) {
      if (cancelled) break;
      if (skipText && await pageTextChars(p) > 20) { skipped++; continue; }
      busy(`Reading page ${S.pages.indexOf(p) + 1} (${k + 1} of ${pages.length})...`);
      const o = await ocrPage(p, worker);
      p.objs = p.objs.filter(x => x.type !== 'ocr');
      if (o.words.length) p.objs.push(o);
      words += o.words.length; done++;
    }
  } catch (e) {
    console.error(e); stop.remove(); busy();
    return toast('OCR stopped: ' + e.message, true);
  }
  stop.remove(); busy(); updateUI();
  if (!done) return toast(skipped ? 'Those pages already have text, so there was nothing to read. Untick "Skip pages" to read them anyway.' : 'Stopped.');
  toast(`Read ${words} words on ${done} page${done > 1 ? 's' : ''}${cancelled ? ' (stopped early)' : ''}. Find (Ctrl+F) can search and redact them now; Save keeps the text in the file.`);
}
async function ocrPage(p, worker) {
  const pg = await getPage(p.src, p.idx), one = pageViewport(pg, p, 1);
  // about 300 dpi, which Tesseract reads best, capped so huge pages don't run out of memory
  const k = Math.min(300 / 72, 3400 / Math.max(one.width, one.height));
  const vp = pageViewport(pg, p, k);
  const c = el('canvas', {width: Math.round(vp.width), height: Math.round(vp.height)}), cx = c.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
  await queueRender(() => pg.render({canvasContext: cx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE}).promise, true);
  despeckle(cx, c.width, c.height);
  const {data} = await worker.recognize(c);
  const R = dims(p).R, list = data.words || (data.blocks || []).flatMap(b => b.paragraphs.flatMap(pa => pa.lines.flatMap(l => l.words)));
  // each word's box as seen on screen, then into overlay space so later rotation and crops follow it
  const out = [];
  for (const w of list) {
    const t = (w.text || '').trim();
    // specks and smudges come back as short, unsure "words" like "i]" or ";"
    if (!t || w.confidence < 20 || !/[A-Za-z0-9$&%#]/.test(t) || (w.confidence < 60 && (t.length <= 2 || !/[A-Za-z0-9]{2}/.test(t)))) continue;
    const [x, y] = viewToUV(p, w.bbox.x0 / k, w.bbox.y0 / k);
    out.push({t, x, y, w: (w.bbox.x1 - w.bbox.x0) / k, h: (w.bbox.y1 - w.bbox.y0) / k});
  }
  c.width = c.height = 0;
  return {id: uid(), type: 'ocr', x: 0, y: 0, rot: R, words: out};
}
// gray, then a 3x3 median: removes scanner specks and JPEG noise without blurring letter edges
function despeckle(cx, w, h) {
  const img = cx.getImageData(0, 0, w, h), d = img.data, g = new Uint8Array(w * h), out = new Uint8Array(w * h), win = new Uint8Array(9);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  out.set(g);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) { const r = (y + dy) * w + x; win[n++] = g[r - 1]; win[n++] = g[r]; win[n++] = g[r + 1]; }
    win.sort(); out[y * w + x] = win[4];
  }
  for (let i = 0, j = 0; i < out.length; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = out[i];
  cx.putImageData(img, 0, 0);
}
EXT.build.ocr = () => el('span', {hidden: true});   // invisible; it's text for Find and Save
EXT.draw.ocr = () => {};                             // written by addOcrText after redaction
// part of a word (characters a..b), as a box in overlay space
function ocrRect(o, w, a, b) {
  const f0 = a / w.t.length, f1 = b / w.t.length, pad = 1;
  const [dx, dy] = rotVec(f0 * w.w - pad, -pad, o.rot);
  return {x: o.x + w.x + dx, y: o.y + w.y + dy, w: (f1 - f0) * w.w + 2 * pad, h: w.h + 2 * pad, rot: o.rot};
}
// axis-aligned bounds of a rotated box, for overlap tests
function bounds({x, y, w, h, rot}) {
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([a, b]) => { const [dx, dy] = rotVec(a, b, rot || 0); return [x + dx, y + dy]; });
  return [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
}
const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
async function addOcrText(doc, entries) {
  if (!S.pages.some(p => p.objs.some(o => o.type === 'ocr'))) return;
  const font = await invisibleFont(doc);
  S.pages.forEach((p, i) => {
    const ocr = p.objs.filter(o => o.type === 'ocr'); if (!ocr.length) return;
    const hidden = p.objs.filter(o => o.type === 'redact').map(bounds);
    const words = ocr.flatMap(o => o.words.map(w => ({t: w.t, x: o.x + w.x, y: o.y + w.y, w: w.w, h: w.h, rot: o.rot})))
      .filter(w => !hidden.some(r => overlaps(r, bounds(w))));
    writeInvisibleText(doc.getPage(i), entries[i].view, words, font);
  });
}
// Helvetica for invisible text; it only covers Windows-1252, so anything else is written as '?'
async function invisibleFont(doc) {
  if (doc._invisibleFont) return doc._invisibleFont;
  const font = await doc.embedFont(StandardFonts.Helvetica), ok = new Map();
  font.clean = t => [...t].map(ch => {
    if (!ok.has(ch)) { try { font.encodeText(ch); ok.set(ch, true); } catch { ok.set(ch, false); } }
    return ok.get(ch) ? ch : '?';
  }).join('');
  return doc._invisibleFont = font;
}
// words ({t, x, y, w, h, rot} boxes in overlay space of a page whose crop box is view) as invisible
// text stretched over their boxes: readers can then search, select and copy them
function writeInvisibleText(page, view, words, font) {
  if (!words.length) return;
  const L = PDFLib;
  page.setFont(font);
  const ops = [L.pushGraphicsState(), L.beginText(), L.setFontAndSize(page.fontKey, 1), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
  for (const w of words) {
    const t = font.clean(w.t), nat = font.widthOfTextAtSize(t, 1); if (!nat) continue;
    const [ax, ay] = rotVec(1, 0, w.rot || 0), [bx, by] = rotVec(0, -1, w.rot || 0);   // the word's right and up, overlay space
    // baseline a fifth of the way up from the box's bottom; text sized to the box
    const [dx, dy] = rotVec(0, w.h * 0.8, w.rot || 0), sx = w.w / nat, sy = w.h * 0.85;
    ops.push(L.setTextMatrix(ax * sx, -ay * sx, bx * sy, -by * sy, view[0] + w.x + dx, view[3] - (w.y + dy)), L.showText(font.encodeText(t)));
  }
  ops.push(L.endText(), L.popGraphicsState());
  page.pushOperators(...ops);
}
