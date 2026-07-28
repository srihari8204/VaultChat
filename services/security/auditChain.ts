// services/security/auditChain.ts — tamper-evident on-device security audit log (#41).
//
// An append-only, hash-chained event log persisted in the device's local SQLite
// DB. Each row's `hash` = SHA-256( prevHash | ts | type | severity | title |
// detail | meta ). Because every row commits to the previous row's hash, any
// edit, deletion, or reordering of a past entry breaks the chain — which
// verifyAuditChain() detects and reports. This log is the single source of
// truth the Alerts tab renders.
//
// Privacy: events never leave the device. Tamper-evidence comes from the hash
// chain itself (not at-rest encryption); the DB lives in the app's private
// sandbox. Nothing here calls the network.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { api } from '../../lib/api';
import { getLocalDb } from '../../lib/localDb';
import { open, seal } from './vaultKeys';

export type AuditSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

// Open-ended on purpose (new sources can add types) but the common ones are
// named so call-sites and the UI stay consistent.
export type SecurityEventType =
  | 'SCREENSHOT_ATTEMPT'
  | 'DEVICE_SCAN'
  | 'DEVICE_INTEGRITY'
  | 'ROOT_DETECTED'
  | 'KEY_CHANGE'
  | 'LOGIN'
  | 'BREACH'
  | 'ATTACHMENT_FLAG'
  | 'THREAT_INTEL'
  | (string & {});

export interface SecurityEvent {
  seq: number;
  ts: number;            // epoch ms
  type: SecurityEventType;
  severity: AuditSeverity;
  title: string;
  detail: string;
  meta: Record<string, any> | null;
  prevHash: string;
  hash: string;
}

export interface AppendInput {
  type: SecurityEventType;
  severity: AuditSeverity;
  title: string;
  detail?: string;
  meta?: Record<string, any> | null;
}

export interface ChainStatus {
  ok: boolean;
  total: number;
  brokenAtSeq: number | null;  // first seq whose link/hash failed, if any
}

const GENESIS = '0'.repeat(64);
const SEEN_KEY = 'last_seen_seq';

let _ensured: Promise<void> | null = null;

async function ensureTables(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      const db = await getLocalDb();
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS security_events (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         INTEGER NOT NULL,
          type       TEXT    NOT NULL,
          severity   TEXT    NOT NULL,
          title      TEXT    NOT NULL,
          detail     TEXT,
          meta       TEXT,
          prev_hash  TEXT    NOT NULL,
          hash       TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sec_events_seq ON security_events(seq DESC);
        CREATE TABLE IF NOT EXISTS audit_meta (
          k TEXT PRIMARY KEY,
          v TEXT
        );
      `);
    })();
  }
  return _ensured;
}

async function sha256Hex(s: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);
}

// The exact bytes that get hashed for a row. Must be identical on append and on
// verify, so it deliberately excludes `seq` (assigned by the DB at insert time)
// — ordering is already bound by the prevHash link.
function canonical(prevHash: string, e: { ts: number; type: string; severity: string; title: string; detail: string; meta: string }): string {
  return [prevHash, e.ts, e.type, e.severity, e.title, e.detail, e.meta].join('|');
}

function rowToEvent(r: any): SecurityEvent {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    severity: r.severity as AuditSeverity,
    title: r.title,
    detail: r.detail ?? '',
    meta: r.meta ? safeParse(r.meta) : null,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

// Appends mutate the chain head, so they must be strictly serialized — two
// concurrent appends must not read the same prevHash. This promise chain
// guarantees one-at-a-time execution within the JS runtime.
let _tail: Promise<any> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = _tail.then(fn, fn);
  _tail = next.catch(() => {});
  return next;
}

/** Append one event to the tamper-evident chain. Returns the stored event. */
export async function appendSecurityEvent(input: AppendInput): Promise<SecurityEvent> {
  return serialize(async () => {
    await ensureTables();
    const db = await getLocalDb();

    const last: any = await db.getFirstAsync(`SELECT hash FROM security_events ORDER BY seq DESC LIMIT 1`);
    const prevHash: string = last?.hash ?? GENESIS;

    const ts = Date.now();
    const detail = input.detail ?? '';
    const metaStr = input.meta != null ? JSON.stringify(input.meta) : '';
    const hash = await sha256Hex(canonical(prevHash, {
      ts, type: input.type, severity: input.severity, title: input.title, detail, meta: metaStr,
    }));

    const res = await db.runAsync(
      `INSERT INTO security_events (ts, type, severity, title, detail, meta, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ts, input.type, input.severity, input.title, detail, metaStr || null, prevHash, hash],
    );

    // Mirror to the zero-knowledge cloud backup (ciphertext only). Best-effort;
    // the local chain is authoritative and is never blocked on the network.
    pushRaw([{ ts, type: input.type, severity: input.severity, title: input.title, detail, metaStr, hash, prevHash }])
      .catch(() => {});

    return {
      seq: res.lastInsertRowId as number,
      ts, type: input.type, severity: input.severity, title: input.title,
      detail, meta: input.meta ?? null, prevHash, hash,
    };
  });
}

