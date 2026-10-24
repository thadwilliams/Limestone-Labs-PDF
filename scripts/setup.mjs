// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// Sets up (or updates) this copy of the editor on your own Cloudflare account, using the
// settings in public/config.js. Safe to run again: it never replaces existing secrets.
//
//   npm run setup        copy settings into site.webmanifest + wrangler.jsonc, log in to Cloudflare,
//                        create the R2 bucket, create the two secret keys, deploy
//   npm run brand        only copy settings into site.webmanifest + wrangler.jsonc
//                        (enough for an editor-only copy served from any web server)
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = p => join(root, p);
await import(pathToFileURL(at('public/config.js')).href);
const C = globalThis.APP_CONFIG;
const args = process.argv.slice(2);
const step = msg => console.log(`\n> ${msg}`);
const fail = msg => { console.error(`\nSetup stopped: ${msg}`); process.exit(1); };

for (const k of ['name', 'organization', 'workerName', 'bucketName'])
  if (!C[k] || typeof C[k] !== 'string') fail(`"${k}" is missing in public/config.js`);
if (!/^[a-z0-9-]{1,63}$/.test(C.workerName)) fail('workerName may only use lowercase letters, digits and dashes');
if (!/^[a-z0-9-]{3,63}$/.test(C.bucketName)) fail('bucketName may only use lowercase letters, digits and dashes (3 to 63)');
if (C.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(C.domain)) fail('domain should look like pdf.example.com (no https://, no slash)');
if (!(C.docDays >= 1) || !(C.auditYears >= 1)) fail('docDays and auditYears must be at least 1');

// ---- settings into the files that can't read config.js themselves ----
function brand() {
  const str = JSON.stringify;
  const set = (text, key, value) => text.replace(new RegExp(`^(\\s*"${key}":\\s*)"[^"]*"`, 'm'), `$1${str(value)}`);
  let mf = readFileSync(at('public/site.webmanifest'), 'utf8');
  mf = set(mf, 'name', C.name);
  mf = set(mf, 'short_name', C.name.length <= 12 ? C.name : C.name.slice(0, 12).trim());
  mf = set(mf, 'description', `Free PDF editor${C.signing ? ' and e-signing' : ''} from ${C.organization}. Edits happen on your device; files are not uploaded.`);
  JSON.parse(mf);
  writeFileSync(at('public/site.webmanifest'), mf);

  let w = readFileSync(at('wrangler.jsonc'), 'utf8');
  w = set(w, 'name', C.workerName);
  w = w.replace(/("bucket_name":\s*)"[^"]*"/, `$1${str(C.bucketName)}`);
  // a custom domain if config.js names one, otherwise the free <worker>.<account>.workers.dev address
  const where = C.domain && !/\.workers\.dev$/i.test(C.domain)
    ? `"routes": [\n    {"pattern": "${C.domain}", "custom_domain": true}\n  ],`
    : `"workers_dev": true,`;
  w = w.replace(/"routes": \[[\s\S]*?\],|"workers_dev": true,/, where);
  writeFileSync(at('wrangler.jsonc'), w);
  console.log(`Settings applied: ${C.name} (${C.organization}), ${C.domain || 'workers.dev address'}, worker "${C.workerName}", bucket "${C.bucketName}".`);
}

const secret = () => randomBytes(32).toString('base64url');
// local development keys (wrangler dev reads .dev.vars; it's gitignored)
function devVars() {
  if (existsSync(at('.dev.vars'))) return;
  writeFileSync(at('.dev.vars'), `TOKEN_SECRET=${secret()}\nAUDIT_SECRET=${secret()}\n`);
  console.log('Created .dev.vars with local-only keys.');
}

const wrangler = (cmdArgs, opts = {}) => spawnSync('npx', ['wrangler', ...cmdArgs], {cwd: root, shell: true, encoding: 'utf8', stdio: opts.input != null || opts.capture ? 'pipe' : 'inherit', input: opts.input});

brand();
if (args.includes('--brand-only')) process.exit(0);
if (args.includes('--dev-vars')) { devVars(); process.exit(0); }

step('Checking your Cloudflare login');
let who = wrangler(['whoami'], {capture: true});
if (!/associated with the email|You are logged in/i.test(who.stdout + who.stderr)) {
  console.log('Not logged in yet. A browser window will open: sign in to the Cloudflare account this should live on.');
  if (wrangler(['login']).status !== 0) fail('Cloudflare login did not finish.');
  who = wrangler(['whoami'], {capture: true});
}
console.log((who.stdout.match(/associated with the email[^\n]*/i) || ['Logged in.'])[0]);
if ((who.stdout.match(/│\s*[^│\n]+│\s*[0-9a-f]{32}\s*│/g) || []).length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID)
  fail('this login can reach more than one Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID to the one to use (the IDs are listed above), then run setup again.');

step(`Creating the R2 storage bucket "${C.bucketName}" (for encrypted signing files)`);
const mk = wrangler(['r2', 'bucket', 'create', C.bucketName], {capture: true});
const mkOut = mk.stdout + mk.stderr;
if (mk.status === 0) console.log('Created.');
else if (/already exists|already own/i.test(mkOut)) console.log('Already there.');
else if (/enable R2|R2 is not enabled|10042/i.test(mkOut)) fail('R2 is not turned on for this account yet. In the Cloudflare dashboard open R2 Object Storage, turn it on (the free tier needs no payment for this use, but Cloudflare may ask for a card on file), then run setup again.');
else { console.error(mkOut); fail('could not create the R2 bucket (details above).'); }

step('Deploying');
if (wrangler(['deploy']).status !== 0) fail('the deploy failed (details above). If it mentions the domain, check that the domain in config.js is on this Cloudflare account.');

step('Creating the secret keys (only ones that do not exist yet)');
const listed = wrangler(['secret', 'list', '--format', 'json'], {capture: true});
let have = [];
try { have = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))).map(s => s.name); } catch { fail('could not read the existing secrets:\n' + listed.stdout + listed.stderr); }
for (const name of ['TOKEN_SECRET', 'AUDIT_SECRET']) {
  if (have.includes(name)) { console.log(`${name}: already set, kept.`); continue; }
  const r = wrangler(['secret', 'put', name], {input: secret() + '\n'});
  if (r.status !== 0) { console.error(r.stdout + r.stderr); fail(`could not set ${name}.`); }
  console.log(`${name}: created.`);
}
devVars();

console.log(`\nDone. ${C.name} is live at ${C.domain ? 'https://' + C.domain : 'the workers.dev address printed above'}.`);
if (!C.domain) console.log('Put that address (without https://) in "domain" in public/config.js and run "npm run deploy", so signature certificates link to it.');
