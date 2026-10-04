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
import { exportBody, exportHtmlLine, exportTextHead, exportTextLine, escHtml } from './chatExportFormat';

const isCipher = (s: string) => s.startsWith('GSK1:') || s.startsWith('{"v":"dr1"');
const msg = (id: number, content: string | null, extra: { type?: string; deletedAt?: string | null } = {}) =>
  ({ id, type: 'text', content, deletedAt: null as string | null, ...extra });

async function main() {
  // ── merge rule (the real lib/messageHistory.ts, storage stubbed) ──
  const compiled = ts.transpileModule(readFileSync('lib/messageHistory.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let local: any[] = [];
  const exp: { unionWithLocalHistory?: (c: string, rows: any[], lim?: number, isC?: (s: string) => boolean) => Promise<any[]> } = {};
  runInNewContext(compiled, { exports: exp, require: () => ({ getCachedMessages: async () => local }), Map });
  const union = (server: any[], withCipher: boolean) => exp.unionWithLocalHistory!('c', server, 1000, withCipher ? isCipher : undefined);

  local = [msg(1, 'hello')];
  assert.equal((await union([msg(1, 'GSK1:x')], true))[0].content, 'hello', 'sealed server body loses to local plaintext');
  assert.equal((await union([msg(1, 'GSK1:x')], false))[0].content, 'GSK1:x', 'without isCipher the old rule is unchanged');
  assert.equal((await union([msg(1, null)], false))[0].content, 'hello', 'reclaimed body keeps the local copy');
  assert.equal((await union([msg(1, 'edited')], true))[0].content, 'edited', 'readable server body still wins');
  assert.equal((await union([msg(1, null, { deletedAt: 'x' })], true))[0].deletedAt, 'x', 'server deletion wins');
  local = [];
  assert.equal((await union([msg(2, 'GSK1:y')], true))[0].content, 'GSK1:y', 'no local copy → server row (decrypted later)');

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
  assert.ok(/unionWithLocalHistoryAsc\([^)]*looksEncrypted\)/.test(SCREEN), 'export merge passes the ciphertext test');
  const FILE = readFileSync('components/chattools/chatExportFile.ts', 'utf8');
  assert.ok(/deleteAsync\(/.test(FILE), 'export file is deleted after sharing');
  assert.ok(/appendFile\(/.test(FILE) && /cancelled\(\)/.test(FILE), 'export file is written in chunks and stops on cancel');
  assert.ok(/cancelRef\.current = true/.test(SCREEN), 'export screen has a Cancel and cancels on unmount');

  // ── per-message file lines (the file is written in chunks of these) ──
  const ctx = { label: (m: any) => (m.mine ? 'You' : 'Ann'), mine: (m: any) => !!m.mine, time: () => 'T', body: (m: any) => exportBody(m, isCipher) };
  assert.equal(exportTextLine({ ...msg(1, 'hi'), createdAt: 'x' }, ctx), '[T] Ann: hi\n');
  assert.equal(exportTextLine({ ...msg(1, 'hi'), createdAt: 'x', editedAt: 'y' }, ctx), '[T] Ann: hi\n  (edited)\n');
  assert.ok(exportTextHead('Ann', 3, 'now').includes('Messages: 3'));
  assert.equal(escHtml('<a&b>'), '&lt;a&amp;b&gt;');
  const h = exportHtmlLine({ ...msg(1, '<b>x\ny'), createdAt: 'x', mine: true } as any, ctx);
  assert.ok(h.startsWith('<div class="msg mine">') && !h.includes('class="sender"'), 'own message: no sender line');
  assert.ok(h.includes('&lt;b&gt;x<br>y'), 'body escaped, newlines kept');
  assert.ok(exportHtmlLine({ ...msg(1, 'GSK1:z'), createdAt: 'x' }, ctx).includes('[Encrypted message'), 'no ciphertext in HTML either');

  console.log('chatExportFormat selftest: ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
