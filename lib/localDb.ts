// lib/localDb.ts — local-first message cache (SQLite, the WhatsApp/Signal model).
//
// The device's SQLite DB is the source of truth the UI renders from. Opening a
// chat reads from here instantly (no network), then a background delta-sync
// pulls only messages newer than our cursor. Incoming socket messages are
// written here too, so the list is always served locally.
//
// Requires:  npx expo install expo-sqlite
//
// Wiring (next step): chat.tsx renders getCachedMessages() first, then calls
// syncChat() to fetch GET /chats/:id/messages?after=<cursor> and cacheMessages().

import { open, type DB } from '@op-engineering/op-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';   // legacy queue migration only
import * as SecureStore from 'expo-secure-store';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import type { Message } from './chatService';
import { encField, decField, clearCacheKeyStore } from './cacheCrypto';

// Engine: op-sqlite (JSI) — faster than expo-sqlite, same SQL. A thin shim keeps
// the expo-sqlite-style async API (getAllAsync/runAsync/withTransactionAsync/…)
// so every call site + all logic below stays byte-identical.
/** expo-sqlite-shaped result of a write, so call sites can read the new rowid. */
export interface RunResult { lastInsertRowId: number; changes: number }

export interface LocalDb {
  getAllAsync:          (sql: string, params?: any[]) => Promise<any[]>;
  getFirstAsync:        (sql: string, params?: any[]) => Promise<any>;
  runAsync:             (sql: string, params?: any[]) => Promise<RunResult>;
  execAsync:            (sql: string) => Promise<void>;
  withTransactionAsync: (fn: () => Promise<void>) => Promise<void>;
}

function wrap(db: DB): LocalDb {
  // Serialize TRANSACTIONS on the single op-sqlite connection. Two concurrent
  // withTransactionAsync() would both issue BEGIN → "cannot start a transaction
  // within a transaction" and lose one write. Chaining every transaction on one
  // promise makes them run one-at-a-time. Only transactions are locked (not the
  // inner runAsync calls) — locking those too would deadlock, since a transaction
  // body awaits its own runAsync while holding the lock.
  let txLock: Promise<any> = Promise.resolve();
  return {
    getAllAsync:   async (sql, params = []) => ((await db.execute(sql, params as any)).rows ?? []) as any[],
    getFirstAsync: async (sql, params = []) => (((await db.execute(sql, params as any)).rows ?? []) as any[])[0] ?? null,
    // Returns the write result rather than discarding it. It used to resolve
    // void, which made `(await runAsync(...)).lastInsertRowId` throw on undefined
    // — see services/security/auditChain.appendSecurityEvent, whose INSERT landed
    // but which then rejected while building its return value. Its only caller
    // swallowed the rejection, so the breakage was invisible.
    runAsync:      async (sql, params = []) => {
      const r: any = await db.execute(sql, params as any);
      return { lastInsertRowId: Number(r?.insertId ?? 0), changes: Number(r?.rowsAffected ?? 0) };
    },
    // op-sqlite executes ONE statement per call — split the multi-statement schema.
    execAsync:     async (sql) => { for (const s of sql.split(';')) { const t = s.trim(); if (t) db.executeSync(t); } },
    // Manual BEGIN/COMMIT so the inner runAsync (db.execute) calls stay in-txn on
    // this single connection; ROLLBACK on any throw. Serialized via txLock.
    withTransactionAsync: (fn) => {
      const run = txLock.then(async () => {
        await db.execute('BEGIN');
        try { await fn(); await db.execute('COMMIT'); }
        catch (e) { try { await db.execute('ROLLBACK'); } catch {} throw e; }
      });
      txLock = run.catch(() => {});   // a failed txn must not wedge the queue
      return run;
    },
  };
}

let _dbPromise: Promise<LocalDb> | null = null;

