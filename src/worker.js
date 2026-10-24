// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// Signing backend for the PDF editor (name, domain and retention come from public/config.js).
//
// Documents are encrypted in the sender's browser before upload and the key only ever
// travels in link fragments, so this Worker stores ciphertext it cannot read. What it does
// own is the evidence: per-signer access codes, and an append-only, hash-chained, signed
// audit trail of who did what, when, from which IP, approximate location and browser.
//
// Each signing request ("envelope") is its own SQLite-backed Durable Object: requests for
// one envelope are handled in order, and it schedules its own clean-up with alarms
// (files after config.docDays, the audit record after config.auditYears). Encrypted files live in R2.
// Everything that isn't /api/* is the static editor, served from ./public.

import {DurableObject} from 'cloudflare:workers';
import '../public/config.js';   // the same settings file the browser loads; sets globalThis.APP_CONFIG

const CONFIG = globalThis.APP_CONFIG;
// retention; DOC_DAYS / AUDIT_DAYS env vars override (used to exercise clean-up locally)
const DOC_DAYS = CONFIG.docDays;
const AUDIT_YEARS = CONFIG.auditYears;
const DRAFT_HOURS = 24;
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_ATTEMPTS = 10;
const TOKEN_HOURS = 12;
const MAX_SIGNERS = 20;