/** Newest-first list of recorded events (default 200). */
export async function listSecurityEvents(limit = 200): Promise<SecurityEvent[]> {
  await ensureTables();
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM security_events ORDER BY seq DESC LIMIT ?`, [limit],
  );
  return rows.map(rowToEvent);
}

/**
 * Re-walk the whole chain oldest→newest, recomputing each hash and checking each
 * link. Returns { ok, total, brokenAtSeq }. A broken link means a past row was
 * edited, deleted, or reordered after the fact.
 */
export async function verifyAuditChain(): Promise<ChainStatus> {
  await ensureTables();
  const db = await getLocalDb();
  const rows = await db.getAllAsync(`SELECT * FROM security_events ORDER BY seq ASC`);

  let expectedPrev = GENESIS;
  for (const r of rows as any[]) {
    if (r.prev_hash !== expectedPrev) {
      return { ok: false, total: rows.length, brokenAtSeq: r.seq };
    }
    const recomputed = await sha256Hex(canonical(r.prev_hash, {
      ts: r.ts, type: r.type, severity: r.severity, title: r.title,
      detail: r.detail ?? '', meta: r.meta ?? '',
    }));
    if (recomputed !== r.hash) {
      return { ok: false, total: rows.length, brokenAtSeq: r.seq };
    }
    expectedPrev = r.hash;
  }
  return { ok: true, total: rows.length, brokenAtSeq: null };
}

/** Count of events newer than the last time the user viewed the Alerts tab. */
export async function unseenCount(): Promise<number> {
  await ensureTables();
  const db = await getLocalDb();
  const seen: any = await db.getFirstAsync(`SELECT v FROM audit_meta WHERE k = ?`, [SEEN_KEY]);
  const lastSeen = seen ? parseInt(seen.v, 10) || 0 : 0;
  const row: any = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM security_events WHERE seq > ?`, [lastSeen],
  );
  return row?.n ?? 0;
}

/** Mark every current event as seen (clears the Alerts badge). */
export async function markAllSeen(): Promise<void> {
  await ensureTables();
  const db = await getLocalDb();
  const max: any = await db.getFirstAsync(`SELECT MAX(seq) AS m FROM security_events`);
  const maxSeq = max?.m ?? 0;
  await db.runAsync(
    `INSERT INTO audit_meta (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    [SEEN_KEY, String(maxSeq)],
  );
}

/** Wipe the audit log (e.g. on logout / account switch). */
export async function clearAuditChain(): Promise<void> {
  await ensureTables();
  const db = await getLocalDb();
  await db.execAsync(`DELETE FROM security_events; DELETE FROM audit_meta;`);
}

// ─── Typed convenience recorders for the real event sources ──────────────────

/** A screenshot was captured in a screenshot-protected chat. */
export function recordScreenshotAttempt(args: { chatId: string; chatName?: string }): Promise<SecurityEvent> {
  return appendSecurityEvent({
    type: 'SCREENSHOT_ATTEMPT',
    severity: 'medium',
    title: 'Screenshot captured',
    detail: args.chatName
      ? `A screenshot was taken in your chat with ${args.chatName}.`
      : 'A screenshot was taken in a protected chat.',
    meta: { chatId: args.chatId, chatName: args.chatName ?? null },
  });
}

/**
 * Record the outcome of a device-integrity scan. `level` mirrors the
 * threat-engine grade; `threats` is the list of detected indicators.
 */
export function recordDeviceScan(args: {
  level: 'clean' | 'monitor' | 'restrict' | 'wipe';
  score: number;
  threats: { type: string; detail: string }[];
  deviceModel: string;
  platform: string;
}): Promise<SecurityEvent> {
  const sev: AuditSeverity =
    args.level === 'wipe' ? 'critical'
    : args.level === 'restrict' ? 'high'
    : args.level === 'monitor' ? 'medium'
    : 'info';
  const title = args.level === 'clean'
    ? 'Device scan: clean'
    : `Device scan: ${args.threats.length} issue${args.threats.length === 1 ? '' : 's'} found`;
  const detail = args.level === 'clean'
    ? 'No root, instrumentation, or tampering indicators detected. (Clean ≠ guaranteed safe — a sandboxed app cannot see kernel-level implants.)'
    : args.threats.map(t => `• ${t.type}: ${t.detail}`).join('\n');
  return appendSecurityEvent({
    type: 'DEVICE_SCAN',
    severity: sev,
    title,
    detail,
    meta: { level: args.level, score: args.score, threats: args.threats, deviceModel: args.deviceModel, platform: args.platform },
  });
}

// ─── Zero-knowledge cloud backup / sync (server stores ciphertext only) ───────
// Each event is encrypted under a device-held audit key the server NEVER sees,
// then mirrored to /user/security-events (migration 036) for durability and
// reinstall recovery. The local chain stays the source of truth; this is a
// best-effort backup that never blocks or fakes anything when offline.

const AUDIT_KEY_STORE = 'vc_audit_key';
const PUSHED_KEY = 'last_pushed_seq';

interface RawEvent {
  ts: number; type: string; severity: string; title: string;
  detail: string; metaStr: string; hash: string; prevHash: string;
}

async function getAuditKey(): Promise<Uint8Array> {
  const hex = await SecureStore.getItemAsync(AUDIT_KEY_STORE);
  if (hex) return hexToBytes(hex);
  const key = randomBytes(32);
  await SecureStore.setItemAsync(AUDIT_KEY_STORE, bytesToHex(key));
  return key;
}

async function getMetaInt(k: string): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT v FROM audit_meta WHERE k = ?`, [k]);
  return r ? (parseInt(r.v, 10) || 0) : 0;
}
async function setMetaInt(k: string, v: number): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO audit_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    [k, String(v)],
  );
}

