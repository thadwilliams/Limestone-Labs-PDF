// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// Two toolbar layouts, chosen in Settings (the gear) and remembered in this browser:
//   word     Office-style ribbon: tabs of big labeled buttons in named groups. Like Word, it can be
//            collapsed (double-click a tab, Ctrl+F1, or the arrow at the end of the tabs); collapsed,
//            a tab opens its buttons over the page until one is used.
//   acrobat  Acrobat-style: tool categories in a column on the left, the chosen category's tools in a
//            strip across the top.
// Both are built from the editor's own buttons, moved rather than copied so their ids and handlers keep
// working, plus buttons for the tools.js actions. Font, size, color and line settings float over the page
// only while a tool or a selected item uses them. Phones keep the compact bar: Menu lists every group.

const LKEY = 'pdfedit.layout';
const LY = {mode: 'word', collapsed: false, tab: 'home'};
try { Object.assign(LY, JSON.parse(localStorage.getItem(LKEY)) || {}); } catch {}
const saveLayout = () => { try { localStorage.setItem(LKEY, JSON.stringify(LY)); } catch {} };

document.head.appendChild(Object.assign(document.createElement('style'), {textContent: `
.ic{width:18px;height:18px;flex:none;stroke-width:1.75}
body header{display:block;padding:0;position:relative;z-index:5}
header #hint{padding:3px 10px 4px}
header #signbar{padding:6px 10px}
main{position:relative}
.ly-top{display:flex;align-items:center;gap:4px;padding:5px 8px;border-bottom:1px solid var(--line)}
.ly-top > button,.ly-top .grp button{display:inline-flex;align-items:center;gap:5px}
.ly-top .grp{border:0;padding:0}
.ly-top #tipLink{margin-left:0}
.ly-title{flex:1;min-width:0;text-align:center;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
.ly-icon-only .lb{display:none}
#lyCats{display:flex;gap:2px}
#lyCats button{border:0;background:none;border-radius:0}
#lyCats button:disabled{opacity:1}
.ly-pane{display:none}
.ly-pane.on{display:flex}
.ly-group{display:flex;align-items:center}
.ly-items{display:flex;gap:2px;align-items:flex-start}
.ly-pane button{display:flex;align-items:center;gap:5px;background:none;border-color:transparent;white-space:nowrap}
.ly-pane button:hover:not(:disabled){background:var(--bg);border-color:var(--line)}
.ly-pane button.on{background:var(--accent-weak);border-color:var(--accent)}
.ly-pane label.chk{font-size:12px;padding:4px 6px}
#lyCtx{display:none;position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:4;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:5px 8px;box-shadow:0 4px 16px rgba(0,0,0,.16);white-space:nowrap}
#lyCtx.show{display:flex}
#lyCtx .grp{border:0;padding:0;gap:6px}
/* Word */
.ly-word #lyCats{padding:0 8px;background:var(--bg);border-bottom:1px solid var(--line);overflow-x:auto}
.ly-word #lyCats button{padding:7px 13px;border-bottom:2px solid transparent;color:var(--ink)}
.ly-word #lyCats button.on{border-bottom-color:var(--accent);color:var(--accent);font-weight:600;background:none}
.ly-word #lyCats button .ic{display:none}
.ly-word #lyCats button:hover{border-color:transparent;border-bottom-color:var(--line)}
.ly-word #lyCats button.on:hover{border-bottom-color:var(--accent)}
#lyPin{margin-left:auto;padding:4px 8px !important;border-bottom:0 !important;color:var(--muted) !important}
.ly-acrobat #lyPin{display:none !important}
.ly-word #lyPanes{border-bottom:1px solid var(--line);background:var(--panel)}
.ly-word .ly-pane.on{padding:6px 8px 2px;min-height:86px;overflow-x:auto}
.ly-word .ly-group{flex-direction:column;padding:0 10px;border-right:1px solid var(--line)}
.ly-word .ly-group:last-child{border-right:0}
.ly-word .ly-glabel{font-size:11px;color:var(--muted);margin-top:auto;padding:3px 0 1px}
.ly-word .ly-pane button{flex-direction:column;gap:3px;min-width:58px;padding:5px 6px;font-size:12px;line-height:1.15}
.ly-word .ly-pane button .ic{width:22px;height:22px}
.ly-collapsed #lyPanes{display:none}
.ly-collapsed.ly-peek #lyPanes{display:block;position:absolute;left:0;right:0;z-index:8;box-shadow:0 8px 20px rgba(0,0,0,.18)}
/* Acrobat */
.ly-acrobat #lyCats{flex-direction:column;width:86px;flex:none;border-right:1px solid var(--line);background:var(--panel);padding:6px 4px;overflow-y:auto}
.ly-acrobat #lyCats button{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px;font-size:11px;line-height:1.15;border-radius:8px;border:1px solid transparent}
.ly-acrobat #lyCats button .ic{width:20px;height:20px}
.ly-acrobat #lyCats button.on{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.ly-acrobat #lyPanes{border-bottom:1px solid var(--line)}
.ly-acrobat .ly-pane.on{align-items:center;padding:4px 10px;overflow-x:auto;min-height:42px}
.ly-acrobat .ly-pane::before{content:attr(data-label);font-weight:600;margin-right:10px;white-space:nowrap}
.ly-acrobat .ly-group{padding:0 6px;border-right:1px solid var(--line)}
.ly-acrobat .ly-group:last-child{border-right:0}
.ly-acrobat .ly-glabel{display:none}
.ly-acrobat .ly-pane button{padding:4px 8px}
.ly-opt{align-items:flex-start !important;white-space:normal !important;padding:8px;border:1px solid var(--line);border-radius:8px}
.ly-opt input{margin-top:4px}
body.signing #lyCats,body.signing #lyPanes,body.signing #lyCtx{display:none !important}
@media (max-width:700px){
  #mbar{padding:6px 8px}
  #lyCats,#lyPin{display:none !important}
  body:not(.signing) .ly-top{display:none}
  body.m-menu .ly-top{display:flex;flex-wrap:wrap}
  body.m-menu .ly-title,body.m-menu .ly-top .edit-only{display:none}
  #lyPanes{display:none !important}
  body.m-menu #lyPanes,body.m-tools #lyPanes{display:block !important;position:static !important;box-shadow:none !important;max-height:65vh;overflow:auto}
  body.m-menu .ly-pane,body.m-tools .ly-pane.ly-tools-pane{display:flex !important;flex-wrap:wrap;align-items:center;gap:4px;padding:8px;border-top:1px solid var(--line);min-height:0 !important}
  body.m-tools .ly-pane:not(.ly-tools-pane){display:none !important}
  .ly-pane::before{content:attr(data-label);flex-basis:100%;font-size:12px;color:var(--muted);font-weight:400 !important}
  .ly-group{flex-direction:row !important;border:0 !important;padding:0 !important}
  .ly-items{flex-wrap:wrap}
  .ly-glabel{display:none}
  .ly-pane button{flex-direction:row !important;min-width:0 !important;padding:7px 10px !important;font-size:14px !important;border-color:var(--line) !important}
  .ly-pane button .ic{width:18px !important;height:18px !important}
  body.m-style #lyCtx{display:flex}
  #lyCtx{top:6px;max-width:calc(100vw - 16px);overflow-x:auto}
}
`}));

