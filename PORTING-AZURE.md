# Running it on Azure

This copy was built for Cloudflare. The editor ports to Azure unchanged. The signing server (`src/worker.js`, about 370 lines) has to be re-implemented on Azure services, and this file is the spec for doing that. **`src/worker.js` is the reference implementation:** match its routes, status codes, JSON shapes and error messages exactly. The browser code (`public/sign.js`) depends on all of them.

## 1. Editor (no changes)

Deploy `public/` to **Azure Static Web Apps** (Free plan is enough). `public/staticwebapp.config.json` is already there: it maps `/verify` and `/esign` to their `.html` files and sets the manifest's content type.

Before deploying, edit `public/config.js` (name, organization, domain, retention, `tipJar: []`) and run `npm run brand` so `site.webmanifest` matches. `workerName` and `bucketName` aren't used on Azure.

For editor-only, set `signing: false` and stop here.

## 2. Signing server: what maps to what

| Cloudflare (now) | Azure (suggested) | Notes |
|---|---|---|
| Worker `fetch` handler | Azure Functions (Node 20+), HTTP trigger on `/api/{*path}` | Static Web Apps can link a Function App as its `/api` backend. Uploads can be up to 30 MB (`MAX_BYTES`), so confirm the hosting option's request-size limit allows that. |
| Durable Object `Envelope` (one SQLite database per signing request) | Azure SQL Database, or Azure Database for PostgreSQL, with the same three tables plus an `envelope_id` column on `signers` and `events` | See "Concurrency" below; this is the part to get right. |
| R2 bucket `DOCS` | Blob Storage, one **private** container, same key layout | Keys: `<eid>/doc`, `<eid>/meta`, `<eid>/sub/<idx>`, `<eid>/final-<rand>`, `verify/<finalHash>` (body is the envelope id). |
| Durable Object alarms | Timer-triggered Function (hourly) | Sweep rows by `created_at`/`docs_expire_at`/`audit_expire_at` with the same rules as `alarm()`. |
| `TOKEN_SECRET`, `AUDIT_SECRET` | Function App settings backed by Key Vault | 32 random bytes each, base64url. Never rotate `AUDIT_SECRET`: old audit records would fail verification. |
| `cf-connecting-ip` header | The client IP your front end forwards (`X-Forwarded-For`, first entry, only from your own proxy/Front Door) | Recorded in the audit trail. |
| `req.cf.city/region/country` | No built-in equivalent | Record `null` (certificates then show location "unknown"), or add an IP geolocation database. If you drop location, also update the wording in `public/esign-info.js` and `CONSENT_TEXT` in `public/sign.js`, which say approximate location is recorded. |
| `crypto.subtle` (SHA-256, HMAC-SHA-256) | Node's `crypto.webcrypto.subtle`, or `crypto.createHash`/`createHmac` | Output encodings must match: SHA-256 as lowercase hex, HMAC and random ids as base64url without padding. |

Retention values come from `public/config.js` (`docDays`, `auditYears`). The Worker imports that file directly; do the same, or read it at startup, so the browser and server can't disagree.

## 3. HTTP API (all JSON unless noted; `cache-control: no-store` on every response)

Errors are `{"error": "<message>"}` with the status shown in `worker.js`. The browser shows these messages to people, so keep the wording.

Envelope ids are `rand(12)` (16 base64url characters). Every route except create, unlock and verify needs one of:
- **Sender:** an `X-Sender-Secret` header. Valid when its SHA-256 equals `sender_hash`.
- **Signer:** `Authorization: Bearer <eid>.<sid>.<expMs>.<hmac(TOKEN_SECRET, "eid.sid.expMs")>`. The token comes from unlock and is valid for 12 hours.

