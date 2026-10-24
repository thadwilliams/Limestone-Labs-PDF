# PDF editor and e-signing: setup guide

A free, self-hosted replacement for everyday Acrobat work: edit text, fill and create fillable forms, sign, highlight, white out, add images, merge, reorder and rotate pages, and collect signatures from several people with an audit trail. It runs in the browser on Windows, Mac, ChromeOS, Android and iPhone, and can be installed as an app that opens PDFs on double-click (Chrome or Edge).

There are two ways to run it:

| | Editor only | Editor + Get signatures |
|---|---|---|
| Where it runs | Any static web server (IIS, Apache, nginx, SharePoint/Teams static hosting, S3, Cloudflare Pages) | Your organization's Cloudflare account (Workers, Durable Objects, R2) |
| Server-side data | None. PDFs never leave the user's device | Encrypted signing files (deleted after `docDays`) and an audit record per request (kept `auditYears`) |
| Typical cost | Whatever your web server costs | $0 on Cloudflare's free tier for normal office volume (see Costs) |

**On Azure instead of Cloudflare?** The editor deploys to Azure Static Web Apps as is. The signing server needs re-implementing on Azure Functions, SQL and Blob Storage: see `PORTING-AZURE.md`.

## 1. Set the name and options

Everything specific to your organization is in one file, `public/config.js`:

```js
globalThis.APP_CONFIG = {
  name: 'Acme PDF',                  // shown in the browser tab, installed app and signature certificate
  organization: 'Acme Corp',         // "Added automatically by Acme PDF, Acme Corp." on certificates
  domain: 'pdf.acme.com',            // where it's served; '' to use the free workers.dev address
  workerName: 'acme-pdf',            // Cloudflare Worker name
  bucketName: 'acme-pdf-docs',       // Cloudflare R2 bucket for encrypted signing files
  signing: true,                     // false = editor only, Get signatures hidden
  docDays: 30,                       // days encrypted signing files are kept
  auditYears: 7,                     // years the audit record is kept (for Verify)
  tipJar: [],                        // leave empty for a work copy
  tipMessage: '',
};
```

The browser pages and the signing server both read this file, so the name, links and retention can't drift apart. The setup script copies the name, domain and bucket into `public/site.webmanifest` and `wrangler.jsonc`; don't edit those by hand.

You can also replace the icons in `public/` (`icon-192.png`, `icon-512.png`, `favicon-*.png`, `apple-touch-icon.png`, `file-icon-*.png`) with your own at the same sizes.

## 2a. Editor only (any web server)

1. Install Node.js 20 or newer, then in this folder run `npm install` and `npm run brand`.
2. Copy the contents of `public/` to your web server. It must be served over HTTPS (browsers only allow installing the app and its offline features on HTTPS).

Set `signing: false` first, so Get signatures is hidden. That's all: there's no server code, database or account.

## 2b. Editor + Get signatures (Cloudflare)

You need a Cloudflare account (free is fine) and, for a custom address like `pdf.acme.com`, a domain whose DNS is on that account. Without one, set `domain: ''` and it gets a free `https://<workerName>.<account>.workers.dev` address.

1. Install Node.js 20 or newer.
2. In this folder: `npm install`, then `npm run setup`.

The setup script:
- checks the Cloudflare login (opens a browser to sign in if needed; if the login can reach more than one account, set `CLOUDFLARE_ACCOUNT_ID` first)
- creates the R2 bucket
- deploys the Worker and site to your domain
- creates the two secret keys (`TOKEN_SECRET`, `AUDIT_SECRET`) with random values

It's safe to run again: it never replaces existing secret keys. Replacing `AUDIT_SECRET` would make older audit records fail their integrity check, so don't rotate it.

R2 has to be turned on once per Cloudflare account (dashboard, R2 Object Storage). The script stops with instructions if it isn't.

After changing `config.js` later, run `npm run deploy`.

## How it works

### Editing (both setups)

All editing happens in the browser with two open-source libraries (PDF.js to display, pdf-lib to write). Files are never uploaded. Work in progress is kept in the browser's own storage (IndexedDB) on that device until the user clicks Close, so a refresh doesn't lose it. On shared computers, users should click Close when done.

### Acrobat-style tools (`public/tools.js`)

Also in the browser, with nothing uploaded:

- **Redact.** Marked areas are removed for good on Save: each page with a redaction is rebuilt as a flat image with the black boxes burned in, and the comments, links and form fields on that page are dropped. Every word outside the boxes is put back as invisible text, so the page stays searchable. **Whiteout only covers**; its tooltip says so.
- **OCR** for scans and photos (Tesseract, in the browser; about 10 MB downloads the first time it's used and the browser keeps it). Words become searchable at once, so Find and Redact all work on scans, and Save writes them as invisible text, so the saved PDF can be searched and copied anywhere. Opening a file with no text offers it. Check important numbers by eye: OCR misreads some smudged or handwritten text.
- **Find** (Ctrl+F), with Highlight all and Redact all.
- **Highlight, Strikethrough, Underline.** Real PDF markup that snaps to the letters you drag over (including OCR'd scans) and appears in Acrobat's comment list. Double-click one to attach a comment.
- **Comments** are real PDF sticky notes with the author's name. On Azure Static Web Apps or App Service, the name defaults to the signed-in user.
- **Comments list** (Annotate tab): every comment and mark in the file, including ones made in Acrobat, with replies. Click one to go to it; reply (saved as a real reply), edit, or remove. Removing works for comments in the first file you opened, not in merged-in pages.
- **Compare** (Tools tab): pick another version of the document to see every word that was changed, added or removed, page by page. Scans are read with OCR first. **Mark up this document** adds green highlights with what each change was, and red notes where words were removed.
- **Print** (Ctrl+P prints the document, not the editor).
- **Pages:** insert a blank page (the + under each thumbnail), extract or split pages, crop.
- **Stamp:** page numbers, headers, footers, Bates numbers and watermarks.
- **Protect:** a password to open (AES-256, opens in Acrobat, Edge, Chrome and Mac Preview), optionally blocking printing, copying or editing.
- **Smaller file:** scales down and recompresses photos and scans.
- Every save also drops data that nothing refers to any more, so deleted pages don't linger inside the file.

**Toolbar layouts** (`public/layout.js`). Each person picks one in Settings (the gear, top right), and it's remembered in their browser:

- **Word style** (the default): tabs of big labeled buttons (Home, Edit, Annotate, Fill & Sign, Pages, Protect, Tools). Like Word, the ribbon collapses: double-click a tab, press Ctrl+F1, or click the arrow at the end of the tabs.
- **Acrobat style:** tool categories in a column on the left, the chosen category's tools in a strip across the top.

Font, size, color and line settings float over the page only while a tool or a selected item uses them. Phones keep the compact bar, where Menu lists every group.

`tools.js` plugs into `index.html` through the `EXT` object. `npm run test:tools` checks all of the above in Edge or Chrome.

### Get signatures

1. The sender places fields for each signer and clicks Send. The browser encrypts the PDF and field data with a random 256-bit AES-GCM key, then uploads only the ciphertext.
2. Each signer gets their own link. The key is in the part of the link after `#`, which browsers never send to servers, so the server can't read documents. Optionally, each signer also needs an access code; the server stores only a salted SHA-256 hash, and locks the link after 10 wrong codes.
3. The sender delivers the links (email, text, Teams). The app doesn't send email.
4. Each signer views, consents to sign electronically, fills in their fields and signs. The last signer's browser builds the finished PDF and appends a Signature Certificate page.
5. Anyone can check a finished PDF at `/verify`; only its SHA-256 fingerprint is sent.

What the server stores, per signing request (one Cloudflare Durable Object each):
- the encrypted document and fields (in R2), deleted after `docDays` or when the sender cancels
- signer link IDs and access-code hashes
- an audit log: time, IP address, approximate location from the IP (Cloudflare's lookup), and browser/device type for each step (created, sent, opened, wrong code, consented, signed, completed). Each event includes the hash of the previous one and an HMAC signature with `AUDIT_SECRET`, so changing or removing events is detectable. Kept `auditYears`.

No email addresses, phone numbers, accounts, cookies, analytics or ads. Cleanup runs automatically (Durable Object alarms); there's nothing to schedule.

### Legal standing

Signatures are electronic signatures under the US ESIGN Act and state UETA laws (intent, consent, retained record). This is **not** a certificate-based digital signature, so Acrobat won't show a "signed" badge, and signer identity isn't verified beyond the link and optional code. The full explanation users see is at `/esign`. For high-stakes or regulated documents, use an identity-verified service. This is general information, not legal advice; check with your counsel for your use cases.

### Things IT should know

- **Who can send.** There's no login. Anyone who can reach the site can create signing requests. To limit it to staff, put the whole site behind Cloudflare Access (free for up to 50 users) if all signers are internal. If outside people need to sign, the site has to stay public; ask the maintainer to add sender sign-in.
- **Where data lives.** Cloudflare (US-based; R2 and Durable Objects choose a location near first use). Cloudflare logs requests briefly for security. The Worker logs (Workers Observability) record request paths and errors, not document contents.
- **Browser support.** Built for current Chrome, Edge, Safari and Firefox; tested most heavily in Chrome and Edge. Installing as the default PDF app needs Chrome or Edge on Windows, Mac or ChromeOS.
- **Updating.** Replace the files (keep your `config.js`), then run `npm run deploy` (or re-copy `public/` for editor-only).

## Costs (Cloudflare, at the time of writing)

Check https://www.cloudflare.com/plans/developer-platform/ for current numbers.

- Workers free plan: 100,000 requests per day. A signing request uses roughly 20 to 50 requests in total.
- Durable Objects (SQLite) are included in the free plan with 5 GB of storage. Each audit record is a few KB.
- R2 free tier: 10 GB stored, with no charge for downloads. Files are deleted after `docDays`.
- If you outgrow it, the Workers Paid plan is $5 per month.

## Files

- `public/config.js`: your settings
- `public/`: the editor (`index.html`), Acrobat-style tools (`tools.js`, `review.js`, `layout.js`), signing (`sign.js`), fillable forms (`forms.js`), install support (`app-install.js`, `sw.js`), `/verify`, `/esign`
- `src/worker.js`: the signing server
- `scripts/setup.mjs`: the setup script
- `ARCHITECTURE.md`: how the code fits together, for changing it
- `LICENSE` and `NOTICE`: this project's license (Apache 2.0) and the Limestone Labs attribution to keep with copies you share
- `THIRD-PARTY-NOTICES.md`: licenses of the bundled libraries (PDF.js, pdf-lib, Tesseract, Lucide, fonts)