export function getLocalDb(): Promise<LocalDb> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = wrap(open({ name: 'vaultchat.db' }));
      // One-time reconciliation: an earlier build's op-sqlite repo layer may have
      // created `messages`/`chats` in this same file with a DIFFERENT schema.
      // If the messages table isn't ours (no `content` column), drop the pair so
      // this schema is authoritative — it's a rebuildable cache, so it's safe.
      try {
        const cols = (await db.getAllAsync(`PRAGMA table_info(messages)`)).map((c: any) => c.name);
        if (cols.length && !cols.includes('content')) {
          await db.execAsync(`DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS chats;`);
        }
      } catch {}
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA mmap_size = 268435456;
        PRAGMA cache_size = -16000;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE IF NOT EXISTS messages (
          id           INTEGER PRIMARY KEY,
          chat_id      TEXT NOT NULL,
          sender_id    TEXT,
          type         TEXT,
          content      TEXT,
          reply_to_id  INTEGER,
          meta         TEXT,
          created_at   TEXT,
          edited_at    TEXT,
          deleted_at   TEXT,
          expires_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC);
        CREATE TABLE IF NOT EXISTS chats (
          id               TEXT PRIMARY KEY,
          data             TEXT,
          last_message_at  TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_cursor (
          chat_id  TEXT PRIMARY KEY,
          last_id  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS vb_transfers (
          transfer_id  TEXT PRIMARY KEY,
          role         TEXT,
          status       TEXT,
          done         INTEGER,
          total        INTEGER,
          bytes        INTEGER,
          total_bytes  INTEGER,
          name         TEXT,
          error        TEXT,
          saved_path   TEXT,
          updated_at   INTEGER
        );
        CREATE TABLE IF NOT EXISTS vb_chunk_state (
          transfer_id     TEXT PRIMARY KEY,
          session_version INTEGER NOT NULL DEFAULT 1,
          role            TEXT,
          total_bytes     INTEGER,
          chunk_count     INTEGER,
          peer_have       TEXT,
          r2_have         TEXT,
          state           TEXT,
          last_transport  TEXT,
          driver_state    TEXT,
          src_path        TEXT,
          src_size        INTEGER,
          src_mtime       INTEGER,
          name            TEXT,
          updated_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS queues (
          q          TEXT NOT NULL,
          id         TEXT NOT NULL,
          tag        TEXT,
          data       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (q, id)
        );
        CREATE INDEX IF NOT EXISTS idx_queues_order ON queues(q, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_queues_tag ON queues(q, tag, created_at);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        CREATE INDEX IF NOT EXISTS idx_messages_preview
          ON messages(chat_id, id DESC)
          WHERE deleted_at IS NULL AND type <> 'reaction';
      `);
      // P4.2: blind search index — FTS5 over HMAC'd tokens (see the "Encrypted
      // search" section below). Created OUTSIDE the main schema batch so a
      // build whose SQLite lacks FTS5 degrades to the legacy scan instead of
      // failing the whole schema.
      try {
        await db.execAsync(`
          CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(toks, tokenize='ascii');
          CREATE TABLE IF NOT EXISTS fts_meta (k TEXT PRIMARY KEY, v TEXT);
        `);
        _ftsOk = true;
      } catch (e: any) {
        _ftsOk = false;
        console.warn('[localDb] FTS5 unavailable — search falls back to linear scan:', e?.message);
      }
      return db;
    })();
  }
  return _dbPromise;
}

// ═══ Encrypted search — blind token index (P4.2) ═══════════════════════
//
// Problem: global search decrypted up to 5000 cached rows in JS per keystroke
// (O(all local messages), lossy beyond the cap). A plaintext FTS index would
// fix the speed but defeat the at-rest cache sealing (cacheCrypto).
//
// Design: index HMAC-SHA256(k, token) instead of the token. k is a random
// per-install key in the OS keystore (SecureStore) that never leaves the
// device, so index rows reveal nothing about content without the keystore.
// For each word we index the blind tokens of its 3..8-char prefixes plus the
// whole word, so typing "hel" matches "hello" (prefix search parity with the
// old substring UX; infix matches fall back to the legacy scan when FTS finds
// nothing). rowid == message id, so results join back to `messages`.
//
// Everything here fails OPEN: no FTS5, no key, any error → legacy scan.

let _ftsOk = false;
let _ftsKey: Uint8Array | null = null;
const FTS_KEY_STORE = 'vc_search_k_v1';
const FTS_BACKFILL_CAP = 20000;   // one-time backfill ceiling (== old scan cap ×4)

async function ftsKeyBytes(): Promise<Uint8Array | null> {
  if (_ftsKey) return _ftsKey;
  try {
    let hex = await SecureStore.getItemAsync(FTS_KEY_STORE);
    if (!hex) {
      hex = Buffer.from(randomBytes(32)).toString('hex');
      await SecureStore.setItemAsync(FTS_KEY_STORE, hex);
    }
    _ftsKey = new Uint8Array(Buffer.from(hex, 'hex'));
    return _ftsKey;
  } catch { return null; }
}

const TEfts = new TextEncoder();
function blindTok(key: Uint8Array, s: string): string {
  return Buffer.from(hmac(sha256, key, TEfts.encode(s))).toString('hex').slice(0, 16);
}

function splitWords(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
}

// Index-side tokens: per word, blind tokens of prefixes 3..8 + the full word.
function indexTokens(key: Uint8Array, text: string): string {
  const out = new Set<string>();
  for (const w of splitWords(text)) {
    for (let L = 3; L <= Math.min(8, w.length); L++) out.add(blindTok(key, w.slice(0, L)));
    if (w.length === 2 || w.length > 8) out.add(blindTok(key, w));
  }
  return [...out].join(' ');
}

// Query-side: one token per query word. A ≤8-char term hits the index's
// prefix token of that exact length (so it matches every word sharing the
// prefix); a longer term hits the full-word token (exact-word match).
function queryTokens(key: Uint8Array, q: string): string[] {
  return splitWords(q).map(w => blindTok(key, w));
}

// The text worth indexing for a message: plain text bodies, or the caption of
// a decrypted media envelope ({t, mk}). Never envelopes, never key material.
function indexableText(type: string | null | undefined, content: string | null | undefined): string | null {
  if (!content || looksLikeEnvelope(content)) return null;
  if (type === 'reaction') return null;
  if (type && type !== 'text') {
    try { const j = JSON.parse(content); return typeof j?.t === 'string' && j.t ? j.t : null; } catch { return content; }
  }
  return content;
}

async function ftsUpsert(db: LocalDb, key: Uint8Array, id: number, type: string | null, content: string | null, deleted: boolean): Promise<void> {
  try {
    await db.runAsync(`DELETE FROM msg_fts WHERE rowid = ?`, [id]);
    if (deleted) return;
    const text = indexableText(type, content);
    if (!text) return;
    const toks = indexTokens(key, text);
    if (toks) await db.runAsync(`INSERT INTO msg_fts (rowid, toks) VALUES (?, ?)`, [id, toks]);
  } catch { /* index is best-effort; search falls back to scan */ }
}

// One-time backfill of the newest FTS_BACKFILL_CAP cached rows, run lazily on
// first search (so boot pays nothing). Also validates the key: if the stored
// keycheck doesn't match (keystore wiped/rotated), the index is rebuilt.
async function ensureFtsReady(db: LocalDb): Promise<Uint8Array | null> {
  if (!_ftsOk) return null;
  const key = await ftsKeyBytes();
  if (!key) return null;
  try {
    const check = blindTok(key, 'vc-keycheck');
    const row = await db.getFirstAsync(`SELECT v FROM fts_meta WHERE k = 'keycheck'`);
    if (row?.v === check) return key;              // index live and key matches
    // Fresh or key-mismatched index → rebuild.
    await db.runAsync(`DELETE FROM msg_fts`, []);
    const rows = await db.getAllAsync(
      `SELECT id, type, content, deleted_at FROM messages
        WHERE content IS NOT NULL AND deleted_at IS NULL
        ORDER BY id DESC LIMIT ?`, [FTS_BACKFILL_CAP]);
    await db.withTransactionAsync(async () => {
      for (const r of rows as any[]) {
        const text = indexableText(r.type, decField(r.content));
        if (!text) continue;
        const toks = indexTokens(key, text);
        if (toks) await db.runAsync(`INSERT INTO msg_fts (rowid, toks) VALUES (?, ?)`, [r.id, toks]);
      }
    });
    await db.runAsync(`INSERT INTO fts_meta (k, v) VALUES ('keycheck', ?)
                       ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [check]);
    return key;
  } catch { return null; }
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    senderId: r.sender_id,
    type: r.type,
    content: decField(r.content),
    replyToId: r.reply_to_id,
    meta: r.meta ? safeParse(decField(r.meta)!) : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    expiresAt: r.expires_at,
  } as Message;
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

/** Upsert a batch of messages and advance the per-chat sync cursor. */
export async function cacheMessages(chatId: string, msgs: Message[]): Promise<void> {
  if (!msgs || !msgs.length) return;
  const db = await getLocalDb();
  // P4.2: this is the single choke point where searchable plaintext passes
  // through (pre-encField), so the blind index is maintained here. Key is
  // only fetched when the index is live; failures degrade to legacy search.
  const ftsKey = _ftsOk ? await ftsKeyBytes() : null;
  await db.withTransactionAsync(async () => {
    for (const m of msgs) {
      if (typeof m.id !== 'number' || m.id <= 0) continue; // skip optimistic temp rows
      // Upsert. CRITICAL for delete-on-delivery: if the server has purged the
      // body (content null) but we already hold the plaintext locally, KEEP the
      // local copy — never let a re-sync/back-page wipe cached content. Same for
      // meta. A real edit (non-null content) still overwrites.
      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender_id, type, content, reply_to_id, meta, created_at, edited_at, deleted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           chat_id     = excluded.chat_id,
           sender_id   = excluded.sender_id,
           type        = excluded.type,
           content     = COALESCE(excluded.content, messages.content),
           reply_to_id = excluded.reply_to_id,
           meta        = COALESCE(excluded.meta, messages.meta),
           created_at  = excluded.created_at,
           edited_at   = excluded.edited_at,
           deleted_at  = excluded.deleted_at,
           expires_at  = excluded.expires_at`,
        [
          m.id, chatId, (m as any).senderId ?? null, m.type ?? null, encField(m.content ?? null),
          m.replyToId ?? null, encField(m.meta != null ? JSON.stringify(m.meta) : null),
          m.createdAt ?? null, m.editedAt ?? null, m.deletedAt ?? null, (m as any).expiresAt ?? null,
        ],
      );
      if (ftsKey) {
        // Keep the blind index in step: (re)index edits, drop deletions.
        // Content-null purge (delete-on-delivery) keeps the local copy above,
        // so it also keeps the index row (only re-index when we HAVE text).
        if (m.deletedAt) await ftsUpsert(db, ftsKey, m.id, m.type ?? null, null, true);
        else if (m.content != null) await ftsUpsert(db, ftsKey, m.id, m.type ?? null, m.content, false);
      }
    }
  });
  const maxId = msgs.reduce((a, m) => (typeof m.id === 'number' && m.id > a ? m.id : a), 0);
  if (maxId > 0) {
    await db.runAsync(
      `INSERT INTO sync_cursor (chat_id, last_id) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`,
      [chatId, maxId],
    );
  }
}

/** Newest `limit` messages for a chat, newest-first (matches the inverted list). */
export async function getCachedMessages(chatId: string, limit = 50): Promise<Message[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
    [chatId, limit],
  );
  return rows.map(rowToMessage);
}

/**
 * A cached `content` string that is still an E2EE envelope rather than
 * decrypted plaintext — a 1:1 double-ratchet blob (`{"v":"dr1",…}`) or a group
 * sender-key blob (`GSK1:…`). Hydrate leaves these in place when decryption
 * fails, so the chat-list preview and global search must never surface them as
 * text (else the row shows raw ciphertext like `{"v":"dr1","env":…}`).
 */
export function looksLikeEnvelope(text: string | null | undefined): boolean {
  if (!text) return false;
  if (text.startsWith('GSK1:')) return true;
  if (text[0] === '{') { try { return JSON.parse(text)?.v === 'dr1'; } catch { return true; } }
  return false;
}

/**
 * The newest cached message for each chat — used by the chat list to render a
 * real last-message preview (WhatsApp-style) from local plaintext, since the
 * server only holds ciphertext. One query, decrypted at-rest on the way out.
 */
export async function getLastMessagePerChat(): Promise<Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>> {
  const db = await getLocalDb();
  // P4.2: the old single query GROUP BY'd the ENTIRE messages table on every
  // chat-list render — O(all cached messages), growing forever. Instead: one
  // cheap DISTINCT for the chat list, then a per-chat newest-row lookup that
  // idx_messages_preview serves in O(log n) each. Chat counts are dozens, so
  // this is dozens of index probes instead of a full-table scan.
  const chats = await db.getAllAsync(`SELECT DISTINCT chat_id FROM messages`, []);
  const out = new Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>();
  for (const c of chats as any[]) {
    const r = await db.getFirstAsync(
      `SELECT chat_id, id, content, type, sender_id FROM messages
        WHERE chat_id = ? AND deleted_at IS NULL AND type <> 'reaction'   -- F4: reference messages never preview
        ORDER BY id DESC LIMIT 1`, [c.chat_id]);
    if (!r) continue;
    const text = decField(r.content);
    // Never surface an un-decrypted envelope as preview text — null it so the
    // chat list shows a lock placeholder instead of raw ciphertext.
    out.set(r.chat_id, {
      content: looksLikeEnvelope(text) ? null : text,
      type: r.type ?? null, senderId: r.sender_id ?? null, id: r.id,
    });
  }
  return out;
}

/**
 * Global message search across ALL chats, on-device (WhatsApp-style, zero-
 * knowledge). Decrypts the at-rest cache in JS and substring-matches plaintext.
 */
export async function searchAllMessages(
  query: string, limit = 40,
): Promise<{ chatId: string; id: number; content: string; senderId: string | null; createdAt: string }[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const db = await getLocalDb();

  // P4.2: blind-index search first — O(matches) via FTS5 over HMAC tokens
  // instead of decrypting up to 5000 rows in JS per keystroke. The first call
  // pays a one-time backfill (ensureFtsReady), then queries are index-served.
  const key = await ensureFtsReady(db);
  if (key) {
    const toks = queryTokens(key, q);
    if (toks.length) {
      try {
        const rows = await db.getAllAsync(
          `SELECT m.chat_id, m.id, m.content, m.sender_id, m.created_at
             FROM msg_fts f JOIN messages m ON m.id = f.rowid
            WHERE msg_fts MATCH ? AND m.deleted_at IS NULL
            ORDER BY m.id DESC LIMIT ?`,
          [toks.map(t => `"${t}"`).join(' '), Math.max(limit * 3, 60)],
        );
        const out: { chatId: string; id: number; content: string; senderId: string | null; createdAt: string }[] = [];
        for (const r of rows as any[]) {
          const text = decField(r.content);
          if (!text || looksLikeEnvelope(text)) continue;
          // Candidates are word/prefix matches (any order); this substring
          // check restores the exact legacy phrase semantics on top.
          if (text.toLowerCase().includes(q)) {
            out.push({ chatId: r.chat_id, id: r.id, content: text, senderId: r.sender_id, createdAt: r.created_at });
            if (out.length >= limit) break;
          }
        }
        // Blind tokens only cover word PREFIXES — an infix query ("ell" in
        // "hello") legitimately misses. Only fall through to the legacy scan
        // when FTS produced nothing at all.
        if (out.length > 0) return out;
      } catch { /* fall through to the legacy scan */ }
    }
  }

  // Legacy scan (FTS unavailable, no tokenizable words, or zero FTS hits —
  // e.g. infix queries): decrypt-and-match the newest 5000 rows.
  const rows = await db.getAllAsync(
    `SELECT chat_id, id, content, sender_id, created_at FROM messages
      WHERE content IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 5000`,
    [],
  );
  const out: { chatId: string; id: number; content: string; senderId: string | null; createdAt: string }[] = [];
  for (const r of rows as any[]) {
    const text = decField(r.content);
    // Skip un-decrypted envelopes ({..."v":"dr1"...} / GSK1:) and match plaintext.
    if (!text || looksLikeEnvelope(text)) continue;
    if (text.toLowerCase().includes(q)) {
      out.push({ chatId: r.chat_id, id: r.id, content: text, senderId: r.sender_id, createdAt: r.created_at });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * P4.2: bound the local message cache. It previously grew forever, and the
 * full-scan paths (search backfill, storage attribution) scale with it. Keeps
 * the newest `keepPerChat` rows of every chat untouchable, then trims the
 * globally-oldest surplus above `maxTotal` in bounded batches (≤5000/run, so
 * a boot sweep can't jank). Server history is unaffected — scroll-back
 * re-fetches via historySync exactly like a fresh install.
 */
export async function pruneMessageCache(maxTotal = 200000, keepPerChat = 300): Promise<number> {
  const db = await getLocalDb();
  try {
    const row = await db.getFirstAsync(`SELECT COUNT(*) AS n FROM messages`);
    const total = Number(row?.n ?? 0);
    if (total <= maxTotal) return 0;
    const surplus = Math.min(total - maxTotal, 5000);
    const victims = await db.getAllAsync(
      `SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS rn
           FROM messages
       ) WHERE rn > ? ORDER BY id ASC LIMIT ?`,
      [keepPerChat, surplus],
    );
    if (!victims.length) return 0;
    const ids = (victims as any[]).map(v => v.id);
    await db.withTransactionAsync(async () => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        await db.runAsync(`DELETE FROM messages WHERE id IN (${ph})`, chunk);
        if (_ftsOk) await db.runAsync(`DELETE FROM msg_fts WHERE rowid IN (${ph})`, chunk).catch(() => {});
      }
    });
    return ids.length;
  } catch { return 0; }
}

/**
 * Map every cached attachment id → the chat it belongs to. Used by the storage
 * manager to attribute on-disk media files (named by attachment id) to chats.
 */
export async function getAttachmentChatMap(): Promise<Record<string, string>> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(`SELECT chat_id, meta FROM messages WHERE meta IS NOT NULL`, []);
  const out: Record<string, string> = {};
  for (const r of rows as any[]) {
    try {
      const meta = JSON.parse(decField(r.meta) || '');
      const aid = meta?.attachmentId;
      if (aid) out[String(aid)] = r.chat_id;
    } catch {}
  }
  return out;
}

/**
 * Every attachment in the local cache, newest first — the Bookshelf's index
 * (lib/shelf.ts, app/shelf.tsx).
 *
 * Derived from `messages` rather than a table of its own: an attachment IS a
 * cached message carrying meta.attachmentId, so there is no second store to
 * keep consistent, it works offline, and it is exactly as complete as the
 * cache. Deleted messages are excluded — a file whose message was revoked must
 * not reappear in a library view.
 */
export async function listAllAttachments(limit = 2000): Promise<Array<{
  attachmentId: string; chatId: string; messageId: number; senderId: string | null;
  filename: string; mime: string | null; size: number; createdAt: string;
}>> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT id, chat_id, sender_id, meta, created_at FROM messages
      WHERE meta IS NOT NULL AND deleted_at IS NULL
      ORDER BY id DESC LIMIT ?`, [limit]);

  const out: any[] = [];
  const seen = new Set<string>();
  for (const r of rows as any[]) {
    let meta: any;
    try { meta = JSON.parse(decField(r.meta) || ''); } catch { continue; }
    const aid = meta?.attachmentId;
    if (!aid || seen.has(String(aid))) continue;   // forwards reuse an id — list it once
    seen.add(String(aid));
    out.push({
      attachmentId: String(aid),
      chatId: r.chat_id,
      messageId: Number(r.id),
      senderId: r.sender_id ?? null,
      filename: String(meta.filename ?? meta.name ?? 'file'),
      mime: meta.mime ?? null,
      size: Number(meta.size ?? 0),
      createdAt: r.created_at ?? '',
    });
  }
  return out;
}

/** Fetch specific cached messages by id (used to resolve reply quotes for
 *  messages that aren't in the currently-rendered page). */
export async function getCachedMessagesByIds(chatId: string, ids: number[]): Promise<Message[]> {
  const want = ids.filter(n => typeof n === 'number' && n > 0);
  if (!want.length) return [];
  const db = await getLocalDb();
  const ph = want.map(() => '?').join(',');
  const rows = await db.getAllAsync(
    `SELECT * FROM messages WHERE chat_id = ? AND id IN (${ph})`,
    [chatId, ...want],
  );
  return rows.map(rowToMessage);
}

/** Highest message id we've already synced for this chat (the delta cursor). */
export async function getSyncCursor(chatId: string): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT last_id FROM sync_cursor WHERE chat_id = ?`, [chatId]);
  return r ? (r.last_id as number) : 0;
}

/** Highest message id cached across ALL chats — the global forward-catch-up
 *  cursor (messages.id is a server-global BIGSERIAL). */
/** Highest message id this device has EVER seen. Survives deletion. */
const GLOBAL_CURSOR_KEY = 'vc_global_sync_cursor';

/**
 * How far the global delta sync has progressed.
 *
 * This used to be `MAX(id) FROM messages`, which silently rewound whenever
 * messages were deleted. "Clear chat" on the chat holding the newest ids
 * therefore dropped the cursor to some older message, and the next catch-up
 * happily re-downloaded everything after it — including 10 of the messages just
 * cleared (measured on device: 56 removed, 10 returned).
 *
 * The high-water mark is now recorded separately and only ever moves FORWARD,
 * so deleting local data cannot rewind sync. MAX(id) is still honoured as a
 * floor: it seeds the value on an install that predates this key, and it keeps
 * the cursor correct if a message somehow lands without going through
 * noteGlobalSyncCursor.
 */
export async function getGlobalSyncCursor(): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT MAX(id) AS m FROM messages`);
  const fromRows = r?.m ? Number(r.m) : 0;
  const stored = Number((await getMeta(GLOBAL_CURSOR_KEY)) ?? 0) || 0;
  const cursor = Math.max(fromRows, stored);
  if (cursor > stored) await setMeta(GLOBAL_CURSOR_KEY, String(cursor)).catch(() => {});
  return cursor;
}