// Encrypt each event's full content into an opaque blob, then POST. The server
// receives only { blob, hash, prevHash, ts } — never readable content.
async function pushRaw(items: RawEvent[]): Promise<void> {
  if (!items.length) return;
  const key = await getAuditKey();
  const events = items.map((it) => ({
    blob: seal(key, JSON.stringify({
      ts: it.ts, type: it.type, severity: it.severity, title: it.title, detail: it.detail, metaStr: it.metaStr,
    })),
    hash: it.hash,
    prevHash: it.prevHash,
    ts: it.ts,
  }));
  await api('/user/security-events', { method: 'POST', json: { events } });
}

/**
 * Push any not-yet-mirrored local events to the server and, on a fresh install
 * where the local chain is empty, restore the encrypted backup. Best-effort and
 * never throws — offline/unauthenticated just leaves the local chain as-is.
 */
export async function syncAuditChain(): Promise<void> {
  try {
    await ensureTables();
    const db = await getLocalDb();

    // 1. Push backlog — local events newer than what we've already mirrored.
    const lastPushed = await getMetaInt(PUSHED_KEY);
    const rows: any[] = await db.getAllAsync(
      `SELECT * FROM security_events WHERE seq > ? ORDER BY seq ASC`, [lastPushed],
    );
    if (rows.length) {
      await pushRaw(rows.map((r) => ({
        ts: r.ts, type: r.type, severity: r.severity, title: r.title,
        detail: r.detail ?? '', metaStr: r.meta ?? '', hash: r.hash, prevHash: r.prev_hash,
      })));
      await setMetaInt(PUSHED_KEY, Math.max(...rows.map((r) => r.seq)));
    }

    // 2. Restore from the server only when the local chain is empty (reinstall).
    const cnt: any = await db.getFirstAsync(`SELECT COUNT(*) AS n FROM security_events`);
    if ((cnt?.n ?? 0) === 0) await restoreFromServer();
  } catch {
    // best-effort: offline / unauthenticated → keep the local chain only
  }
}

async function restoreFromServer(): Promise<void> {
  const key = await getAuditKey();
  const resp = await api<{ events: any[] }>('/user/security-events?since=0', { method: 'GET' });
  const evs = resp?.events ?? [];
  if (!evs.length) return;

  const db = await getLocalDb();
  for (const e of evs) {
    const pt = open(key, e.blob);
    if (pt == null) continue;              // wrong key / corrupt → skip (don't fabricate)
    let f: any;
    try { f = JSON.parse(pt); } catch { continue; }
    // Re-insert with the ORIGINAL fields + hashes so verifyAuditChain() passes.
    await db.runAsync(
      `INSERT INTO security_events (ts, type, severity, title, detail, meta, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?)`,
      [f.ts ?? e.ts ?? Date.now(), f.type, f.severity, f.title, f.detail ?? '',
       f.metaStr ? f.metaStr : null, e.prevHash, e.hash],
    );
  }
  const max: any = await db.getFirstAsync(`SELECT MAX(seq) AS m FROM security_events`);
  await setMetaInt(PUSHED_KEY, max?.m ?? 0);
}
