// Run: npx tsx lib/localDb.pending.selftest.ts
// Execute production cache code against a real on-disk SQLite database.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'vc-pending-'));
const file = join(dir, 'cache.db');
const requireHere = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('./localDb.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const key = randomBytes(32);
let locked = false;
const crypto = {
  encField(s: string | null | undefined) {
    if (s == null) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
    return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  },
  decField(s: string | null | undefined) {
    if (s == null) return null;
    if (!s.startsWith('enc:v1:') || locked) return s;
    const data = Buffer.from(s.slice(7), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
  clearCacheKeyStore: async () => {},
};
let sqlite: DatabaseSync;
function load() {
  sqlite = new DatabaseSync(file);
  const execute = (sql: string, params: any[] = []) => {
    const statement = sqlite.prepare(sql);
    if (statement.columns().length) return { rows: statement.all(...params) };
    const result = statement.run(...params);
    return { rows: [], rowsAffected: result.changes, insertId: result.lastInsertRowid };
  };
  const exports = {} as typeof import('./localDb');
  new Function('require', 'exports', compiled)((name: string) => {
    if (name === '@op-engineering/op-sqlite') return { open: () => ({ execute, executeSync: execute }) };
    if (name === '@react-native-async-storage/async-storage') return {};
    if (name === 'expo-secure-store') return { getItemAsync: async () => 'ab'.repeat(32) };
    if (name === './cacheCrypto') return crypto;
    return requireHere(name);
  }, exports);
  return exports;
}

async function main() {
  let cache = load();
  const envelope = JSON.stringify({ v: 'dr1', body: 'opaque-ciphertext' });
  const msg = (id: number, content: string | null, extra = {}) => ({
    id, content, chatId: 'chat', senderId: 'peer', type: 'text' as const,
    replyToId: null, editedAt: null, deletedAt: null,
    createdAt: '2026-09-15T00:00:00Z', ...extra,
  });
  await cache.cacheMessages('chat', [msg(1, envelope)]);
  await cache.pruneMessageCache(0, 0);
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 1, 'automatic pruning keeps sole pending copy');
  assert.equal((await cache.getCachedMessagesByIds('chat', [1]))[0].content, null);
  const disk = sqlite.prepare('SELECT pending_envelope FROM messages WHERE id=1').get() as any;
  assert.ok(disk.pending_envelope.startsWith('enc:v1:'));
  assert.ok(!disk.pending_envelope.includes('opaque-ciphertext'));
  sqlite.close();
  cache = load();
  assert.equal((await cache.getPendingEncryptedMessages('chat'))[0].content, envelope, 'retry survives reopening SQLite');
  locked = true;
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0, 'locked cache never returns sealed blob as retry input');
  locked = false;
  await cache.cacheMessages('chat', [msg(1, null)]);
  assert.equal((await cache.getPendingEncryptedMessages('chat'))[0].content, envelope, 'server purge preserves pending envelope');
  await cache.cacheMessages('chat', [msg(1, 'readable words')]);
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0, 'successful decrypt clears pending');
  const indexed = sqlite.prepare('SELECT toks FROM msg_fts WHERE rowid=1').get();
  await cache.cacheMessages('chat', [msg(1, envelope, { editedAt: '2026-09-15T01:00:00Z' })]);
  assert.equal((await cache.getCachedMessagesByIds('chat', [1]))[0].content, 'readable words');
  assert.deepEqual(sqlite.prepare('SELECT toks FROM msg_fts WHERE rowid=1').get(), indexed, 'failed decrypt keeps searchable plaintext');
  assert.equal((await cache.getPendingEncryptedMessages('chat'))[0].editedAt, '2026-09-15T01:00:00Z');
  const backup = await cache.exportAll();
  await cache.clearChatMessages('chat');
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0);
  await cache.importAll(backup);
  assert.equal((await cache.getPendingEncryptedMessages('chat'))[0].content, envelope, 'backup preserves retry inputs');
  await cache.cacheRemoteDeletion('chat', 1, '2026-09-15T02:00:00Z');
  await cache.cacheMessages('chat', [msg(1, envelope), msg(1, 'stale plaintext')]);
  const deleted = (await cache.getCachedMessagesByIds('chat', [1]))[0];
  assert.equal(deleted.type, 'system');
  assert.equal(deleted.content, null);
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0);
  assert.equal(sqlite.prepare('SELECT toks FROM msg_fts WHERE rowid=1').get(), undefined);
  await cache.cacheMessages('chat', [msg(2, envelope)]);
  await cache.markCachedDeleted('chat', 2);
  await cache.cacheMessages('chat', [msg(2, envelope)]);
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0, 'local deletion cannot requeue ciphertext');
  await cache.cacheMessages('chat', [msg(3, envelope)]);
  await cache.cacheMessages('chat', [msg(3, null, { deletedAt: '2026-09-15T03:00:00Z' })]);
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0, 'remote cache tombstone clears pending');
  await cache.cacheMessages('chat', [msg(4, envelope)]);
  await cache.noteGlobalSyncCursor(50);
  sqlite.exec("CREATE TRIGGER fail_cursor BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;");
  await assert.rejects(cache.noteGlobalSyncCursor(51), /disk write failed/);
  sqlite.exec('DROP TRIGGER fail_cursor');
  await cache.clearLocalDb();
  assert.equal((await cache.getPendingEncryptedMessages('chat')).length, 0, 'logout removes pending');
  console.log('localDb pending envelope: real SQLite durability, retry, plaintext, tombstone, backup, and wipe checks passed');
}
main().finally(() => { sqlite?.close(); rmSync(dir, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