/** Record progress. Monotonic — never moves the cursor backwards. */
export async function noteGlobalSyncCursor(id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) return;
  const stored = Number((await getMeta(GLOBAL_CURSOR_KEY)) ?? 0) || 0;
  if (id > stored) await setMeta(GLOBAL_CURSOR_KEY, String(id)).catch(() => {});
}

/** Apply a single incoming/edited message (from socket) to the cache. */
export async function applyMessage(chatId: string, m: Message): Promise<void> {
  await cacheMessages(chatId, [m]);
}

/** Soft-delete a message locally (tombstone via deleted_at). */
export async function markCachedDeleted(chatId: string, id: number): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`UPDATE messages SET deleted_at = ? WHERE chat_id = ? AND id = ?`,
    [new Date().toISOString(), chatId, id]);
}

/** Cache the chat-list summaries so the chat list renders instantly too. */
export async function cacheChats(chats: Array<{ id: string; lastMessageAt?: string | null }>): Promise<void> {
  if (!chats?.length) return;
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    for (const c of chats) {
      await db.runAsync(
        `INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?, ?, ?)`,
        [c.id, encField(JSON.stringify(c)), (c as any).lastMessageAt ?? null],
      );
    }
  });
}

export async function getCachedChats(): Promise<any[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT data FROM chats ORDER BY (last_message_at IS NULL), last_message_at DESC`,
  );
  return rows.map((r: any) => safeParse(decField(r.data) || '')).filter(Boolean);
}

// Persist ONE chat's full detail (members, timers, pinned…) so the chat header
// renders offline. Reuses the chats table (ChatDetail is a superset of the
// summary listChats caches), keyed by id → last writer wins.
export async function cacheChatDetail(chatId: string, detail: any): Promise<void> {
  if (!chatId || !detail) return;
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?, ?, ?)`,
    [chatId, encField(JSON.stringify(detail)), (detail as any).lastMessageAt ?? null],
  );
}

