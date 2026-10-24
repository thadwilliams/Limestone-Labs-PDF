# LL PDF

A free, open-source replacement for everyday Acrobat work, from [Limestone Labs](https://limestonelabs.cc). Edit PDFs, make fillable forms, redact, comment, run OCR on scans, and collect signatures from several people with a tamper-evident audit trail. It runs in any modern browser and installs as a desktop or phone app.

**Try it:** https://pdf.limestonelabs.cc

**Run your own copy:** with your company's name, on your own domain and your own cloud account, for $0 on most setups. Licensed under [Apache 2.0](LICENSE).

## Privacy

Editing happens entirely in the browser. PDFs are never uploaded, and there are no accounts, ads or tracking. The one exception is sending a document for signatures: it is encrypted in the sender's browser first, and the key travels only inside the signing links, so the server stores only ciphertext it can't read.

## Features

**Edit**
- Add text, retype existing text, add images and dates.
- Whiteout. It only covers text; use Redact to remove it.
- Draw, add boxes, check marks and X marks.
- Copy, paste, duplicate, and undo for everything.

**Annotate**
- Highlight, strikethrough and underline that snap to the letters and are saved as real PDF markup, so they show in Acrobat's comment list.
- Comments with replies, and a Comments list showing everything in the file, including comments made in other apps.

**Forms**
- Fill in any fillable PDF.
- Make fillable: add text boxes, multi-line boxes, dates, checkboxes, choice lists, pick-one buttons and signature fields. Save gives a normal fillable PDF that works in any PDF reader.

**Protect**
- Redact: removed for good on Save, while the rest of the page stays searchable.
- Find & redact every match at once.
- Password protection with AES-256, plus optional blocks on printing, copying and editing.

**Pages**
- Merge, reorder, rotate and delete pages.
- Insert blank pages, extract or split, crop.
- Page numbers, headers and footers, Bates numbers, watermarks.

**Tools**
- OCR reads scans in the browser (Tesseract), so they become searchable, redactable and copyable.
- Compare finds every word changed, added or removed between two versions.
- Smaller file shrinks photos and scans.
- Print.

**Toolbar:** a Word-style ribbon or an Acrobat-style column (Settings, the gear icon). Phones get a compact menu bar.

**Install as an app:** in Chrome or Edge, it can be the default PDF app on Windows, Mac and ChromeOS. Save then writes back to the original file. On Android, PDFs can be shared to it.

## E-signatures

**Get signatures** sends a document to one or more people:

- **Setup:** place fields for each signer (signature, initials, date, text, checkboxes and more). You can also hand a fillable PDF's own fields to signers by clicking them.
- **Links:** each signer gets a private link, and optionally an access code to send separately (for example, the link by email and the code by text). The sender delivers the links; the app doesn't send email.
- **Signing:** signers agree to sign electronically, fill in their fields and sign on any device.
- **Finished file:** the final PDF gets a Signature Certificate page. For each signer it lists times, IP addresses, approximate locations and devices.
- **Audit log:** every step is recorded in a hash-chained log signed by the server, so changing or removing any event is detectable.
- **Verify:** anyone can check a signed file at `/verify`. Only its fingerprint is sent, not the file.

These are electronic signatures under the US ESIGN Act and state UETA laws, not certificate-based digital signatures. Acrobat won't show a "signed" badge, and signer identity isn't verified beyond the link and optional code. The `/esign` page in the app explains what the record shows and what it doesn't prove.

**Each copy runs its own signing server with its own secret keys,** so your documents and audit records never touch Limestone Labs or anyone else's copy.

## Deploy it for your company

You need [Node.js](https://nodejs.org) 20 or newer. Then:

```
git clone https://github.com/thadwilliams/LL_PDF.git
cd LL_PDF
npm install
```

**First, edit `public/config.js`:**
- set `name`, `organization` and `domain` to your own
- set `tipJar: []` (the tip jar links go to Limestone Labs)
- set `signing` on or off

Everything specific to your copy is in that one file, and both the pages and the signing server read it.

Then pick one of the three options below.

### Option A: Cloudflare, with signatures (recommended)

```
npm run setup
```

This logs in to your Cloudflare account (a browser window opens), creates the storage, creates the two secret keys, and deploys to your domain. If your domain isn't on Cloudflare, set `domain: ''` and you get a free `workers.dev` address.

Cloudflare's free tier covers normal office use. For costs, security details and what IT should know, see [SETUP.md](SETUP.md).

### Option B: Azure

The editor deploys to **Azure Static Web Apps** as is; `public/staticwebapp.config.json` is included.

The signing server is written for Cloudflare. [PORTING-AZURE.md](PORTING-AZURE.md) is a complete spec for rebuilding it on Azure Functions, SQL and Blob Storage, written so Claude Code can do the port. The included end-to-end test tells you when the Azure version behaves the same.

### Option C: Editor only, on any web server

1. Set `signing: false` in `public/config.js`.
2. Run `npm run brand`.
3. Copy the `public/` folder to any HTTPS web server (IIS, nginx, Apache, S3, SharePoint static hosting and so on).

There's no server code or database.

### Updating your copy

1. Keep your `public/config.js` and any icons you replaced.
2. Run `git pull`.
3. Run `npm run deploy`, or copy `public/` again.

## Make it yours

- **Settings:** `public/config.js` (name, organization, domain, how long signing files and audit records are kept, signing on or off, tip jar).
- **Icons:** replace the PNGs in `public/` at the same sizes:
  - `icon-192.png`, `icon-512.png`
  - `favicon-*.png`
  - `apple-touch-icon.png`
  - `file-icon-*.png`
- **Code:** plain JavaScript, no build step. [ARCHITECTURE.md](ARCHITECTURE.md) explains how it fits together.
  - `public/index.html`: the core editor (opening, drawing, saving)
  - `public/tools.js`, `review.js`, `layout.js`: redaction, comments, OCR, compare, page tools and the toolbars
  - `public/forms.js`: Make fillable
  - `public/sign.js`: signing in the browser
  - `src/worker.js`: the signing server
  - `tests/e2e/`: browser tests

## Do it with Claude Code

[Claude Code](https://claude.com/claude-code) can set this up, deploy it and change it for you.

1. Install Claude Code.
2. Open a terminal in the `LL_PDF` folder and run `claude`.
3. Start with: *"Read README.md, SETUP.md and ARCHITECTURE.md first."*

Then ask in plain English. For example:

- "Set this up for Acme Corp at pdf.acme.com on our Cloudflare account, with no tip jar."
- "Deploy the editor to our Azure tenant as a Static Web App, then port the signing server following PORTING-AZURE.md."
- "Make the colors match our brand: navy #1F3A5F and orange #F28C28."
- "Add a stamp tool with APPROVED, REJECTED and RECEIVED stamps."
- "Keep signing files for 90 days and audit records for 10 years."
- "Hide OCR and Compare; our people don't need them."

Ask it to prove each change works:

- `npm run test:tools` checks the editing tools in a real browser.
- `npm run dev`, then `node tests/e2e/signing.cjs http://127.0.0.1:8787`, runs a full two-signer signing.
- To test a deployed copy, give the test its address instead: `node tests/e2e/signing.cjs https://pdf.acme.com`.

## License and attribution

LL PDF is licensed under the [Apache License 2.0](LICENSE). You can use, change and run it for any purpose, including commercially, for free. In return:

- **If you share copies** (modified or not), keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files with them.
- **Please keep the credit** "open source from Limestone Labs" that the app shows (on the start screen, in Settings, and on the verify and e-signing pages). It's a small thank-you that helps other people find the project.
- **Don't call your copy "LL PDF"** or suggest that Limestone Labs made, runs or endorses it. Your copy has your own name (`name` in `config.js`). "Built on LL PDF" is fine.

Bundled libraries (PDF.js, pdf-lib, Tesseract, Lucide icons, fonts) keep their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Contributions are welcome. Pull requests are accepted under the same Apache 2.0 license.