// ---------- what goes where ----------
// item: an existing element id, 'tool:<name>' for an editor tool, or 'act:<name>' for an action below.
// An item placed a second time becomes a stand-in button that clicks the first.
const PANES = [
  {key: 'home', label: 'Home', icon: 'house', groups: [
    ['File', [['bOpen', 'folder-open', 'Open'], ['bAdd', 'file-plus', 'Add PDF'], ['bSave', 'save', 'Save'], ['bPrint', 'printer', 'Print'], ['bClose', 'file-x', 'Close']]],
    ['Find', [['bFind', 'search', 'Find']]],
  ]},
  {key: 'edit', label: 'Edit', icon: 'pencil', tools: true, groups: [
    ['Select', [['tool:select', 'mouse-pointer-2', 'Select']]],
    ['Text', [['tool:text', 'type', 'Add text'], ['tool:edit', 'text-cursor-input', 'Edit text']]],
    ['Insert', [['tool:image', 'image', 'Image'], ['tool:date', 'calendar', 'Date'], ['tool:whiteout', 'eraser', 'Whiteout']]],
    ['Clipboard', [['bPaste', 'clipboard-paste', 'Paste'], ['bDel', 'trash-2', 'Delete']]],
  ]},
  {key: 'annotate', label: 'Annotate', icon: 'message-square', tools: true, groups: [
    ['Markup', [['tool:highlight', 'highlighter', 'Highlight'], ['tool:strike', 'strikethrough', 'Strike'], ['tool:underline', 'underline', 'Underline']]],
    ['Comment', [['tool:note', 'message-square', 'Comment']]],
    ['Draw', [['tool:box', 'square', 'Box'], ['tool:draw', 'pen-line', 'Draw'], ['tool:check', 'check', 'Check'], ['tool:cross', 'x', 'X mark']]],
    ['Review', [['bComments', 'messages-square', 'Comments list']]],
  ]},
  {key: 'sign', label: 'Fill & Sign', icon: 'signature', tools: true, groups: [
    ['Sign', [['tool:sign', 'signature', 'Sign'], ['tool:date', 'calendar', 'Date']]],
    ['Forms', [['bFormPrep', 'form-input', 'Make fillable'], ['flattenWrap']]],
    ['Request', [['bSignReq', 'send', 'Get signatures']]],
  ]},
  {key: 'pages', label: 'Pages', icon: 'files', groups: [
    ['Organize', [['act:blank', 'file-plus-2', 'Insert blank'], ['act:extract', 'scissors', 'Extract / split'], ['act:crop', 'crop', 'Crop'], ['act:uncrop', 'maximize', 'Remove crops']]],
    ['Stamp', [['act:hf', 'list-ordered', 'Page numbers'], ['act:wm', 'stamp', 'Watermark']]],
  ]},
  {key: 'protect', label: 'Protect', icon: 'shield', tools: true, groups: [
    ['Redact', [['tool:redact', 'eye-off', 'Redact'], ['act:findredact', 'search-x', 'Find & redact']]],
    ['Secure', [['bProtect', 'lock', 'Password']]],
  ]},
  {key: 'tools', label: 'Tools', icon: 'wrench', groups: [
    ['Versions', [['bCompare', 'git-compare', 'Compare']]],
    ['Scans', [['bOcr', 'scan-text', 'OCR']]],
    ['Optimize', [['bShrink', 'file-down', 'Smaller file']]],
  ]},
];
const ACTS = {
  blank: ['Insert a blank page after the page you are looking at', () => insertBlank(currentPageIdx())],
  extract: ['Save some pages as a new file, or split this one into several', extractDialog],
  crop: ['Drag a box around the part of a page to keep', startCrop],
  uncrop: ['Put back the full page on every cropped page', uncropAll],
  hf: ['Page numbers, headers, footers and Bates numbers', headerFooterDialog],
  wm: ['Add a see-through stamp like CONFIDENTIAL or DRAFT', watermarkDialog],
  findredact: ['Find words, then redact every match (Redact all in the Find bar)', () => openFind()],
};
// the page most in view: a third of the way down the viewer
function currentPageIdx() {
  const v = $('#view').getBoundingClientRect(), y = v.top + v.height / 3;
  let best = S.pages.length - 1, bd = Infinity;
  S.pages.forEach((p, i) => {
    const r = DOM.get(p.id)?.el.getBoundingClientRect(); if (!r) return;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// ---------- build ----------
const header = document.querySelector('header'), mainEl = document.querySelector('main');
const decorate = (b, ic, label) => { b.innerHTML = icon(ic) + `<span class="lb">${label}</span>`; return b; };
const placed = new Set();
function item([ref, ic, label]) {
  let b;
  if (ref.startsWith('act:')) {
    const [title, fn] = ACTS[ref.slice(4)];
    b = el('button', {id: 'bAct-' + ref.slice(4), title, onclick: () => { closePeek(); phoneMenu(null); fn(); }});
    b.dataset.act = ref.slice(4);
  } else {
    const src = ref.startsWith('tool:') ? document.querySelector(`button[data-tool="${ref.slice(5)}"]`) : $('#' + ref);
    if (!src) return null;
    if (!placed.has(src)) { placed.add(src); b = src; if (!ic) return b; }
    else {   // a second spot for the same command
      b = el('button', {title: src.title || src.dataset.tip || '', onclick: () => src.click()});
      if (src.dataset.tool) b.dataset.tool = src.dataset.tool; else b.dataset.proxy = src.id;
    }
  }
  b.addEventListener('click', () => { closePeek(); phoneMenu(null); });
  return decorate(b, ic, label);
}

const lyTop = el('div', {className: 'ly-top', id: 'lyTop'});
const title = el('span', {className: 'ly-title', id: 'lyTitle'});
for (const [id, ic, label] of [['bSave', 'save', 'Save'], ['bUndo', 'undo-2', 'Undo'], ['bRedo', 'redo-2', 'Redo']]) { placed.add($('#' + id)); decorate($('#' + id), ic, label); }
$('#bUndo').classList.add('ly-icon-only', 'edit-only'); $('#bRedo').classList.add('ly-icon-only', 'edit-only'); $('#bSave').classList.add('edit-only');
placed.add($('#bFind')); decorate($('#bFind'), 'search', 'Find');
decorate($('#bZoomOut'), 'zoom-out', ''); decorate($('#bZoomIn'), 'zoom-in', ''); decorate($('#bFit'), 'maximize-2', 'Fit');
if ($('#bInstall')) decorate($('#bInstall'), 'download', 'Install app');
const settingsBtn = el('button', {id: 'bSettings', className: 'edit-only', title: 'Settings: Word-style or Acrobat-style toolbar', innerHTML: icon('settings'), onclick: () => { phoneMenu(null); settingsDialog(); }});
lyTop.append($('#bSave'), $('#bUndo'), $('#bRedo'), title, $('#bFind'), $('#gZoom'), $('#tipLink'), settingsBtn);

const cats = el('div', {id: 'lyCats', className: 'edit-only', role: 'tablist'});
const panes = el('div', {id: 'lyPanes', className: 'edit-only'});
for (const pn of PANES) {
  const tab = el('button', {innerHTML: icon(pn.icon) + `<span class="lb">${pn.label}</span>`, title: pn.label, role: 'tab'});
  tab.dataset.tab = pn.key;
  tab.onclick = () => pickTab(pn.key);
  tab.ondblclick = () => { if (LY.mode === 'word') setCollapsed(!LY.collapsed); };
  cats.append(tab);
  const pane = el('div', {className: 'ly-pane' + (pn.tools ? ' ly-tools-pane' : ''), role: 'tabpanel'});
  pane.dataset.tab = pn.key; pane.dataset.label = pn.label;
  for (const [g, items] of pn.groups) {
    const its = items.map(item).filter(Boolean); if (!its.length) continue;
    pane.append(el('div', {className: 'ly-group'}, el('div', {className: 'ly-items'}, ...its), el('div', {className: 'ly-glabel', textContent: g})));
  }
  panes.append(pane);
}
const pin = el('button', {id: 'lyPin', onclick: () => setCollapsed(!LY.collapsed)});
cats.append(pin);

const ctx = el('div', {id: 'lyCtx', className: 'edit-only'});
ctx.append($('#gStyle'));
mainEl.prepend(ctx);

// the old toolbar groups are empty now
for (const id of ['gFile', 'tools', 'gSign', 'gEdit', 'gDoc']) $('#' + id)?.remove();
$('#mbar').after(lyTop, cats, panes);

// ---------- behavior ----------
function pickTab(key) {
  if (LY.mode === 'word' && LY.collapsed) {
    const open = document.body.classList.contains('ly-peek') && LY.tab === key;
    LY.tab = key; showTab(); document.body.classList.toggle('ly-peek', !open);
  } else { LY.tab = key; showTab(); }
  saveLayout();
}
function showTab() {
  if (!PANES.some(p => p.key === LY.tab)) LY.tab = 'home';
  cats.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === LY.tab); b.setAttribute('aria-selected', b.dataset.tab === LY.tab); });
  panes.querySelectorAll('.ly-pane').forEach(p => p.classList.toggle('on', p.dataset.tab === LY.tab));
}
function closePeek() { document.body.classList.remove('ly-peek'); }
function setCollapsed(c) {
  LY.collapsed = c; closePeek(); applyLayout(); saveLayout();
  toast(c ? 'Ribbon collapsed. Click a tab to use it; Ctrl+F1 brings it back.' : 'Ribbon pinned open.');
}
function applyLayout() {
  const word = LY.mode !== 'acrobat';
  document.body.classList.toggle('ly-word', word);
  document.body.classList.toggle('ly-acrobat', !word);
  document.body.classList.toggle('ly-collapsed', word && LY.collapsed);
  if (word) lyTop.after(cats); else mainEl.prepend(cats);
  pin.innerHTML = icon(LY.collapsed ? 'chevron-down' : 'chevron-up');
  pin.title = LY.collapsed ? 'Pin the ribbon open (Ctrl+F1)' : 'Collapse the ribbon (Ctrl+F1)';
  showTab();
}
// collapsed ribbon: a click anywhere outside it puts the opened tab away
addEventListener('pointerdown', e => { if (document.body.classList.contains('ly-peek') && !e.target.closest('#lyPanes, #lyCats')) closePeek(); }, true);
addEventListener('keydown', e => {
  if (e.key === 'F1' && e.ctrlKey && LY.mode !== 'acrobat') { e.preventDefault(); setCollapsed(!LY.collapsed); }
  if (e.key === 'Escape') closePeek();
});

