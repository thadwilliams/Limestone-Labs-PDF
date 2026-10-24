// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// Checks the tools.js features in a real browser: redaction really removes text, comments are
// real PDF comments, crop, stamps, watermark, blank pages, find, strike, password protection
// (opens with the password and only with it) and Smaller file.
//   node tests/e2e/tools.cjs            serves public/ locally and uses installed Edge (or Chrome)
const {chromium} = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'public');
const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'content-type': types[path.extname(p)] || 'application/octet-stream'}); fs.createReadStream(p).pipe(res);
});

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failed++; };

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/`;
  let browser;
  for (const channel of ['msedge', 'chrome']) { try { browser = await chromium.launch({channel}); break; } catch {} }
  if (!browser) browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => typeof EXT === 'object' && EXT.finish);

  // a 3-page test PDF with known words, made in the page with pdf-lib
  await page.evaluate(async () => {
    const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) {
      const pg = d.addPage([612, 792]);
      pg.drawText(`Account number 4417-SECRET-${i}`, {x: 72, y: 700, size: 14, font: f});
      pg.drawText(`Public line on page ${i}`, {x: 72, y: 650, size: 14, font: f});
    }
    const file = new File([await d.save()], 'test.pdf', {type: 'application/pdf'});
    await openFiles([file], false);
  });
  ok(await page.evaluate(() => S.pages.length) === 3, 'opened a 3-page PDF');

  // helpers in the page
  await page.evaluate(() => {
    window.textOf = async bytes => {
      const js = await pdfjsLib.getDocument({data: bytes.slice()}).promise, out = [];
      for (let i = 1; i <= js.numPages; i++) out.push((await (await js.getPage(i)).getTextContent()).items.map(x => x.str).join(' '));
      return out;
    };
  });

  console.log('Find');
  const hits = await page.evaluate(async () => { openFind(); $('#findQ').value = 'secret'; await runFind(); return find.hits.length; });
  ok(hits === 3, `finds "secret" on all 3 pages (${hits})`);
  ok(await page.evaluate(() => document.querySelectorAll('.findhit').length) === 3, 'draws a box on each match');

  console.log('Redact');
  const red = await page.evaluate(async () => {
    $('#findQ').value = '4417-SECRET-2'; await runFind();
    const n = find.hits.length; markAll('redact');
    const bytes = await buildPdf(), text = await textOf(bytes);
    const raw = new TextDecoder('latin1').decode(bytes);
    return {n, text, rawHasSecret2: raw.includes('SECRET-2'), objs: S.pages[1].objs.map(o => o.type)};
  });
  ok(red.n === 1 && red.objs.includes('redact'), 'Redact all marks the match');
  ok(!red.text[1].includes('SECRET'), 'redacted page has no extractable secret text');
  ok(/Public\s+line\s+on\s+page\s+2/.test(red.text[1]) && /Account\s+number/.test(red.text[1]), 'the rest of the redacted page is still searchable');
  ok(!red.rawHasSecret2, 'redacted text is not anywhere in the file bytes');
  ok(red.text[0].includes('SECRET-1') && red.text[2].includes('SECRET-3'), 'other pages keep their text');

  console.log('Deleted pages are really gone');
  const del = await page.evaluate(async () => {
    const before = await buildPdf();
    S.pages[1].objs = [];   // drop the redaction so page 2 is original content again
    pageOp(() => S.pages.splice(1, 1));
    const after = await buildPdf(), doc = await PDFDocument.load(after);
    // decompress every stream and look for the deleted page's words
    let found = false;
    for (const [, o] of doc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFLib.PDFRawStream)) continue;
      try { const t = new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(o).decode()); if (t.includes('SECRET-2') || t.includes('page 2')) found = true; } catch {}
    }
    undo();
    return {pages: doc.getPageCount(), found};
  });
  ok(del.pages === 2 && !del.found, 'a deleted page leaves no trace in the saved file');

  console.log('Comments');
  const notes = await page.evaluate(async () => {
    S.pages[0].objs.push({id: uid(), type: 'note', x: 300, y: 100, w: 20, h: 20, rot: 0, text: 'Please check this number', author: 'Tester', at: Date.now(), fill: '#ffd43b'});
    renderPages();
    const bytes = await buildPdf(), js = await pdfjsLib.getDocument({data: bytes}).promise;
    const an = await (await js.getPage(1)).getAnnotations();
    return {shown: !!document.querySelector('.obj.note'), an: an.map(a => ({t: a.subtype, c: a.contentsObj?.str ?? a.contents, who: a.titleObj?.str ?? a.title}))};
  });
  ok(notes.shown, 'comment shows on the page');
  ok(notes.an.some(a => a.t === 'Text' && a.c === 'Please check this number' && a.who === 'Tester'), 'saved as a real PDF comment with author');

  console.log('Highlight, strike and underline (real PDF markup)');
  const marks = await page.evaluate(async () => {
    const p = S.pages[2];
    // a drag over the start of "Public line on page 3" snaps to whole letters
    const part = await textQuads(p, {x: 70, y: 136, w: 30, h: 8});
    const hl = makeMarkup('highlight', await textQuads(p, {x: 70, y: 136, w: 200, h: 8}), '#ffe600', {text: 'check this line', author: 'Tester'});
    const st = makeMarkup('strike', await textQuads(p, {x: 70, y: 86, w: 400, h: 8}), '#e03131', {author: 'Tester'});
    p.objs.push(hl, st); renderPages();
    const shown = document.querySelectorAll('svg.vec.markup').length;
    const js = await pdfjsLib.getDocument({data: await buildPdf()}).promise;
    const an = await (await js.getPage(3)).getAnnotations();
    p.objs = p.objs.filter(o => o !== hl && o !== st); renderPages();
    return {part: part.map(q => Math.round(q.w)), shown, an: an.map(a => ({t: a.subtype, quads: a.quadPoints?.length, c: a.contentsObj?.str, who: a.titleObj?.str}))};
  });
  ok(marks.part.length === 1 && marks.part[0] > 20 && marks.part[0] < 60, `a short drag snaps to letters (${marks.part} pt wide)`);
  ok(marks.shown === 2, 'marks show on the page');
  ok(marks.an.some(a => a.t === 'Highlight' && a.quads && a.c === 'check this line' && a.who === 'Tester'), 'saved as a real Highlight with its comment');
  ok(marks.an.some(a => a.t === 'StrikeOut' && a.quads), 'saved as a real StrikeOut');

  console.log('Crop');
  const crop = await page.evaluate(async () => {
    pageOp(() => cropPage(S.pages[0], {x: 50, y: 50, w: 400, h: 300}));
    await new Promise(r => setTimeout(r, 300));
    const bytes = await buildPdf(), js = await pdfjsLib.getDocument({data: bytes}).promise, pg = await js.getPage(1);
    const t = (await pg.getTextContent()).items.map(x => x.str).join(' ');
    return {view: pg.view, el: DOM.get(S.pages[0].id).el.style.width, t};
  });
  ok(Math.round(crop.view[2] - crop.view[0]) === 400 && Math.round(crop.view[3] - crop.view[1]) === 300, `crop box is 400x300 (${crop.view.map(Math.round)})`);
  ok(crop.el === 400 * 1.25 + 'px' || parseFloat(crop.el) > 0, 'cropped page displays at the new size');
  await page.evaluate(() => uncropAll());
  ok(await page.evaluate(() => !S.pages[0].full && S.pages[0].view[2] === 612), 'Remove all crops restores the page');

  console.log('Blank page, page numbers, Bates, watermark');
  const stamps = await page.evaluate(async () => {
    await insertBlank(0);
    const n = S.pages.length;
    // what the dialogs do when Apply is clicked
    S.pages.forEach((p, k) => {
      p.objs.push(stampText(p, `Page ${k + 1} of ${S.pages.length}`, {font: 'helv', size: 10, bold: false, color: '#000000'}, {stamp: 'hf', margin: 36, vpos: 'bottom', align: 'center'}));
      p.objs.push(stampText(p, 'SAN' + String(k + 1).padStart(6, '0'), {font: 'helv', size: 10, bold: false, color: '#000000'}, {stamp: 'hf', margin: 36, vpos: 'bottom', align: 'right'}));
    });
    const wm = {id: uid(), type: 'text', text: 'CONFIDENTIAL', font: 'helv', bold: true, color: '#c92a2a', size: 80, opacity: 0.25, rot: 45, x: 150, y: 500, stamp: 'wm'};
    S.pages[1].objs.push(wm); renderPages();
    const bytes = await buildPdf();
    return {n, text: await textOf(bytes), wmOpacity: document.querySelector('.obj.text[style*="opacity"]')?.style.opacity};
  });
  ok(stamps.n === 4 && stamps.text[1].replace(/Page 2 of 4|SAN000002|CONFIDENTIAL|\s/g, '') === '', 'blank page inserted after page 1');
  ok(stamps.text[0].includes('Page 1 of 4') && stamps.text[3].includes('Page 4 of 4'), 'page numbers on every page');
  ok(stamps.text[2].includes('SAN000003'), 'Bates numbers');
  ok(stamps.text[1].includes('CONFIDENTIAL') && stamps.wmOpacity === '0.25', 'see-through watermark');

  console.log('Password protection');
  const enc = await page.evaluate(async () => {
    const plain = await buildPdf();
    const bytes = await encryptPdf(plain, {user: 'Secret#1', owner: 'owner-pw', allow: {print: true, copy: false, edit: false}});
    const raw = new TextDecoder('latin1').decode(bytes);
    let noPw = 'opened', wrong = 'opened';
    try { await pdfjsLib.getDocument({data: bytes.slice()}).promise; } catch (e) { noPw = e.name; }
    try { await pdfjsLib.getDocument({data: bytes.slice(), password: 'nope'}).promise; } catch (e) { wrong = e.name; }
    const right = await pdfjsLib.getDocument({data: bytes.slice(), password: 'Secret#1'}).promise;
    const owner = await pdfjsLib.getDocument({data: bytes.slice(), password: 'owner-pw'}).promise;
    const t = (await (await right.getPage(1)).getTextContent()).items.map(x => x.str).join(' ');
    const perms = await right.getPermissions();
    return {noPw, wrong, t, ownerPages: owner.numPages, perms, aes: raw.includes('/AESV3'), plainText: raw.includes('Public line')};
  });
  ok(enc.aes && !enc.plainText, 'AES-256 encrypted, no readable text in the file');
  ok(enc.noPw === 'PasswordException' && enc.wrong === 'PasswordException', 'will not open without the right password');
  ok(enc.t.includes('Public line'), 'opens with the password and the text is intact: ' + JSON.stringify(enc.t));
  ok(enc.ownerPages === 4, 'the permissions password also opens it');
  ok(Array.isArray(enc.perms) && enc.perms.includes(4) && !enc.perms.includes(16), `print allowed, copy blocked (${enc.perms})`);

  console.log('Smaller file');
  const shrink = await page.evaluate(async () => {
    const d = await PDFDocument.create(), c = Object.assign(document.createElement('canvas'), {width: 3000, height: 3000}), x = c.getContext('2d');
    for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${i * 37 % 360},70%,50%)`; x.fillRect(Math.random() * 3000, Math.random() * 3000, 300, 300); }
    const jpg = await d.embedJpg(c.toDataURL('image/jpeg', 0.95));
    d.addPage([612, 792]).drawImage(jpg, {x: 0, y: 0, width: 612, height: 792});
    const big = await d.save(), res = await shrinkPdf(big);
    const js = await pdfjsLib.getDocument({data: res.bytes.slice()}).promise, pg = await js.getPage(1);
    const cv = document.createElement('canvas'), vp = pg.getViewport({scale: 0.2}); cv.width = vp.width; cv.height = vp.height;
    await pg.render({canvasContext: cv.getContext('2d'), viewport: vp}).promise;
    const px = cv.getContext('2d').getImageData(cv.width / 2, cv.height / 2, 1, 1).data;
    return {before: big.length, after: res.bytes.length, images: res.images, px: [...px]};
  });
  ok(shrink.images === 1 && shrink.after < shrink.before * 0.6, `scan shrinks ${Math.round(shrink.before / 1e3)} KB -> ${Math.round(shrink.after / 1e3)} KB and still renders (${shrink.px})`);
  ok(shrink.px[0] + shrink.px[1] + shrink.px[2] > 30, 'shrunk picture is still there');

  console.log('OCR on a scan');
  const scan = await page.evaluate(async () => {
    // a "scanned" page: text drawn into a picture, so the PDF itself has no text at all
    const c = Object.assign(document.createElement('canvas'), {width: 2550, height: 3300}), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#111'; x.font = '64px Arial';
    ['ACME ENERGY SERVICES', 'Invoice 88123', 'Account number 5521-7781', 'Total due $412.50', 'Service address 100 Main Street'].forEach((t, i) => x.fillText(t, 200, 400 + i * 160));
    const d = await PDFDocument.create(), jpg = await d.embedJpg(c.toDataURL('image/jpeg', 0.85));
    d.addPage([612, 792]).drawImage(jpg, {x: 0, y: 0, width: 612, height: 792});
    S.dirty = false;
    await openFiles([new File([await d.save()], 'scan.pdf', {type: 'application/pdf'})], false);
    await new Promise(r => setTimeout(r, 800));
    const suggested = $('#toast').textContent;
    const t0 = performance.now();
    await runOcr(S.pages, true);
    const secs = (performance.now() - t0) / 1000, ocr = S.pages[0].objs.find(o => o.type === 'ocr');
    openFind(); $('#findQ').value = '5521-7781'; await runFind();
    const hits = find.hits.length;
    const searchable = await textOf(await buildPdf());
    markAll('redact');
    S.pages[0].objs.push({id: uid(), type: 'note', x: 400, y: 600, w: 20, h: 20, rot: 0, text: 'note on a redacted page', author: 'T', at: Date.now(), fill: '#ffd43b'});
    const redacted = await textOf(await buildPdf());
    return {suggested, secs, words: ocr?.words.map(w => w.t).join(' '), hits, searchable: searchable[0], redacted: redacted[0]};
  });
  console.log('       read in ' + scan.secs.toFixed(1) + 's: ' + scan.words);
  ok(/looks like a scan/.test(scan.suggested), 'offers OCR when a scan is opened');
  ok(/5521-7781/.test(scan.words) && /412\.50/.test(scan.words) && /Invoice/.test(scan.words), 'reads the words on the scan');
  ok(scan.hits === 1, 'Find finds a number on the scan');
  ok(/Account\s+number\s+5521-7781/.test(scan.searchable), 'saved PDF has the scan text, searchable and copyable');
  ok(!/5521/.test(scan.redacted) && /Invoice\s+88123/.test(scan.redacted),'Redact all on a scan removes that number and keeps the rest searchable');

  console.log('Comments list');
  const cm = await page.evaluate(async () => {
    // a PDF that already has two comments from someone else, one with a reply
    const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), pg = d.addPage([612, 792]), ctx = d.context;
    pg.drawText('Broker agreement, net 30 terms', {x: 72, y: 700, size: 14, font: f});
    const note = (text, who, rect, irt) => {
      const a = ctx.obj({Type: 'Annot', Subtype: 'Text', Rect: rect, F: 4});
      a.set(PDFName.of('Contents'), PDFLib.PDFHexString.fromText(text)); a.set(PDFName.of('T'), PDFLib.PDFHexString.fromText(who));
      if (irt) a.set(PDFName.of('IRT'), irt);
      const r = ctx.register(a); pg.node.addAnnot(r); return r;
    };
    const keepRef = note('Is net 30 right?', 'Broker', [300, 690, 320, 710]);
    note('Yes, confirmed', 'Ops', [300, 690, 320, 710], keepRef);
    const dropRef = note('old note, ignore', 'Broker', [400, 690, 420, 710]);
    S.dirty = false;
    await openFiles([new File([await d.save()], 'with-comments.pdf', {type: 'application/pdf'})], false);
    openReview('comments'); await renderComments();
    const listed = [...document.querySelectorAll('#rvBody .rv-item')].map(e => e.querySelector('.rv-text')?.textContent);
    // reply to the first one, remove the second, save
    const p = S.pages[0], keepId = keepRef.objectNumber + 'R', dropId = dropRef.objectNumber + 'R';
    p.objs.push({id: uid(), type: 'note', x: 228, y: 82, w: 20, h: 20, rot: 0, text: 'Agreed, keeping it', author: 'Tester', at: Date.now(), fill: '#ffd43b', irt: {ref: keepId}});
    p.dropAnnots = [dropId];
    const bytes = await buildPdf(), js = await pdfjsLib.getDocument({data: bytes}).promise, an = await (await js.getPage(1)).getAnnotations();
    closeReview();
    return {listed, saved: an.filter(a => a.subtype === 'Text').map(a => ({c: a.contentsObj?.str, irt: a.inReplyTo})), keepId};
  });
  ok(cm.listed.includes('Is net 30 right?') && cm.listed.includes('Yes, confirmed') && cm.listed.includes('old note, ignore'), 'lists comments made in other apps, with replies');
  ok(cm.saved.some(a => a.c === 'Agreed, keeping it' && a.irt === cm.keepId), 'a reply is saved as a real reply to that comment');
  ok(!cm.saved.some(a => a.c === 'old note, ignore') && cm.saved.some(a => a.c === 'Yes, confirmed'), 'a removed comment is gone from the saved file; others stay');

  console.log('Compare');
  const cmp = await page.evaluate(async () => {
    const make = async (lines, name = 'v.pdf') => {
      const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), pg = d.addPage([612, 792]);
      lines.forEach((t, i) => pg.drawText(t, {x: 72, y: 700 - i * 24, size: 12, font: f}));
      return new File([await d.save()], name, {type: 'application/pdf'});
    };
    const v1 = ['Payment terms are net 30 days from invoice.', 'Supplier will provide 24 hour support.', 'This agreement renews every year.'];
    const v2 = ['Payment terms are net 45 days from invoice.', 'Supplier will provide 24 hour support and monthly reports.', 'This agreement renews.'];
    S.dirty = false;
    await openFiles([await make(v2)], false);
    openReview('compare');
    await runCompare(await make(v1, 'v1.pdf'), true);
    const hunks = rv.cmp.hunks.map(h => ({kind: h.kind, del: h.del.map(w => w.t).join(' '), ins: h.ins.map(w => w.t).join(' '), boxes: h.boxes.length}));
    markChanges();
    const objs = S.pages[0].objs.map(o => o.type + (o.kind ? ':' + o.kind : ''));
    closeReview();
    return {hunks, objs};
  });
  const hk = k => cmp.hunks.filter(h => h.kind === k);
  ok(cmp.hunks.length === 3, 'finds the 3 differences: ' + cmp.hunks.map(h => `${h.kind}[${h.del}->${h.ins}]`).join(' '));
  ok(hk('Changed').some(h => h.del === '30' && h.ins === '45'), 'a changed number');
  ok(hk('Added').some(h => /monthly reports/.test(h.ins)), 'added words');
  ok(hk('Removed').some(h => /every year/.test(h.del)), 'removed words');
  ok(cmp.hunks.every(h => h.boxes > 0), 'every difference can be shown on the page');
  ok(cmp.objs.filter(o => o === 'markup:highlight').length === 2 && cmp.objs.includes('note'), 'Mark up adds highlights for changes and a note for the removal');

  console.log('Toolbar');
  const ui = await page.evaluate(() => ({
    tools: [...document.querySelectorAll('button[data-tool]')].map(b => b.textContent.trim()),
    doc: ['bFind', 'bOcr', 'bPrint', 'bProtect', 'bShrink', 'bAct-blank', 'bAct-extract', 'bAct-crop', 'bAct-hf', 'bAct-wm', 'bAct-findredact'].filter(id => !document.getElementById(id)),
    tabs: [...document.querySelectorAll('#lyCats [data-tab]')].map(b => b.textContent.trim()),
    ranges: [parseRanges('1-3, 5, 8-', 10), parseRanges('0-2', 10), parseRanges('x', 10)],
  }));
  ok(['Redact', 'Strike', 'Underline', 'Comment'].every(t => ui.tools.includes(t)), 'new tools in the toolbar');
  ok(!ui.doc.length, 'every document command has a button' + (ui.doc.length ? ': missing ' + ui.doc : ''));
  ok(ui.tabs.join() === 'Home,Edit,Annotate,Fill & Sign,Pages,Protect,Tools', 'toolbar tabs: ' + ui.tabs.join(', '));
  ok(JSON.stringify(ui.ranges[0]) === '[[1,3],[5,5],[8,10]]' && typeof ui.ranges[1] === 'string' && typeof ui.ranges[2] === 'string', 'page ranges parse and bad ones are explained');
  await page.evaluate(() => closeFind());
  await page.screenshot({path: path.join(process.env.SHOT_DIR || __dirname, 'tools-screenshot.png')});

  ok(!errors.length, 'no errors in the console' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
