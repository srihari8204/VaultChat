// Run: npx tsx lib/localDb.protectedSearch.selftest.ts
//
// Global search and the Chats row preview read message text OUTSIDE the
// bubble, so they must apply the same rule as in-chat search: view-once and
// Invisible Ink text never leaves its bubble, and meta that is present but
// unreadable counts as protected (fail closed). Global search also skips the
// chats it is told are locked.
//
// Runs the production lib/localDb.ts against a real SQLite (node:sqlite), the
// same harness as lib/localDb.pending.selftest.ts. Both search paths are hit:
// a word-prefix query is served by the FTS blind index, an infix query falls
// through to the page scan.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'vc-protected-'));
const requireHere = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('./localDb.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
// At-rest sealing is not what this checks: plaintext pass-through.
const crypto = {
  encField: (s: string | null | undefined) => s ?? null,
  decField: (s: string | null | undefined) => s ?? null,
  clearCacheKeyStore: async () => {},
};
const sqlite = new DatabaseSync(join(dir, 'cache.db'));
const execute = (sql: string, params: any[] = []) => {
  const statement = sqlite.prepare(sql);
  if (statement.columns().length) return { rows: statement.all(...params) };
  const result = statement.run(...params);
  return { rows: [], rowsAffected: result.changes, insertId: result.lastInsertRowid };
};
const cache = {} as typeof import('./localDb');
new Function('require', 'exports', compiled)((name: string) => {
  if (name === '@op-engineering/op-sqlite') return { open: () => ({ execute, executeSync: execute }) };
  if (name === '@react-native-async-storage/async-storage') return {};
  if (name === 'expo-secure-store') return { getItemAsync: async () => 'ab'.repeat(32) };
  if (name === './cacheCrypto') return crypto;
  return requireHere(name);
}, cache);

const msg = (chatId: string, id: number, content: string, meta: unknown = null, type = 'text') => ({
  id, chatId, content, meta, senderId: 'peer', type: type as 'text',
  replyToId: null, editedAt: null, deletedAt: null, createdAt: '2026-10-04T00:00:00Z',
});

async function main() {
  await cache.cacheChats([{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]);
  await cache.cacheMessages('A', [
    msg('A', 1, 'secret plain words'),
    msg('A', 2, 'secret view once words', { viewOnce: true }),
    msg('A', 3, 'secret invisible ink words', { invisibleInk: true }),
    msg('A', 4, 'secret unreadable meta words', { caption: 'x' }),
  ]);
  // Present but unreadable meta (a sealed blob this device cannot open, or a
  // corrupt row) must count as protected.
  sqlite.prepare(`UPDATE messages SET meta = 'not-json{' WHERE id = 4`).run();
  await cache.cacheMessages('B', [msg('B', 5, 'secret in a locked chat')]);
  await cache.cacheMessages('C', [msg('C', 6, 'older plain'), msg('C', 7, 'newest is view once', { viewOnce: true })]);
  await cache.cacheMessages('D', [msg('D', 8, 'newest is plain', { viewOnce: false, invisibleInk: false })]);

  for (const [q, path] of [['secret', 'FTS'], ['ecre', 'page scan']] as const) {
    const all = (await cache.searchAllMessages(q, 40)).map(h => h.id).sort();
    assert.deepEqual(all, [1, 5], `${path}: only unprotected hits (got ${all})`);
    const unlocked = (await cache.searchAllMessages(q, 40, new Set(['B']))).map(h => h.id);
    assert.deepEqual(unlocked, [1], `${path}: a locked chat is not searched (got ${unlocked})`);
  }
  // In-chat search keeps its rule (shared helper).
  assert.deepEqual((await cache.searchCachedMessagesInChat('A', 'secret')).map(h => h.id), [1]);

  const prev = await cache.getLastMessagePerChat();
  assert.equal(prev.get('A')?.id, 4);
  assert.equal(prev.get('A')?.content, null, 'unreadable meta: preview text withheld');
  assert.equal(prev.get('A')?.protected, true);
  assert.equal(prev.get('C')?.content, null, 'view-once newest message: preview text withheld');
  assert.equal(prev.get('C')?.protected, true);
  assert.equal(prev.get('B')?.content, 'secret in a locked chat', 'the data layer leaves locks to the screen');
  assert.equal(prev.get('B')?.protected, undefined);
  assert.equal(prev.get('D')?.content, 'newest is plain', 'false flags are not protected');
  console.log('localDb protected search/preview: view-once, Ink, unreadable meta and locked-chat checks passed (FTS + page scan)');
}
main().finally(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
