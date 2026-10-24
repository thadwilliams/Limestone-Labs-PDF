// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// End-to-end check of a deployed copy: send a fillable PDF to two signers, both sign in
// separate browsers, download the finished PDF, check it on /verify, and check the branding
// and retention match public/config.js. Exits non-zero on any failure.
//
//   npx playwright install chromium     (once)
//   node tests/e2e/signing.cjs https://pdf.example.com
const {chromium} = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {PDFDocument} = require('pdf-lib');

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const FIXTURE = path.join(__dirname, 'premade.pdf');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-e2e-'));
const failures = [];
const check = (ok, what, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${got !== undefined ? ': ' + got : ''}`); if (!ok) failures.push(what); };

(async () => {
  const b = await chromium.launch();
  const errors = [];
  const person = async name => {
    const ctx = await b.newContext({acceptDownloads: true, viewport: {width: 1400, height: 950}});
    await ctx.addInitScript(() => { window.showSaveFilePicker = undefined; });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    return p;
  };

  // ---- sender ----
  const snd = await person('sender');
  await snd.goto(BASE + '/');
  await snd.evaluate(() => { indexedDB.deleteDatabase('pdfedit'); localStorage.clear(); localStorage.setItem('pdfedit.esignInfoSeen', '1'); });
  await snd.reload();
  const cfg = await snd.evaluate(() => APP);
  check(await snd.title() === cfg.name, 'page title is the configured name', await snd.title());
  check(await snd.isVisible('#tipOpen') === cfg.hasTips, 'tip jar shown only when config lists links');
  await snd.setInputFiles('#fileIn', FIXTURE); await snd.waitForSelector('.page canvas');
  // with the toolbar layouts (layout.js), Get signatures is on the Fill & Sign tab
  if (await snd.$('#lyCats')) await snd.click('#lyCats [data-tab="sign"]');
  await snd.click('#bSignReq'); await snd.fill('#senderName', 'Test Sender');
  await snd.fill('.sg-row >> nth=0 >> input.sg-name', 'Alice Adams');
  await snd.click('#addSigner'); await snd.fill('.sg-row >> nth=1 >> input.sg-name', 'Bob Brown');
  await snd.click('.sg-row >> nth=0 >> .sg-sub .lbl >> nth=0');            // pick Alice
  await snd.click('#prepForm button');                                     // give her every blank field
  await snd.locator('.fld[title="Team"]').click();                         // and the pre-filled one
  await snd.click('.sg-row >> nth=1 >> .sg-sub .lbl >> nth=0');            // pick Bob
  await snd.locator('.obj.ffield[title*="Coach Signature"]').click();      // the coach signature goes to Bob
  await snd.click('#sendSign');
  await snd.getByRole('button', {name: 'Encrypt and send'}).click();
  await snd.waitForSelector('.sg-sent', {timeout: 60000});
  const rec = await snd.evaluate(() => JSON.parse(localStorage.getItem('pdfedit.sent'))[0]);
  check(rec && rec.signers.length === 2, 'request created with two signer links');

  const draw = async pg => {
    await pg.waitForSelector('#sigDlg[open]');
    const pb = await pg.locator('#sigPad').boundingBox();
    await pg.mouse.move(pb.x + 40, pb.y + 130); await pg.mouse.down();
    await pg.mouse.move(pb.x + 200, pb.y + 50, {steps: 6}); await pg.mouse.move(pb.x + 360, pb.y + 140, {steps: 6});
    await pg.mouse.up(); await pg.click('#sigUse');
  };

  // ---- first signer ----
  const alice = await person('alice');
  await alice.goto(rec.signers[0].link); await alice.waitForSelector('#sgConsent', {timeout: 60000});
  await alice.check('#sgConsent'); await alice.getByRole('button', {name: 'Continue'}).click(); await alice.waitForTimeout(400);
  const days = await alice.evaluate(() => Math.round((new Date(SG.state.docsExpireAt) - Date.now()) / 864e5));
  check(days === cfg.docDays, 'server keeps files for config docDays', days);
  await alice.fill('input.sf-input[placeholder="Athlete Name"]', 'Elizabeth Williams');
  await alice.fill('input.sf-input[placeholder="Address"]', '1 Main St, Austin TX');
  await alice.locator('input[type=radio].sf-check').nth(1).check();
  await alice.check('.obj.sfield.mine input[type=checkbox]');
  await alice.locator('.obj.sfield.mine', {hasText: 'Sign here'}).click(); await draw(alice);
  await alice.locator('.obj.sfield.mine', {hasText: 'Initial'}).click(); await draw(alice);
  await alice.locator('.obj.sfield.mine', {hasText: 'Date'}).first().click();
  const bar = await alice.textContent('.sg-acts');
  check(/10 of 10 done/.test(bar), 'first signer completed all 10 fields', bar);
  await alice.getByRole('button', {name: 'Finish signing'}).click(); await alice.getByRole('button', {name: 'Sign', exact: true}).click();
  await alice.waitForSelector('.sg-dlg h3'); await alice.getByRole('button', {name: 'Done'}).click();

  // ---- second signer finishes the document ----
  const bob = await person('bob');
  await bob.goto(rec.signers[1].link); await bob.waitForSelector('#sgConsent', {timeout: 60000});
  await bob.check('#sgConsent'); await bob.getByRole('button', {name: 'Continue'}).click(); await bob.waitForTimeout(400);
  await bob.locator('.obj.sfield.mine', {hasText: 'Sign here'}).click(); await draw(bob);
  await bob.getByRole('button', {name: 'Finish signing'}).click(); await bob.getByRole('button', {name: 'Sign', exact: true}).click();
  await bob.waitForFunction(() => SG.state?.status === 'complete', null, {timeout: 60000});
  const [dl] = await Promise.all([bob.waitForEvent('download'), bob.getByRole('button', {name: 'Download signed PDF'}).click()]);
  const signed = path.join(OUT, 'signed.pdf'); await dl.saveAs(signed);

  const doc = await PDFDocument.load(fs.readFileSync(signed));
  check(doc.getPageCount() === 2, 'signed PDF has the form page plus a certificate page', doc.getPageCount());
  check(doc.getForm().getFields().length === 0, 'signed PDF is flattened (no form fields left)');

  // ---- verify page ----
  const v = await person('verifier'); await v.goto(BASE + '/verify'); await v.setInputFiles('#file', signed);
  await v.waitForFunction(() => /Verified|No match|Could not/.test(document.querySelector('#result').textContent), null, {timeout: 30000});
  const verdict = (await v.textContent('#result h2')).trim();
  check(/Verified/.test(verdict), '/verify recognizes the finished file and its audit chain is intact', verdict);
  const tampered = path.join(OUT, 'tampered.pdf'); fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(signed), Buffer.from('\n')]));
  await v.setInputFiles('#file', tampered);
  await v.waitForFunction(() => /No match/.test(document.querySelector('#result').textContent), null, {timeout: 30000});
  check(true, '/verify rejects a modified copy');

  check(errors.length === 0, 'no JavaScript errors', errors.join(' | ') || 'none');
  await b.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message.split('\n')[0]); process.exit(1); });