/** Cached chat (detail if we have it, else the list summary) for offline header render. */
export async function getCachedChat(chatId: string): Promise<any | null> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(`SELECT data FROM chats WHERE id = ? LIMIT 1`, [chatId]);
  const row: any = rows[0];
  return row ? safeParse(decField(row.data) || '') : null;
}

// ── VaultBeam transfer runtime state (P0-2) ─────────────────────────
// Durable mirror of the in-memory transfer store so a bubble's progress/status
// survives a remount, navigation, or app restart. Not sealed — it's non-content
// runtime state (block counts, status), never the file bytes/key/name-of-content.
export async function persistVbTransfer(t: {
  transferId: string; role?: string; status?: string; done?: number; total?: number;
  bytes?: number; totalBytes?: number; name?: string; error?: string; savedPath?: string;
}): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO vb_transfers (transfer_id, role, status, done, total, bytes, total_bytes, name, error, saved_path, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(transfer_id) DO UPDATE SET
       role=excluded.role, status=excluded.status, done=excluded.done, total=excluded.total,
       bytes=excluded.bytes, total_bytes=excluded.total_bytes, name=excluded.name,
       error=excluded.error, saved_path=excluded.saved_path, updated_at=excluded.updated_at`,
    [t.transferId, t.role ?? null, t.status ?? null, t.done | 0, t.total | 0, t.bytes | 0,
     t.totalBytes | 0, t.name ?? null, t.error ?? null, t.savedPath ?? null, Date.now()]);
}
export async function loadVbTransfers(limit = 200): Promise<any[]> {
  const db = await getLocalDb();
  return db.getAllAsync(`SELECT * FROM vb_transfers ORDER BY updated_at DESC LIMIT ?`, [limit]);
}
export async function deleteVbTransfer(transferId: string): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM vb_transfers WHERE transfer_id = ?`, [transferId]);
}
// ── VaultBeam seamless resume: durable session + chunk bitmaps ──────
// The bitmaps are the resume truth (design §6). Content-free: bit positions,
// sizes and a cache path — never file bytes, the key, or the filename-of-content
// (`name` is the display name already shown in the bubble).
//
// NOT stored, on purpose: the retry queue (it is exactly ¬PeerHave ∧ ¬R2Have, so
// a stored copy could disagree with the bitmaps after a crash) and the in-flight
// set (after a crash nothing is in flight, and recording otherwise would
// suppress legitimate retries).
export async function persistVbChunkState(r: {
  transferId: string; sessionVersion?: number; role?: string; totalBytes?: number;
  chunkCount?: number; peerHave?: string; r2Have?: string; state?: string;
  lastTransport?: string; driverState?: string; srcPath?: string; srcSize?: number;
  srcMtime?: number; name?: string;
}): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO vb_chunk_state (transfer_id, session_version, role, total_bytes, chunk_count,
                                 peer_have, r2_have, state, last_transport, driver_state,
                                 src_path, src_size, src_mtime, name, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(transfer_id) DO UPDATE SET
       session_version=excluded.session_version, role=excluded.role,
       total_bytes=excluded.total_bytes, chunk_count=excluded.chunk_count,
       peer_have=excluded.peer_have, r2_have=excluded.r2_have, state=excluded.state,
       last_transport=excluded.last_transport, driver_state=excluded.driver_state,
       src_path=excluded.src_path, src_size=excluded.src_size, src_mtime=excluded.src_mtime,
       name=excluded.name, updated_at=excluded.updated_at`,
    [r.transferId, r.sessionVersion ?? 1, r.role ?? null, r.totalBytes ?? 0, r.chunkCount ?? 0,
     r.peerHave ?? '', r.r2Have ?? '', r.state ?? 'active', r.lastTransport ?? null,
     r.driverState ?? null, r.srcPath ?? null, r.srcSize ?? null, r.srcMtime ?? null,
     r.name ?? null, Date.now()]);
}

/** Rows in the shape lib/vaultBeam/persistence.ts expects (camelCase). */
export async function loadVbChunkStates(limit = 200): Promise<any[]> {
  const db = await getLocalDb();
  const rows: any[] = await db.getAllAsync(
    `SELECT * FROM vb_chunk_state ORDER BY updated_at DESC LIMIT ?`, [limit]);
  return rows.map((r) => ({
    transferId: r.transfer_id, sessionVersion: r.session_version | 0, role: r.role,
    totalBytes: r.total_bytes | 0, chunkCount: r.chunk_count | 0,
    peerHave: r.peer_have ?? '', r2Have: r.r2_have ?? '', state: r.state ?? 'active',
    lastTransport: r.last_transport ?? undefined, driverState: r.driver_state ?? undefined,
    srcPath: r.src_path ?? undefined, srcSize: r.src_size ?? undefined,
    srcMtime: r.src_mtime ?? undefined, name: r.name ?? undefined, updatedAt: r.updated_at | 0,
  }));
}

export async function deleteVbChunkState(transferId: string): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM vb_chunk_state WHERE transfer_id = ?`, [transferId]);
}