| Method and path | Who | What it does |
|---|---|---|
| `POST /api/envelopes` | anyone | Body `{docHash, docBytes, signers: [{code: string or null}]}`. Creates the request in `draft`, returns `{id, senderSecret, signers: [{idx, id}]}`. Codes are 4 to 32 characters, or null for link-only; stored as `sha256(salt + code.trim())`. 1 to 20 signers. Returns 404 when `signing` is false. |
| `PUT /api/envelopes/:id/blob/doc` and `.../blob/meta` | sender, draft only | Raw encrypted bytes (octet-stream) into Blob Storage. |
| `POST /api/envelopes/:id/send` | sender, draft only | Requires both blobs. Status becomes `out`; logs `sent`. |
| `POST /api/envelopes/:id/signers/:sid/unlock` | anyone | Body `{code}`. With no code and a code required, returns `{needsCode: true}`; that probe doesn't count as an attempt. 10 wrong codes lock the link (423). On success, logs `opened` and returns `{token, idx}`. |
| `GET /api/envelopes/:id/state` | sender or signer | See `state()`. Signer ids are included only for the sender. |
| `GET /api/envelopes/:id/blob/doc` and `.../blob/meta` | sender or signer | Bytes. 410 when files were deleted or the request was cancelled. |
| `POST /api/envelopes/:id/consent` | signer | Logs `consented` with `consentHash` and `docHash`. |
| `PUT /api/envelopes/:id/submission` | signer | Bytes, plus headers `x-doc-hash` and `x-sign-detail` (JSON). Marks the signer signed exactly once (409 on repeat). When the last signer signs, status becomes `signed` and the server logs `all_signed`. Returns `{allSigned}`. |
| `GET /api/envelopes/:id/submissions/:idx` | sender or signer | Bytes of that signer's encrypted submission. |
| `PUT /api/envelopes/:id/final` | sender or signer, status `signed` | Bytes, plus header `x-final-hash`. Exactly once (409 after): stores the file, sets `complete`, writes `verify/<hash>` and logs `completed`. |
| `GET /api/envelopes/:id/final` | sender or signer | Bytes. |
| `GET /api/envelopes/:id/audit` | sender or signer | `{intact, events, docHash, finalHash, envelope}`. |
| `POST /api/envelopes/:id/void` | sender | Deletes files; status becomes `voided`; logs `voided`. |
| `GET /api/verify/:sha256hex` | anyone | `{found: false}`, or the `verifyInfo()` object for a completed request. |

## 4. Audit log (must be byte-for-byte compatible in logic)

Each event body is `JSON.stringify({seq, at, type, signer, ip, city, region, country, ua, detail})`, in that key order.

- `hash = sha256hex(prev_hash + body)`, where `prev_hash` is `''` for the first event.
- `sig = base64url(HMAC-SHA256(AUDIT_SECRET, hash))`.
- `intact` is true only if every row's `prev_hash`, `hash` and `sig` re-compute. Compare signatures in constant time.
- `ua` is truncated to 400 characters.

## 5. Concurrency (the one real design change)

A Durable Object handles one request at a time per envelope, so `worker.js` relies on that. On SQL you must get the same guarantees:

- `events`: primary key `(envelope_id, seq)`. Insert inside a transaction; on a key conflict, re-read the last row and retry, as `logEvent` does.
- Signing once: `UPDATE signers SET status='signed' ... WHERE status='pending'` and check rows affected. Do the same for `final` (`WHERE status='signed'`) and for the envelope status changes.
- Wrong-code counting: `attempts = attempts + 1` as a single UPDATE.
- Last signer: count unsigned signers in the same transaction as the update, so two simultaneous final signatures can't both miss, or both trigger, `all_signed`.

## 6. Retention sweep (timer)

This mirrors `alarm()`:
- **Drafts** older than 24 hours: delete the blobs and every row.
- **Past `docs_expire_at`:** delete the blobs, set `docs_deleted = 1`, and log `files_deleted` with `{reason: 'retention'}` and a null signer.
- **Past `audit_expire_at`:** delete everything, including `verify/<final_hash>`.

## 7. Prove it matches

`tests/e2e/signing.cjs` drives the whole flow in real browsers against any deployed URL: two signers, a fillable PDF, the finished file, `/verify`, and a tampered copy that must fail. Then it checks that the name and retention match `config.js`.

```
npm install
npx playwright install chromium
node tests/e2e/signing.cjs https://your-azure-url
```

It passes against the Cloudflare version. The Azure version is done when it passes there too.
