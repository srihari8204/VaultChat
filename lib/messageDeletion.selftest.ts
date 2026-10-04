// Regression: a server delete must beat cached plaintext after close/reopen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const historySource = readFileSync(new URL('./messageHistory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(historySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function main() {
  const local = [{
    id: 39, senderId: 'leo', type: 'text', content: 'original',
    replyToId: null, meta: null, createdAt: '2026-09-15T00:00:00Z',
    editedAt: '2026-09-15T00:01:00Z', deletedAt: null,
  }];
  const exports: { unionWithLocalHistory?: (chatId: string, rows: any[]) => Promise<any[]> } = {};
  runInNewContext(compiled, {
    exports,
    require: () => ({ getCachedMessages: async () => local }),
    Map,
  });

  const deletedAt = '2026-09-15T00:02:00Z';
  const [deleted] = await exports.unionWithLocalHistory!('chat', [{
    ...local[0], type: 'system', content: null, meta: null, editedAt: local[0].editedAt, deletedAt,
  }]);
  assert.equal(deleted.deletedAt, deletedAt, 'server tombstone must replace stale edited plaintext');
  assert.equal(deleted.content, null);

  const [reclaimed] = await exports.unionWithLocalHistory!('chat', [{
    ...local[0], content: null, deletedAt: null,
  }]);
  assert.equal(reclaimed.content, 'original', 'ordinary body reclamation must keep the device copy');

  const localDb = readFileSync(new URL('./localDb.ts', import.meta.url), 'utf8');
  assert.match(localDb, /export async function cacheRemoteDeletion/);
  assert.match(localDb, /SET type = 'system', content = NULL, reply_to_id = NULL/);
  assert.match(localDb, /excluded\.deleted_at IS NOT NULL THEN NULL/);

  // The chat screen's socket effect lives in these files; if it moves out of
  // app/chat.tsx, add the new file here (see outboxRecovery.selftest.ts).
  const CHAT_FILES = ['app/chat.tsx'];
  const chat = CHAT_FILES.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.match(chat, /persistMessageDeletion\(chatId, eid, e\.deletedAt\)/,
    'live delete event must persist before a reopen');

  console.log('PASS: remote delete survives reopen, wipes plaintext, and preserves retention fallback');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