/** Reap rows whose transfer can no longer exist server-side (24 h relay TTL). */
export async function pruneVbChunkState(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM vb_chunk_state WHERE updated_at < ?`, [Date.now() - maxAgeMs]);
}

/** Keep the table bounded — drop all but the most recent `keep` transfers. */
export async function pruneVbTransfers(keep = 200): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `DELETE FROM vb_transfers WHERE transfer_id NOT IN
       (SELECT transfer_id FROM vb_transfers ORDER BY updated_at DESC LIMIT ?)`, [keep]);
}

// ═══ Durable queues + kv ═══════════════════════════════════════════════
//
// One table backs every "must survive offline" queue: the text/edit/delete
// outbox (messageQueue), media sends (mediaOutbox) and scheduled messages.
// They previously each kept a JSON array in AsyncStorage, which meant (a) the
// pending PLAINTEXT of an unsent message sat in the clear next to a sealed
// message cache, and (b) every enqueue and every flush rewrote the whole array.
// Here rows are sealed with the same cache DEK as `messages`, and each item is
// one row you can insert or delete on its own.
//
// Locked cache (no DEK): decField hands back the still-sealed string, JSON.parse
// fails, and queueList SKIPS the row rather than returning ciphertext a caller
// would cheerfully encrypt again and send. The row stays put and drains after
// unlock — the same "keep the clock running" behavior as being offline.

export type QueueName = 'msg' | 'media' | 'sched';

function unseal<T>(rows: any[]): T[] {
  const out: T[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(decField(r.data)!)); } catch { /* sealed (locked) or corrupt — skip, keep the row */ }
  }
  return out;
}

/** Insert or update one queued item. `tag` is an opaque grouping key (the chat
 *  id, for the message outboxes) stored UNSEALED so a per-chat read is an index
 *  hit rather than a decrypt-everything scan — the same trade `messages.chat_id`
 *  already makes. Never put content in it. */
export async function queuePut(q: QueueName, id: string, item: any, createdAt?: number, tag?: string | null): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO queues (q, id, tag, data, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(q, id) DO UPDATE SET data = excluded.data, tag = excluded.tag`,
    [q, id, tag ?? null, encField(JSON.stringify(item))!, createdAt ?? Date.now()],
  );
}

