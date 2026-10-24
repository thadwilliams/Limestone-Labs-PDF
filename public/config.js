// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// Settings for this copy of the app: its name, who runs it, where it lives, and how long signing
// files are kept. This is the only file to edit when setting up a copy for another organization.
// The browser pages and the signing server (src/worker.js) both read it, and `npm run setup`
// (or `npm run brand`) copies the name, domain and bucket into site.webmanifest and wrangler.jsonc.
//
//   name          the app's name: browser tab, installed app, signature certificate
//   organization  who runs it; shown on the certificate ("Added automatically by <name>, <organization>")
//   domain        the web address it's served from (a domain or subdomain on your Cloudflare account)
//   workerName    the Cloudflare Worker's name
//   bucketName    the R2 bucket that holds encrypted signing files
//   signing       false hides Get signatures (an editor-only copy that can live on any web server)
//   docDays       days the encrypted files of a signing request are kept
//   auditYears    years the signing audit record is kept (so finished PDFs can still be verified)
//   tipJar        donation links; [] removes the tip jar entirely
//   tipMessage    the line shown with the tip jar
globalThis.APP_CONFIG = {
  name: 'LL PDF',
  organization: 'Limestone Labs',
  domain: 'pdf.limestonelabs.cc',
  workerName: 'pdf-editor',
  bucketName: 'pdfsign-docs',
  signing: true,
  docDays: 30,
  auditYears: 7,
  tipJar: [
    {label: 'Ko-fi', icon: '☕', url: 'https://ko-fi.com/limestonelabs'},
    {label: 'Buy Me a Coffee', icon: '☕', url: 'https://buymeacoffee.com/limestonelabs'},
    {label: 'Tip with card', icon: '\u{1F4B3}', url: 'https://buy.stripe.com/eVqeVdcmA1gmg7PfaX2Ry00'},
  ],
  tipMessage: 'This editor is free, with no ads and no account. If it saved you an Acrobat subscription, a tip keeps it running.',
};
