// lib/chatExportFormat.selftest.ts — run: npx tsx lib/chatExportFormat.selftest.ts
//
// A chat export must never contain ciphertext. Two halves: the server ∪ local
// merge prefers our readable copy over a still-sealed server body
// (lib/messageHistory.ts, exercised in a VM like messageDeletion.selftest), and
// exportBody refuses to print an envelope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { exportBody, exportHtmlLine, exportHtmlTail, exportTextHead, exportTextLine, exportTextTail, escHtml } from './chatExportFormat';

const isCipher = (s: string) => s.startsWith('GSK1:') || s.startsWith('{"v":"dr1"');
const msg = (id: number, content: string | null, extra: { type?: string; deletedAt?: string | null } = {}) =>
  ({ id, type: 'text', content, deletedAt: null as string | null, ...extra });

async function main() {
  // ── merge rule (the real lib/messageHistory.ts, storage stubbed) ──
  const compiled = ts.transpileModule(readFileSync('lib/messageHistory.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let local: any[] = [];
  const exp: {
    unionWithLocalHistory?: (c: string, rows: any[], lim?: number, isC?: (s: string) => boolean) => Promise<any[]>;
    streamUnionWithLocalHistoryAsc?: (c: string, after: (a: number) => Promise<any[]>, o?: { page?: number; isCipher?: (s: string) => boolean }) => AsyncIterable<any[]>;
  } = {};
  const localAfter = async (_c: string, after: number, limit: number) =>
    local.filter(m => m.id > after).sort((a, b) => a.id - b.id).slice(0, limit);
  runInNewContext(compiled, { exports: exp, require: () => ({ getCachedMessages: async () => local, getCachedMessagesAfter: localAfter }), Map });
  const union = (server: any[], withCipher: boolean) => exp.unionWithLocalHistory!('c', server, 1000, withCipher ? isCipher : undefined);

  local = [msg(1, 'hello')];
  assert.equal((await union([msg(1, 'GSK1:x')], true))[0].content, 'hello', 'sealed server body loses to local plaintext');
  assert.equal((await union([msg(1, 'GSK1:x')], false))[0].content, 'GSK1:x', 'without isCipher the old rule is unchanged');
  assert.equal((await union([msg(1, null)], false))[0].content, 'hello', 'reclaimed body keeps the local copy');
  assert.equal((await union([msg(1, 'edited')], true))[0].content, 'edited', 'readable server body still wins');
  assert.equal((await union([msg(1, null, { deletedAt: 'x' })], true))[0].deletedAt, 'x', 'server deletion wins');
  local = [];
  assert.equal((await union([msg(2, 'GSK1:y')], true))[0].content, 'GSK1:y', 'no local copy → server row (decrypted later)');

  // ── the streamed union (the export's path): same rule, oldest-first, paged ──
  // A server that answers ?after= ascending, capped at `cap` rows per page —
  // smaller than the stream's page, so a short page must not end the walk.
  const serverAfter = (rows: any[], cap = 2) => async (after: number) =>
    rows.filter(m => m.id > after).sort((a, b) => a.id - b.id).slice(0, cap);
  const drain = async (it: AsyncIterable<any[]>) => { const chunks: any[][] = []; for await (const c of it) chunks.push(c); return chunks; };
  local = [msg(2, 'mine-2'), msg(3, 'hello'), msg(4, 'local only'), msg(7, 'newest, local only')];
  const server = [msg(1, 'one'), msg(2, null), msg(3, 'GSK1:x'), msg(5, 'five'), msg(6, 'x', { deletedAt: 'd' })];
  const chunks = await drain(exp.streamUnionWithLocalHistoryAsc!('c', serverAfter(server), { page: 3, isCipher }));
  const flat = chunks.flat();
  assert.deepEqual(flat.map(m => m.id), [1, 2, 3, 4, 5, 6, 7], 'stream: every id once, oldest first, across short server pages');
  assert.ok(chunks.every(c => c.length <= 3) && chunks.length === 3, 'stream: yields chunks of the page size, never the whole history');
  assert.equal(flat[1].content, 'mine-2', 'stream: reclaimed server body keeps the local copy');
  assert.equal(flat[2].content, 'hello', 'stream: sealed server body loses to local plaintext');
  assert.equal(flat[5].deletedAt, 'd', 'stream: server deletion wins');
  // Same answer as the whole-list union it replaces.
  const whole = await exp.unionWithLocalHistory!('c', server, 1000, isCipher);
  assert.deepEqual(flat.map(m => [m.id, m.content]), [...whole].reverse().map(m => [m.id, m.content]), 'stream equals the union, ascending');
  // A server that ignores ?after= (newest page, descending) must stop the export, not mis-order it.
  await assert.rejects(drain(exp.streamUnionWithLocalHistoryAsc!('c', async () => [msg(9, 'a'), msg(8, 'b')], { page: 3 })), /out of order/);
  await assert.rejects(drain(exp.streamUnionWithLocalHistoryAsc!('c', async (a) => [msg(Math.max(a, 1), 'same')], { page: 3 })), /out of order/,
    'a page that does not move past the cursor throws instead of looping');
  local = [];
  assert.deepEqual((await drain(exp.streamUnionWithLocalHistoryAsc!('c', async () => [], { page: 3 }))).length, 0, 'empty history: no chunks');
  // A cache page that fails mid-walk fails the export; it is not "the end of local history".
  local = [msg(1, 'a'), msg(2, 'b'), msg(3, 'c'), msg(4, 'd')];
  let localReads = 0;
  const flaky: any = {};
  runInNewContext(compiled, { exports: flaky, require: () => ({
    getCachedMessages: async () => local,
    getCachedMessagesAfter: async (c: string, after: number, limit: number) => {
      if (++localReads === 2) throw new Error('database is locked');
      return localAfter(c, after, limit);
    },
  }), Map });
  await assert.rejects(drain(flaky.streamUnionWithLocalHistoryAsc('c', async () => [], { page: 2 })), /database is locked/,
    'a local read error mid-walk rejects the stream instead of silently dropping the rest');
  local = [];

  // ── body text ──
  assert.equal(exportBody(msg(1, 'hi'), isCipher), 'hi');
  assert.equal(exportBody(msg(1, 'GSK1:abc'), isCipher), '[Encrypted message — not readable on this device]');
  assert.equal(exportBody(msg(1, '{"v":"dr1"}', { type: 'image' }), isCipher), '[Encrypted message — not readable on this device]');
  assert.equal(exportBody(msg(1, 'cap', { type: 'image' }), isCipher), '[Image] cap');
  assert.equal(exportBody(msg(1, null, { type: 'audio' }), isCipher), '[Voice message]');
  assert.equal(exportBody(msg(1, 'x', { deletedAt: 'y' }), isCipher), '[deleted]');
  assert.equal(exportBody({ ...msg(1, 'secret'), meta: { viewOnce: true } }, isCipher), '[Protected message]');
  assert.equal(exportBody({ ...msg(1, 'ink'), meta: { invisibleInk: true } }, isCipher), '[Protected message]');

  // ── wiring: the export decrypts and cleans up ──
  const SCREEN = readFileSync('app/chat-export.tsx', 'utf8');
  assert.ok(SCREEN.includes('hydrateMessages('), 'export decrypts through hydrateMessages like chat.tsx');
  assert.ok(/streamUnionWithLocalHistoryAsc\(chatId, serverPageAfter\(chatId\), \{ page: CHUNK, isCipher: looksEncrypted \}\)/.test(SCREEN), 'export merge passes the ciphertext test');
  assert.ok(/messages\?after=\$\{after\}/.test(SCREEN) && !/getMessages\(/.test(SCREEN), 'export walks the server forward, not the whole list newest-first');
  const FILE = readFileSync('components/chattools/chatExportFile.ts', 'utf8');
  assert.ok(/deleteAsync\(/.test(FILE), 'export file is deleted after sharing');
  assert.ok(/appendFile\(/.test(FILE) && /cancelled\(\)/.test(FILE), 'export file is written in chunks and stops on cancel');
  assert.ok(/cancelRef\.current = true/.test(SCREEN), 'export screen has a Cancel and cancels on unmount');

  // ── per-message file lines (the file is written in chunks of these) ──
  const ctx = { label: (m: any) => (m.mine ? 'You' : 'Ann'), mine: (m: any) => !!m.mine, time: () => 'T', body: (m: any) => exportBody(m, isCipher) };
  assert.equal(exportTextLine({ ...msg(1, 'hi'), createdAt: 'x' }, ctx), '[T] Ann: hi\n');
  assert.equal(exportTextLine({ ...msg(1, 'hi'), createdAt: 'x', editedAt: 'y' }, ctx), '[T] Ann: hi\n  (edited)\n');
  assert.ok(!exportTextHead('Ann', 'now').includes('Messages:') && exportTextTail(3).includes('Messages: 3'), 'count is in the tail (streamed)');
  assert.ok(exportHtmlTail(3).includes('3 messages') && exportHtmlTail(3).endsWith('</body></html>'));
  assert.equal(escHtml('<a&b>'), '&lt;a&amp;b&gt;');
  const h = exportHtmlLine({ ...msg(1, '<b>x\ny'), createdAt: 'x', mine: true } as any, ctx);
  assert.ok(h.startsWith('<div class="msg mine">') && !h.includes('class="sender"'), 'own message: no sender line');
  assert.ok(h.includes('&lt;b&gt;x<br>y'), 'body escaped, newlines kept');
  assert.ok(exportHtmlLine({ ...msg(1, 'GSK1:z'), createdAt: 'x' }, ctx).includes('[Encrypted message'), 'no ciphertext in HTML either');

  console.log('chatExportFormat selftest: ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