// Ordering is (created_at, rowid), NOT (created_at, id): ids are client-side
// temp keys that start with a RANDOM segment, so tie-breaking on them would
// shuffle two messages enqueued in the same millisecond — visible as a chat
// where two quick sends land out of order. rowid is insertion order, and
// queuePut's upsert keeps a row's original rowid across retries.
const ORDER = 'ORDER BY created_at, rowid';

/** Oldest-first items. `limit` bounds how much a single flush pass pulls into
 *  memory — an account that spent a week offline drains over several passes
 *  instead of materializing the whole backlog at once. `offset` lets a caller
 *  step past a page that is wedged (see messageQueue's flush rotation). */
export async function queueList<T = any>(q: QueueName, limit = 200, offset = 0): Promise<T[]> {
  const db = await getLocalDb();
  return unseal<T>(await db.getAllAsync(
    `SELECT data FROM queues WHERE q = ? ${ORDER} LIMIT ? OFFSET ?`, [q, limit, offset]));
}

/** Oldest-first items carrying `tag`. */
export async function queueListByTag<T = any>(q: QueueName, tag: string, limit = 500): Promise<T[]> {
  const db = await getLocalDb();
  return unseal<T>(await db.getAllAsync(
    `SELECT data FROM queues WHERE q = ? AND tag = ? ${ORDER} LIMIT ?`, [q, tag, limit]));
}

