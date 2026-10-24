# Architecture and extension points

How the code fits together, for anyone changing it (people or Claude Code). Tests: `npm run test:tools` checks the editing tools in a real browser; `node tests/e2e/signing.cjs <url>` runs a full two-signer signing against a running copy (`npm run dev` serves one at http://127.0.0.1:8787). The tools test tries installed Edge, then Chrome, then Playwright's Chromium (`npx playwright install chromium`).

## Architecture

The core editor stays in `index.html`. New features live in separate classic scripts, loaded in this order after `forms.js` and before `sign.js`:

`tools.js` → `review.js` → `vendor/icons.js` → `layout.js`

They share globals with `index.html` (`S`, `DOM`, `props`, `buildPdf`, `renderPages`, `pushUndo`, `select`, `toUV`, `rotVec`, `dims`, `textContent`, `getPage`, `loadPdfjs`, ...). `tools.js` defines helpers that the later files use (`el`, `dialog`, `val`, `bounds`, `overlaps`, `textWords`, `makeMarkup`, `editNote`, `getOcr`, `runOcr`, `despeckle`, `MARK_*`).

### Hooks in index.html (the full index.html diff)

- `const EXT = {build, draw, tools, thumbActs, updateUI, finish, toolChanged}`: the extension registry.
- `buildObj`: `EXT.build[o.type]` for new object types (`note`, `markup`, `ocr`).
- `drawObj`: `EXT.draw[o.type]`. `redact` draws a black box; `note`, `markup` and `ocr` draw nothing because they are written in `finish`.
- Pointer switch: `default: EXT.tools[S.tool]?.(p, u, v, e, R)`. `highlight` was removed from the `startRect` case, so tools.js handles it and it snaps to text.
- `buildThumb`: `EXT.thumbActs?.(btn, p, i)` (the insert-blank-page button).
- `updateUI`: `EXT.updateUI?.(has)`, which layout.js and review.js chain onto. `setTool`: `EXT.toolChanged?.(t)`.
- `buildPdf`: ends with `return EXT.finish ? EXT.finish(base, opts, entries) : base.save()`. It also honors crops (`p.full` holds the original box when `p.view` was cropped, including on rasterized encrypted sources).
- `pageViewport(pg, p, scale)`: viewports from `p.view` (crop), used by both page and thumbnail renders.
- `queueRender(run, always)`: every page/thumbnail render (and OCR/rasterize) runs one at a time. Concurrent first renders sharing a font produced glyphs with missing pieces in pdf.js 3.11. `cancelRenders` bumps a generation counter so stale queued renders are skipped.
- `STD_FONTS` (`vendor/standard_fonts/`) is passed as `standardFontDataUrl` in `loadPdfjs`.
- Text objects: `opacity` (watermarks) and `data-stamp` (stamps ignore clicks except with the Select tool).
- Tool buttons are found by `button[data-tool]`, never `#tools`, because layout.js moves them.
- The Whiteout tooltip and hint say it only covers.

### EXT.finish (tools.js): the last pass over every built PDF

Save, then reload with pdf-lib, then:

1. `dropComments`: removes existing annotations the user removed (`p.dropAnnots`, pdf.js ids like `"12R"`; base-source pages only).
2. `burnRedactions`: each page with `redact` objects is rendered by pdf.js and the boxes are painted in. The same page node gets the JPEG as its only content (form fields with widgets there are removed, and StructTreeRoot is dropped), and the words outside the boxes are rewritten as invisible text.
3. `addOcrText`: invisible text for OCR words.
4. `addComments`: `note` becomes a /Text annotation; `markup` becomes /Highlight, /StrikeOut or /Underline with QuadPoints and an appearance stream. Replies get /IRT, either to our object (`irt.id`) or to an existing annotation (`irt.ref`).
5. `dropUnreachable`: garbage-collects every object not reachable from the trailer. pdf-lib otherwise keeps deleted pages and replaced content in the file.

### Object types added to `p.objs`

- `redact` `{x,y,w,h,rot}`
- `note` `{x,y,w,h,rot,text,author,at,fill,irt?}`
- `markup` `{kind:'highlight'|'strike'|'underline', x,y,w,h, quads:[{x,y,w,h,rot}] (relative to x,y), color,text,author,at}`
- `ocr` `{x,y,rot,words:[{t,x,y,w,h}]}`
- Stamped text objects carry `stamp:'hf'|'wm'`.

Pages may also have `full` (pre-crop view) and `dropAnnots`. All of these live in `S.pages`, so undo/redo and IndexedDB persistence cover them unchanged.

### Other notes

- Password protection: `encryptPdf` implements AES-256 (V5/R6, ISO 32000-2 algorithm 2.B) with Web Crypto. It saves with `useObjectStreams:false` and `updateFieldAppearances:false`. Verified with pdf.js (wrong/no password rejected, user and owner passwords open, permissions honored); not yet opened in Adobe Reader.
- OCR: Tesseract.js 5.1.1 is vendored under `vendor/tesseract/`, with the English `best_int` model uncompressed (`gzip:false`) and the worker loaded from the same origin. Pages render at about 300 dpi, then get a 3x3 median despeckle, then low-confidence junk words are filtered out.
- Compare (`review.js`): Myers diff over word tokens, with punctuation split off, case-insensitive by default and capped at D=4000. Pages without text are OCR'd first, on both sides.
- `authorName()` tries localStorage, then `/.auth/me` (Azure SWA/App Service), then blank.
- Layout preference is in localStorage `pdfedit.layout`; the default is the Word ribbon. Phones (≤700px) keep the original `#mbar`, and ☰ Menu lists all panes.
- For Azure Static Web Apps, `staticwebapp.config.json` needs the mime types `.traineddata` and `.pfb` (already added here). Cloudflare needs nothing extra.
- Known limits: removed existing comments stay drawn on the canvas until Save; strike/underline on a page with no text marks the dragged box; Compare on scans can show OCR misreads as small changes.
