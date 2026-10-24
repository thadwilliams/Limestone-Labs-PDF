# Third-party software

LL PDF itself is licensed under Apache 2.0 (see `LICENSE` and `NOTICE`). This file covers the libraries it bundles.

The editor ships these open-source libraries, unmodified, in `public/vendor/`. Their licenses allow commercial and internal use; keep these notices with any copy you distribute.

| Library | Version | License | File | Full license text |
|---|---|---|---|---|
| PDF.js (Mozilla Foundation) | 3.11 | Apache License 2.0 | `pdf.min.js`, `pdf.worker.min.js` | `public/vendor/LICENSE-pdfjs.txt` |
| PDF.js standard fonts: Foxit (from PDFium) and Liberation Sans | 3.11 | Foxit: BSD-style (PDFium); Liberation: SIL Open Font License 1.1 | `standard_fonts/*` | `public/vendor/standard_fonts/LICENSE_FOXIT`, `LICENSE_LIBERATION` |
| pdf-lib (Andrew Dillon) | 1.17 | MIT | `pdf-lib.min.js` | `public/vendor/LICENSE-pdf-lib.txt` |
| Lucide icons (the 51 the toolbar uses) | 0.468.0 | ISC | `icons.js` | `public/vendor/LICENSE-lucide.txt` |
| Tesseract.js (OCR) | 5.1.1 | Apache License 2.0 | `tesseract/tesseract.min.js`, `tesseract/worker.min.js` | `public/vendor/tesseract/LICENSE-tesseract.js.txt` |
| tesseract.js-core (Tesseract OCR engine, Google and contributors, compiled to WebAssembly) | 5.1.1 | Apache License 2.0 | `tesseract/tesseract-core-*.wasm.js` | `public/vendor/tesseract/LICENSE-tesseract-core.txt` |
| Tesseract English model (tessdata_best, integer version) | 4.0.0 | Apache License 2.0 | `tesseract/lang/eng.traineddata` | `public/vendor/tesseract/LICENSE-tesseract-core.txt` |

The pdf-lib bundle also contains these, under the licenses noted in the bundle's own headers:

- pako (MIT and zlib licenses)
- @pdf-lib/standard-fonts and @pdf-lib/upng (MIT)
- tslib (Apache License 2.0, Microsoft)

The signing server runs on Cloudflare Workers and uses no third-party code beyond the Workers runtime. Deploying uses Cloudflare's `wrangler` command-line tool (MIT or Apache 2.0, installed by `npm install`), which is not part of what gets served.