/** One item by id, wherever it sits in the queue. */
export async function queueGet<T = any>(q: QueueName, id: string): Promise<T | null> {
  const db = await getLocalDb();
  const r = await db.getFirstAsync(`SELECT data FROM queues WHERE q = ? AND id = ?`, [q, id]);
  return r ? (unseal<T>([r])[0] ?? null) : null;
}

export async function queueDelete(q: QueueName, id: string): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM queues WHERE q = ? AND id = ?`, [q, id]);
}

export async function queueCount(q: QueueName): Promise<number> {
  const db = await getLocalDb();
  const r = await db.getFirstAsync(`SELECT COUNT(*) AS n FROM queues WHERE q = ?`, [q]);
  return Number(r?.n ?? 0);
}

/** Replace a queue's whole contents in one transaction. For the low-frequency
 *  queues whose call sites already think in whole arrays (media, scheduled).
 *  ponytail: O(n) per write — fine at these volumes; use queuePut/queueDelete
 *  per item if one of them ever gets hot. */
export async function queueReplace(
  q: QueueName, items: Array<{ id: string; item: any; createdAt?: number; tag?: string | null }>,
): Promise<void> {
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM queues WHERE q = ?`, [q]);
    for (const it of items) {
      await db.runAsync(`INSERT OR REPLACE INTO queues (q, id, tag, data, created_at) VALUES (?,?,?,?,?)`,
        [q, it.id, it.tag ?? null, encField(JSON.stringify(it.item))!, it.createdAt ?? Date.now()]);
    }
  });
}