// the style bar shows only for tools and selected items that use font, size, color or line width
const STYLE_TOOLS = new Set(['text', 'edit', 'date', 'draw', 'box', 'highlight', 'strike', 'underline', 'check', 'cross']);
const STYLE_OBJS = new Set(['text', 'ink', 'box', 'mark', 'highlight', 'markup']);
function syncCtx() {
  const s = findSel();
  ctx.classList.toggle('show', S.mode === 'edit' && S.pages.length > 0 && (STYLE_TOOLS.has(S.tool) || !!(s && STYLE_OBJS.has(s.o.type))));
}
EXT.toolChanged = syncCtx;
const prevUI = EXT.updateUI;
EXT.updateUI = has => {
  prevUI?.(has);
  syncCtx();
  title.textContent = has ? S.sources[S.pages[0].src].name : APP.name;
  panes.querySelectorAll('[data-act]').forEach(b => b.disabled = !has || (b.dataset.act === 'uncrop' && !S.pages.some(p => p.full)));
  panes.querySelectorAll('[data-proxy]').forEach(b => b.disabled = $('#' + b.dataset.proxy).disabled);
};

async function settingsDialog() {
  const {value, d} = await dialog('Settings', `
    <div class="tl-form">
      <span class="full"><b>Toolbar layout</b></span>
      <label class="chk full ly-opt"><input type="radio" name="lyMode" value="word"><span><b>Word style.</b> Tabs of big labeled buttons, like Word and Outlook. The ribbon can be collapsed to give the page more room.</span></label>
      <label class="chk full ly-opt"><input type="radio" name="lyMode" value="acrobat"><span><b>Acrobat style.</b> Tool categories in a column on the left; the chosen category's tools in a strip across the top.</span></label>
      <label class="chk full"><input type="checkbox" id="lyCollapsedIn"> Collapse the ribbon (Word style). Click a tab to open it; Ctrl+F1 also switches.</label>
    </div>
    <div class="lbl">Saved for you on this computer.</div>
    <div class="lbl credit" data-credit></div>`,
    [[null, 'Cancel'], ['ok', 'Save', true]], null,
    d => { applyBrand(d); d.querySelector(`[name=lyMode][value="${LY.mode === 'acrobat' ? 'acrobat' : 'word'}"]`).checked = true; d.querySelector('#lyCollapsedIn').checked = LY.collapsed; });
  if (value !== 'ok') return;
  LY.mode = d.querySelector('[name=lyMode]:checked').value;
  LY.collapsed = d.querySelector('#lyCollapsedIn').checked;
  closePeek(); applyLayout(); saveLayout();
}

applyLayout();
updateUI();
