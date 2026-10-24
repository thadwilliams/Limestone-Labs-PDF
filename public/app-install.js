// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
'use strict';
// The editor as an installed app: PDFs the computer opens with it (file handling, Chrome/Edge on
// Windows, Mac and ChromeOS), PDFs shared to it on Android (share target, through sw.js), the
// Install button, and how to make it the default for PDFs. Nothing here touches the server.

if ('serviceWorker' in navigator && isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker not registered', e));
}

// called by sign.js once startup (a signing link, or restoring the last session) is under way
function appStarted(booted) {
  if ('launchQueue' in window) launchQueue.setConsumer(async params => {
    if (!params.files?.length) return;
    await booted;
    if (S.mode !== 'edit') return;
    const files = await Promise.all(params.files.map(h => h.getFile()));
    await openFiles(files, false, params.files.length === 1 ? params.files[0] : null);
  });
  const shared = +new URLSearchParams(location.search).get('shared');
  if (shared) booted.then(async () => {
    history.replaceState(null, '', '/');
    const cache = await caches.open('llpdf-shared'), files = [];
    for (let i = 0; i < shared; i++) {
      const r = await cache.match(`/shared/${i}`);
      if (!r) continue;
      files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || 'shared.pdf'), {type: 'application/pdf'}));
      await cache.delete(`/shared/${i}`);
    }
    if (files.length) await openFiles(files, false);
  });
}

// ---------- install & default ----------
let installEvent = null;
const runningAsApp = () => matchMedia('(display-mode: standalone)').matches;
function platform() {
  const p = (navigator.userAgentData?.platform || navigator.platform || '') + ' ' + navigator.userAgent;
  return /Android/i.test(p) ? 'android' : /iPhone|iPad|iOS/i.test(p) ? 'ios' : /CrOS|Chrome OS/i.test(p) ? 'chromeos' : /Mac/i.test(p) ? 'mac' : /Win/i.test(p) ? 'windows' : 'other';
}
const DEFAULT_STEPS = {
  windows: ['In File Explorer, right-click any PDF.', 'Choose Open with, then Choose another app.', `Pick ${APP.name} (it may be under More apps), then click Always.`],
  mac: ['In Finder, click any PDF and press ⌘I (Get Info).', `Under “Open with”, choose ${APP.name}.`, 'Click Change All, then Continue.'],
  chromeos: ['In the Files app, right-click any PDF.', 'Choose Open with, then Change default.', `Pick ${APP.name}.`],
  android: ['Phones don’t let web apps become the default for a file type.', `Instead, in your Files app (or an email), open or select a PDF, tap Share, and choose ${APP.name}.`],
  ios: ['iPhone and iPad don’t let web apps open files directly.', `Use ${APP.name} in Safari and open PDFs with the Open button.`],
  other: [`Install from Chrome or Edge, then use your system’s “Open with” setting on a PDF to choose ${APP.name} and make it the default.`],
};
function showDefaultSteps(justInstalled) {
  const os = platform();
  const body = h('div', {},
    h('p', {}, justInstalled ? `${APP.name} is installed. To have PDFs open in it when you double-click them:` : `To have PDFs on this device open in ${APP.name}:`),
    h('ol', {class: 'sg-steps'}, DEFAULT_STEPS[os].map(s => h('li', {}, s))),
    ['windows', 'mac', 'chromeos'].includes(os) ? h('p', {class: 'lbl'}, 'PDFs opened this way save straight back to the same file. Ctrl+Shift+S (⌘⇧S on a Mac) saves a copy instead.') : null,
    os === 'windows' ? windowsIconFix() : null);
  return modal(justInstalled ? 'Installed' : `Make ${APP.name} your PDF app`, body, [{label: 'Got it', value: true, primary: true}], {wide: true});
}
// Chrome and Edge on Windows leave the file icon of an installed web app's file types empty
// (the registry DefaultIcon is ",0"), so PDFs show as blank pages. Websites can't change that.
function windowsIconFix() {
  return h('p', {class: 'lbl', style: 'margin-top:10px'}, `PDFs may show a blank white icon in File Explorer. That’s a Chrome and Edge limitation on Windows for installed web apps; the files open in ${APP.name} normally.`);
}
function updateInstallButton() {
  const b = $('#bInstall');
  if (installEvent) { b.hidden = false; b.textContent = 'Install app'; }
  else if (runningAsApp() && 'launchQueue' in window) { b.hidden = false; b.textContent = 'Make default'; b.title = `How to have PDFs open in ${APP.name} when you double-click them`; }
  else b.hidden = true;
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; updateInstallButton(); });
addEventListener('appinstalled', () => { installEvent = null; updateInstallButton(); showDefaultSteps(true); });
$('#bInstall').onclick = async () => {
  if (!installEvent) return showDefaultSteps(false);
  const ev = installEvent; installEvent = null;
  ev.prompt();
  await ev.userChoice;   // 'appinstalled' follows on success and shows the default steps
  updateInstallButton();
};
updateInstallButton();
