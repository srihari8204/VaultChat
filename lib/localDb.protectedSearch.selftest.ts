// Run: npx tsx lib/localDb.protectedSearch.selftest.ts
//
// Global search and the Chats row preview read message text OUTSIDE the
// bubble, so they must apply the same rule as in-chat search: view-once and
// Invisible Ink text never leaves its bubble, and meta that is present but
// unreadable counts as protected (fail closed). Global search also skips the
// chats it is told are locked, and every chat the main list does not show:
// hidden (PIN-gated) chats, unreadable chat rows and chats with no cached row.
// The Bookshelf's attachment index follows the same allow-list.
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

  // Hidden chat H: cacheChats never gets it, but opening it from Hidden chats
  // writes its detail row (cacheChatDetail) with hidden: true.
  await cache.cacheChatDetail('H', { id: 'H', hidden: true, members: [] });
  await cache.cacheMessages('H', [
    msg('H', 9, 'secret in a hidden chat'),
    msg('H', 10, 'hidden file', { attachmentId: 'att-hidden', filename: 'h.pdf' }, 'file'),
  ]);
  // Z: messages on disk, no chat row at all (unknown → not listed).
  await cache.cacheMessages('Z', [msg('Z', 11, 'secret in an unknown chat')]);
  // X: a chat row this device cannot read.
  await cache.cacheMessages('X', [msg('X', 12, 'secret behind an unreadable row')]);
  sqlite.prepare(`INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES ('X', 'not-json{', NULL)`).run();
  await cache.cacheChatDetail('E', { id: 'E', hidden: false, members: [] });
  await cache.cacheMessages('E', [msg('E', 13, 'visible file', { attachmentId: 'att-visible', filename: 'v.pdf' }, 'file')]);

  assert.deepEqual([...(await cache.visibleCachedChatIds())].sort(), ['A', 'B', 'C', 'D', 'E'],
    'hidden, unreadable and missing rows are not visible');
  assert.deepEqual((await cache.getCachedVisibleChats()).map(c => c.id).sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.equal((await cache.getCachedChats()).some(c => c.id === 'H'), true, 'the full reader still sees H (sign-out purge)');
  assert.deepEqual((await cache.listAllAttachments()).map(a => a.attachmentId), ['att-visible'],
    'the Bookshelf index skips a hidden chat\'s files');

  for (const [q, path] of [['secret', 'FTS'], ['ecre', 'page scan']] as const) {
    const all = (await cache.searchAllMessages(q, 40)).map(h => h.id).sort();
    assert.deepEqual(all, [1, 5], `${path}: only unprotected hits (got ${all})`);
    const unlocked = (await cache.searchAllMessages(q, 40, new Set(['B']))).map(h => h.id);
    assert.deepEqual(unlocked, [1], `${path}: a locked chat is not searched (got ${unlocked})`);
  }
  // Hiding on this device takes effect at once; unhiding brings it back.
  await cache.setCachedChatHidden('A', true);
  assert.deepEqual((await cache.searchAllMessages('secret', 40)).map(h => h.id), [5], 'a chat hidden here is not searched');
  await cache.setCachedChatHidden('A', false);
  assert.deepEqual((await cache.searchAllMessages('secret', 40)).map(h => h.id).sort(), [1, 5], 'unhidden: searched again');
  await cache.setCachedChatHidden('X', true);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM chats WHERE id = 'X'`).get()?.n, 0, 'hiding an unreadable row drops it');
  // Fail closed: an unreadable chats table rejects instead of searching everything.
  sqlite.exec(`ALTER TABLE chats RENAME TO chats_gone`);
  await assert.rejects(cache.searchAllMessages('secret', 40), 'no chats table: search rejects');
  await assert.rejects(cache.listAllAttachments(), 'no chats table: Bookshelf index rejects');
  sqlite.exec(`ALTER TABLE chats_gone RENAME TO chats`);

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
  console.log('localDb protected search/preview: view-once, Ink, unreadable meta, locked- and hidden-chat checks passed (FTS + page scan)');
}
main().finally(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }).catch(e => { console.error(e); process.exitCode = 1; });