const enc = new TextEncoder();
const b64u = buf => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
const hmacKeys = new Map();
async function hmac(secret, msg) {
  if (!hmacKeys.has(secret)) hmacKeys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']));
  return b64u(await crypto.subtle.sign('HMAC', await hmacKeys.get(secret), enc.encode(msg)));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const fail = (status, error) => json({error}, status);
const now = () => new Date().toISOString();
const addDays = d => new Date(Date.now() + d * 864e5).toISOString();
const isHash = h => /^[0-9a-f]{64}$/.test(h || '');
const blob = obj => new Response(obj.body, {headers: {'content-type': 'application/octet-stream', 'cache-control': 'no-store'}});

async function deleteDocs(env, eid) {
  let cursor;
  do {
    const list = await env.DOCS.list({prefix: `${eid}/`, cursor});
    if (list.objects.length) await env.DOCS.delete(list.objects.map(o => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
async function readBody(req) {
  const len = +req.headers.get('content-length');
  if (!(len > 0) || len > MAX_BYTES) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength > 0 && buf.byteLength <= MAX_BYTES ? buf : null;
}

export class Envelope extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }
  exists() { return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'envelope'").toArray().length > 0; }
  setup() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS envelope (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, docs_expire_at TEXT NOT NULL, audit_expire_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',      -- draft | out | signed | complete | voided
        sender_hash TEXT NOT NULL,                 -- sha256 of the sender's management secret
        doc_hash TEXT NOT NULL,                    -- sha256 of the unencrypted PDF as sent (from the sender's browser)
        doc_bytes INTEGER, final_key TEXT, final_hash TEXT, completed_at TEXT,
        docs_deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS signers (
        idx INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, code_salt TEXT NOT NULL, code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', opened_at TEXT, signed_at TEXT);
      -- append-only: each hash covers the previous one and is signed by the server
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, body TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, sig TEXT NOT NULL);`);
  }
  one(q, ...b) { return this.sql.exec(q, ...b).toArray()[0] || null; }
  all(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  envelope() { return this.one('SELECT * FROM envelope'); }

  // ---------- audit trail ----------
  async logEvent(actx, type, signer, detail) {
    const ev = {at: now(), type, signer: signer ?? null, ip: actx?.ip || null, city: actx?.city || null, region: actx?.region || null,
      country: actx?.country || null, ua: actx?.ua || null, detail: detail || null};
    // hashing awaits, so two requests can interleave here; the primary key catches it and we retry
    for (let attempt = 0; attempt < 6; attempt++) {
      const last = this.one('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');
      const seq = last ? last.seq + 1 : 1, prev = last ? last.hash : '';
      const body = JSON.stringify({seq, ...ev});
      const hash = await sha256(prev + body), sig = await hmac(this.env.AUDIT_SECRET, hash);
      try { this.sql.exec('INSERT INTO events (seq, body, prev_hash, hash, sig) VALUES (?, ?, ?, ?, ?)', seq, body, prev, hash, sig); return; }
      catch (e) { if (!/UNIQUE|PRIMARY KEY|constraint/i.test(String(e))) throw e; }
    }
    throw new Error('could not record audit event');
  }
  async auditChain() {
    let prev = '', intact = true;
    const rows = this.all('SELECT * FROM events ORDER BY seq');
    for (const r of rows) {
      if (r.prev_hash !== prev || r.hash !== await sha256(prev + r.body) || !same(r.sig, await hmac(this.env.AUDIT_SECRET, r.hash))) intact = false;
      prev = r.hash;
    }
    return {intact, events: rows.map(r => JSON.parse(r.body))};
  }

  // ---------- clean-up ----------
  async scheduleAlarm() {
    const e = this.envelope(); if (!e) return;
    const at = e.status === 'draft' ? Date.parse(e.created_at) + DRAFT_HOURS * 36e5
      : !e.docs_deleted ? Date.parse(e.docs_expire_at) : Date.parse(e.audit_expire_at);
    await this.ctx.storage.setAlarm(at + 60e3);
  }
  async alarm() {
    const e = this.envelope(); if (!e) return;
    const t = Date.now();
    const wipe = async () => {
      await deleteDocs(this.env, e.id);
      if (e.final_hash) await this.env.DOCS.delete(`verify/${e.final_hash}`);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    };
    if (e.status === 'draft' && t > Date.parse(e.created_at) + DRAFT_HOURS * 36e5) return wipe();   // never sent
    if (t >= Date.parse(e.audit_expire_at)) return wipe();
    if (!e.docs_deleted && t >= Date.parse(e.docs_expire_at)) {
      await deleteDocs(this.env, e.id);
      this.sql.exec('UPDATE envelope SET docs_deleted = 1');
      await this.logEvent(null, 'files_deleted', null, {reason: 'retention'});
    }
    await this.scheduleAlarm();
  }

  // ---------- auth ----------
  // Sender: X-Sender-Secret (from the manage link). Signer: a short-lived token minted by unlock.
  async authorize(req, e) {
    const secret = req.headers.get('x-sender-secret');
    if (secret) return same(await sha256(secret), e.sender_hash) ? {role: 'sender'} : null;
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    if (!m) return null;
    const [eid, sid, exp, sig] = m[1].split('.');
    if (eid !== e.id || !(Date.now() < +exp)) return null;
    if (!same(sig, await hmac(this.env.TOKEN_SECRET, `${eid}.${sid}.${exp}`))) return null;
    const signer = this.one('SELECT * FROM signers WHERE id = ?', sid);
    return signer ? {role: 'signer', signer} : null;
  }

  async fetch(req) {
    const url = new URL(req.url), M = req.method;
    const eid = req.headers.get('x-envelope-id');
    let actx = {};
    try { actx = JSON.parse(req.headers.get('x-audit-ctx') || '{}'); } catch {}
    const rest = url.pathname.split('/').filter(Boolean).slice(3).join('/');

    if (M === 'POST' && url.pathname === '/api/envelopes') return this.create(req, eid, actx);
    if (!this.exists()) return fail(404, 'This signing request does not exist or has expired.');
    const e = this.envelope();
    if (url.pathname === '/internal/verify') return this.verifyInfo(e);

    const um = /^signers\/([\w-]+)\/unlock$/.exec(rest);
    if (M === 'POST' && um) return this.unlock(req, e, um[1], actx);

    const who = await this.authorize(req, e);
    if (!who) return fail(401, 'Not authorized');
    const isSender = who.role === 'sender', me = who.signer;
    const gone = e.docs_deleted ? fail(410, `The files for this signing request have been deleted (they are kept for ${DOC_DAYS} days).`) : null;

    if (M === 'GET' && rest === 'state') return this.state(e, who);
    if (M === 'GET' && rest === 'audit') return json({...await this.auditChain(), docHash: e.doc_hash, finalHash: e.final_hash, envelope: e.id});

    // sender uploads the encrypted document and layout, then sends
    const bm = /^blob\/(doc|meta)$/.exec(rest);
    if (M === 'PUT' && bm) {
      if (!isSender || e.status !== 'draft') return fail(403, 'Not allowed');
      const buf = await readBody(req); if (!buf) return fail(413, 'File too large (30 MB max)');
      await this.env.DOCS.put(`${e.id}/${bm[1]}`, buf);
      return json({ok: true});
    }
    if (M === 'POST' && rest === 'send') {
      if (!isSender || e.status !== 'draft') return fail(403, 'Not allowed');
      if (!await this.env.DOCS.head(`${e.id}/doc`) || !await this.env.DOCS.head(`${e.id}/meta`)) return fail(400, 'Upload incomplete');
      this.sql.exec("UPDATE envelope SET status = 'out'");
      await this.logEvent(actx, 'sent');
      await this.scheduleAlarm();
      return json({ok: true});
    }
    if (M === 'GET' && bm) {
      if (gone) return gone;
      if (e.status === 'voided') return fail(410, 'The sender cancelled this signing request.');
      const obj = await this.env.DOCS.get(`${e.id}/${bm[1]}`);
      return obj ? blob(obj) : fail(404, 'Not found');
    }

    if (M === 'POST' && rest === 'consent') {
      if (!me) return fail(403, 'Not allowed');
      const b = await req.json().catch(() => ({}));
      await this.logEvent(actx, 'consented', me.idx, {consentHash: isHash(b.consentHash) ? b.consentHash : null, docHashSeen: isHash(b.docHash) ? b.docHash : null, docHashMatches: b.docHash === e.doc_hash});
      return json({ok: true});
    }

    if (M === 'PUT' && rest === 'submission') {
      if (!me) return fail(403, 'Not allowed');
      if (gone) return gone;
      if (e.status !== 'out' || me.status !== 'pending') return fail(409, me.status === 'signed' ? 'You already signed this document.' : 'This document is no longer accepting signatures.');
      const buf = await readBody(req); if (!buf) return fail(413, 'Too large');
      const docHash = req.headers.get('x-doc-hash');
      let detail = {};
      try { detail = JSON.parse(req.headers.get('x-sign-detail') || '{}'); } catch {}
      await this.env.DOCS.put(`${e.id}/sub/${me.idx}`, buf);
      const upd = this.sql.exec("UPDATE signers SET status = 'signed', signed_at = ? WHERE idx = ? AND status = 'pending'", now(), me.idx);
      if (!upd.rowsWritten) return fail(409, 'You already signed this document.');
      await this.logEvent(actx, 'signed', me.idx, {docHashSeen: isHash(docHash) ? docHash : null, docHashMatches: docHash === e.doc_hash, fields: +detail.fields || null, method: String(detail.method || '').slice(0, 40) || null});
      const left = this.one("SELECT COUNT(*) AS n FROM signers WHERE status != 'signed'").n;
      if (left === 0) {
        this.sql.exec("UPDATE envelope SET status = 'signed' WHERE status = 'out'");
        await this.logEvent(null, 'all_signed');   // a system event, not something the last signer did
      }
      return json({allSigned: left === 0});
    }
    const sm = /^submissions\/(\d+)$/.exec(rest);
    if (M === 'GET' && sm) {
      if (gone) return gone;
      const obj = await this.env.DOCS.get(`${e.id}/sub/${+sm[1]}`);
      return obj ? blob(obj) : fail(404, 'Not signed yet');
    }

    // whoever's browser is around when the last signature lands assembles the final PDF
    if (M === 'PUT' && rest === 'final') {
      if (gone) return gone;
      if (e.status !== 'signed') return fail(409, e.status === 'complete' ? 'Already finished' : 'Not everyone has signed yet');
      const finalHash = req.headers.get('x-final-hash');
      if (!isHash(finalHash)) return fail(400, 'Bad request');
      const buf = await readBody(req); if (!buf) return fail(413, 'Too large');
      const key = `${e.id}/final-${rand(6)}`;
      await this.env.DOCS.put(key, buf);
      const upd = this.sql.exec("UPDATE envelope SET status = 'complete', final_key = ?, final_hash = ?, completed_at = ? WHERE status = 'signed'", key, finalHash, now());
      if (!upd.rowsWritten) { await this.env.DOCS.delete(key); return fail(409, 'Already finished'); }
      await this.env.DOCS.put(`verify/${finalHash}`, e.id);
      await this.logEvent(actx, 'completed', me ? me.idx : null, {finalHash, by: who.role});
      return json({ok: true});
    }
    if (M === 'GET' && rest === 'final') {
      if (gone) return gone;
      if (!e.final_key) return fail(404, 'Not finished yet');
      const obj = await this.env.DOCS.get(e.final_key);
      return obj ? blob(obj) : fail(404, 'Not found');
    }

    if (M === 'POST' && rest === 'void') {
      if (!isSender) return fail(403, 'Not allowed');
      if (e.status === 'complete' || e.status === 'voided') return fail(409, 'Already ' + e.status);
      await deleteDocs(this.env, e.id);
      this.sql.exec("UPDATE envelope SET status = 'voided', docs_deleted = 1");
      await this.logEvent(actx, 'voided');
      await this.scheduleAlarm();
      return json({ok: true});
    }
    return fail(404, 'Not found');
  }

  async create(req, eid, actx) {
    if (this.exists()) return fail(409, 'Try again');
    const body = await req.json().catch(() => null);
    const signers = body?.signers;
    if (!isHash(body?.docHash) || !Array.isArray(signers) || !signers.length || signers.length > MAX_SIGNERS) return fail(400, 'Bad request');
    // access codes are optional (like DocuSign / Adobe): code null means the link alone opens it
    if (signers.some(s => s.code != null && (typeof s.code !== 'string' || s.code.trim().length < 4 || s.code.length > 32))) return fail(400, 'Access codes must be 4 to 32 characters');
    const senderSecret = rand(24);
    this.setup();
    this.sql.exec('INSERT INTO envelope (id, created_at, docs_expire_at, audit_expire_at, sender_hash, doc_hash, doc_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      eid, now(), addDays(+this.env.DOC_DAYS || DOC_DAYS), addDays(+this.env.AUDIT_DAYS || AUDIT_YEARS * 365 + 2), await sha256(senderSecret), body.docHash, +body.docBytes || null);
    const out = [];
    for (const [idx, s] of signers.entries()) {
      const sid = rand(9), salt = rand(12);
      // an empty code_hash marks a link-only signer
      this.sql.exec('INSERT INTO signers (idx, id, code_salt, code_hash) VALUES (?, ?, ?, ?)', idx, sid, salt, s.code == null ? '' : await sha256(salt + s.code.trim()));
      out.push({idx, id: sid});
    }
    await this.logEvent(actx, 'created', null, {signers: signers.length, docHash: body.docHash});
    await this.scheduleAlarm();
    return json({id: eid, senderSecret, signers: out});
  }

  async unlock(req, e, sid, actx) {
    if (e.status === 'draft' || e.status === 'voided') return fail(410, e.status === 'voided' ? 'The sender cancelled this signing request.' : 'This signing request is not ready yet.');
    const s = this.one('SELECT * FROM signers WHERE id = ?', sid);
    if (!s) return fail(404, 'This signing link is not valid.');
    const linkOnly = s.code_hash === '';
    const given = (await req.json().catch(() => ({}))).code;
    // the page first asks without a code; that's not an attempt, it just learns whether one is needed
    if (!linkOnly && given == null) return json({needsCode: true});
    if (!linkOnly && s.attempts >= MAX_ATTEMPTS) return fail(423, 'Too many wrong codes. Ask the sender for a new signing link.');
    const code = String(given || '').trim();
    if (!linkOnly && !same(await sha256(s.code_salt + code), s.code_hash)) {
      this.sql.exec('UPDATE signers SET attempts = attempts + 1 WHERE idx = ?', s.idx);
      await this.logEvent(actx, 'code_failed', s.idx);
      const left = MAX_ATTEMPTS - s.attempts - 1;
      return fail(left > 0 ? 403 : 423, left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask the sender for a new signing link.');
    }
    this.sql.exec('UPDATE signers SET opened_at = COALESCE(opened_at, ?) WHERE idx = ?', now(), s.idx);
    await this.logEvent(actx, 'opened', s.idx, {auth: linkOnly ? 'link' : 'access_code'});
    const exp = Date.now() + TOKEN_HOURS * 36e5;
    return json({token: `${e.id}.${sid}.${exp}.${await hmac(this.env.TOKEN_SECRET, `${e.id}.${sid}.${exp}`)}`, idx: s.idx});
  }

  state(e, who) {
    return json({
      id: e.id, status: e.status, docHash: e.doc_hash, finalHash: e.final_hash, completedAt: e.completed_at,
      docsExpireAt: e.docs_expire_at, docsDeleted: !!e.docs_deleted,
      me: who.role === 'signer' ? who.signer.idx : null,
      // signer ids let the sender rebuild links; signers only see each other's progress
      signers: this.all('SELECT idx, id, status, opened_at, signed_at, code_hash FROM signers ORDER BY idx')
        .map(s => ({idx: s.idx, status: s.status, openedAt: s.opened_at, signedAt: s.signed_at, needsCode: s.code_hash !== '', ...(who.role === 'sender' ? {id: s.id} : {})})),
    });
  }

  async verifyInfo(e) {
    if (e.status !== 'complete') return json({found: false});
    const {intact, events} = await this.auditChain();
    return json({found: true, envelope: e.id, completedAt: e.completed_at, createdAt: e.created_at, auditIntact: intact, events: events.length,
      signers: this.all('SELECT idx, signed_at FROM signers ORDER BY idx').map(s => ({signer: s.idx + 1, signedAt: s.signed_at}))});
  }
}

// The Worker only routes: it stamps who/where onto the request (the Durable Object can't
// see the visitor's connection) and hands it to that envelope's object.
function toEnvelope(env, req, eid, path) {
  const cf = req.cf || {};
  const headers = new Headers(req.headers);
  headers.set('x-envelope-id', eid);
  headers.set('x-audit-ctx', JSON.stringify({
    ip: req.headers.get('cf-connecting-ip') || null, city: cf.city || null, region: cf.region || null,
    country: cf.country || null, ua: req.headers.get('user-agent')?.slice(0, 400) || null,
  }));
  const url = new URL(req.url);
  if (path) url.pathname = path;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return env.ENVELOPE.get(env.ENVELOPE.idFromName(eid)).fetch(new Request(url, {method: req.method, headers, body: hasBody ? req.body : undefined}));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && parts[1] === 'verify' && parts.length === 3) {
        if (!isHash(parts[2])) return fail(400, 'Bad request');
        const ptr = await env.DOCS.get(`verify/${parts[2]}`);
        return ptr ? toEnvelope(env, req, await ptr.text(), '/internal/verify') : json({found: false});
      }
      if (req.method === 'POST' && url.pathname === '/api/envelopes') return CONFIG.signing ? toEnvelope(env, req, rand(12)) : fail(404, 'Signing is turned off');
      if (parts[1] === 'envelopes' && /^[\w-]{16}$/.test(parts[2] || '')) return toEnvelope(env, req, parts[2]);
      return fail(404, 'Not found');
    } catch (e) {
      console.error(e);
      return fail(500, 'Something went wrong. Please try again.');
    }
  },
};