/** One-time lift of a legacy AsyncStorage JSON-array queue into SQLite. Removes
 *  the old key only after the rows are committed, so a crash mid-migration
 *  just replays it (queuePut is an upsert — re-running can't duplicate). */
export async function queueMigrate(
  q: QueueName, storageKey: string,
  idOf: (item: any) => string, createdAtOf?: (item: any) => number, tagOf?: (item: any) => string | null,
): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const id = idOf(item);
        if (id) await queuePut(q, id, item, createdAtOf?.(item), tagOf?.(item));
      }
    }
    await AsyncStorage.removeItem(storageKey);
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; }
}

/** Small named values that belong with the cache they describe (sync cursors,
 *  etc.) rather than in AsyncStorage. Not sealed — callers store opaque
 *  cursors here, never content. */
export async function getMeta(k: string): Promise<string | null> {
  const db = await getLocalDb();
  const r = await db.getFirstAsync(`SELECT v FROM kv WHERE k = ?`, [k]);
  return r?.v ?? null;
}
export async function setMeta(k: string, v: string): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
}

/** Dump all local rows for an encrypted backup. Sealed fields are decrypted here
 *  so the backup is portable across installs (it gets re-sealed under the backup
 *  layer's own key by backupService, and re-encrypted under the local DEK on
 *  importAll). Requires the cache to be unlocked, or sealed rows export as-is. */
export async function exportAll(): Promise<{ messages: any[]; chats: any[] }> {
  const db = await getLocalDb();
  const messages = (await db.getAllAsync(`SELECT * FROM messages`)).map((m: any) => ({
    ...m, content: decField(m.content), meta: decField(m.meta),
  }));
  const chats = (await db.getAllAsync(`SELECT * FROM chats`)).map((c: any) => ({
    ...c, data: decField(c.data),
  }));
  return { messages, chats };
}

/** Re-insert rows from a decrypted backup (idempotent upserts). Returns count. */
export async function importAll(data: { messages?: any[]; chats?: any[] }): Promise<number> {
  const db = await getLocalDb();
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const m of data.messages || []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (id, chat_id, sender_id, type, content, reply_to_id, meta, created_at, edited_at, deleted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [m.id, m.chat_id, m.sender_id, m.type, encField(m.content), m.reply_to_id, encField(m.meta), m.created_at, m.edited_at, m.deleted_at, m.expires_at],
      );
      n++;
    }
    for (const c of data.chats || []) {
      await db.runAsync(`INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?,?,?)`, [c.id, encField(c.data), c.last_message_at]);
    }
  });
  return n;
}

/**
 * Remove ONE chat from this device entirely — messages, search index, sync
 * position and the chat row itself.
 *
 * Four deletes, not one, and each is load-bearing:
 *   • msg_fts rows are keyed by message rowid. Left behind, the removed text
 *     stays searchable — the one place a "cleared" chat hands its content back.
 *   • sync_cursor must go WITH the chat row. (An earlier version deleted the
 *     cursor while keeping the chat, which told sync "you have nothing" and
 *     pulled the entire history straight back down — the exact bug reported.)
 *   • the chats row goes too, so the list does not keep an empty shell.
 *
 * The caller is expected to also hide the chat server-side, or `listChats` will
 * simply hand it back on the next refresh. See app/chat.tsx.
 * Returns how many messages were removed.
 */
export async function clearChatMessages(chatId: string): Promise<number> {
  const db = await getLocalDb();
  const row: any = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`, [chatId]);
  const n = row?.n | 0;

  await db.withTransactionAsync(async () => {
    if (_ftsOk) {
      try {
        await db.runAsync(
          `DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM messages WHERE chat_id = ?)`,
          [chatId]);
      } catch { /* index is best-effort; the messages still go */ }
    }
    await db.runAsync(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
    await db.runAsync(`DELETE FROM sync_cursor WHERE chat_id = ?`, [chatId]);
    await db.runAsync(`DELETE FROM chats WHERE id = ?`, [chatId]);
  });
  return n;
}

/** Wipe everything (e.g. on logout / account switch). */
export async function clearLocalDb(): Promise<void> {
  const db = await getLocalDb();
  await db.execAsync(`DELETE FROM messages; DELETE FROM chats; DELETE FROM sync_cursor; DELETE FROM queues; DELETE FROM kv;`);
  // #32 Phase B: wipe the sealed DEK envelope too, so no orphaned key survives an
  // account switch (rows are gone, so the key has nothing left to protect).
  try { await clearCacheKeyStore(); } catch {}
}
