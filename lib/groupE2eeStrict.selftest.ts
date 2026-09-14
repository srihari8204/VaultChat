// lib/groupE2eeStrict.selftest.ts — run: npx tsx lib/groupE2eeStrict.selftest.ts
//
// The group send path must FAIL CLOSED, and must fail closed in the one specific
// way the outbox understands.
//
// Two failures are possible here and they look identical from a distance:
//
//   * returning the plaintext, which ships the message in the clear while the
//     bubble shows a normal tick — a silent downgrade an attacker can induce by
//     provoking any transient sender-key error;
//   * throwing a message the outbox does not recognise as a KEYS problem, which
//     turns a recoverable "waiting for the group's keys" state into a red
//     "not sent" for a fault that would have healed on the next retry.
//
// So this asserts both halves: nothing plaintext comes back, AND the thrown text
// is matched by messageQueue's isKeysError regex (read out of the shipping
// source, not restated here — a copy would drift and pass while the real one
// stopped matching).
//
// chatService.ts cannot be imported under Node (react-native, expo-*), so the
// GROUP BRANCH IS LIFTED OUT OF THE SOURCE VERBATIM and run against stubs —
// same trick as messageQueue.flush.selftest.ts / localDb.queue.selftest.ts. The
// extraction fails loudly if the branch changes shape, so it cannot go stale.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── the real isKeysError predicate, lifted from messageQueue.ts ────────────
const MQ = readFileSync(join(HERE, 'messageQueue.ts'), 'utf8');
const keysRe = MQ.match(/function isKeysError[\s\S]*?return !!msg && (\/[\s\S]*?\/i)\.test/);
check('isKeysError is still a single regex in messageQueue.ts', !!keysRe,
  'the outbox changed shape — this test can no longer prove the WAITING_KEYS tag');
// eslint-disable-next-line no-eval -- a regex literal from our own source
const isKeysError = (m: string) => (keysRe ? (eval(keysRe[1]) as RegExp).test(m) : false);

// ── the real group branch, lifted from chatService.ts ──────────────────────
const CS = readFileSync(join(HERE, 'chatService.ts'), 'utf8');
const branch = CS.match(
  /(  if \(_chatPeer\.get\(chatId\)\?\.type === 'group'\) \{[\s\S]*?\r?\n  \})\r?\n  \/\/ Resolve the peer robustly/);
check('the group branch is still where encryptForChat keeps it', !!branch,
  'encryptForChat was restructured — re-point the extraction below');

const WORK = join(tmpdir(), `vc-group-strict-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');
// The REAL flags, so E2EE_STRICT / GROUP_E2EE are whatever ships (no imports in
// that file, so it copies as-is).
writeFileSync(join(WORK, 'flags.ts'), readFileSync(join(ROOT, 'constants', 'flags.ts'), 'utf8'));
// Stub sender-key session, steered per case.
writeFileSync(join(WORK, 'groupSession.js'), `
export function isGroupEnvelope(w) { return typeof w === 'string' && w.startsWith('GSK1:'); }
export async function groupEncryptMessage(_chatId, plaintext) {
  const mode = globalThis.__mode;
  if (mode === 'throw') throw new Error('group: no sender key distributed yet');
  if (mode === 'plaintext') return plaintext;          // the old !me early-return
  return 'GSK1:' + JSON.stringify({ ct: plaintext.length });
}
`);
writeFileSync(join(WORK, 'branch.ts'), `
import { GROUP_E2EE, E2EE_STRICT } from './flags.ts';
const _chatPeer = new Map([['g1', { type: 'group', peerId: null }]]);
export async function encryptForChat(chatId: string, plaintext: string): Promise<string> {
${(branch?.[1] ?? '').replace("'../services/crypto/groupSession.rn'", "'./groupSession.js'")}
  throw new Error('selftest: not a group chat');
}
`);

async function main() {
  const { encryptForChat } = await import(pathToFileURL(join(WORK, 'branch.ts')).href);
  const PT = 'meet me at 8';

  async function attempt(mode: string): Promise<{ out?: string; err?: string }> {
    (globalThis as any).__mode = mode;
    try { return { out: await encryptForChat('g1', PT) }; }
    catch (e: any) { return { err: String(e?.message ?? e) }; }
  }

  console.log('a sender-key failure must not ship plaintext');
  const thrown = await attempt('throw');
  check('encryptForChat throws instead of returning', thrown.out === undefined,
    `returned ${JSON.stringify(thrown.out)}`);
  check('and what it returned is not the plaintext', thrown.out !== PT, 'SILENT PLAINTEXT DOWNGRADE');
  check('the thrown message is classified as a keys error (→ WAITING_KEYS, clock kept)',
    isKeysError(thrown.err ?? ''),
    `isPermanent() is false for it too (no .status), but without a keys match the row is tagged QUEUED, not WAITING_KEYS: ${thrown.err}`);

  console.log('a non-throwing plaintext hand-back must not ship either');
  const passthrough = await attempt('plaintext');
  check('the envelope guard rejects a plaintext return value', passthrough.out === undefined,
    `returned ${JSON.stringify(passthrough.out)} — this is the !me early-return shape`);
  check('and that failure is a keys error as well', isKeysError(passthrough.err ?? ''), passthrough.err);

  console.log('the happy path still works');
  const ok = await attempt('ok');
  check('a real sender-key envelope passes through', ok.out?.startsWith('GSK1:') === true, ok.err ?? ok.out);

  // The source-level companion: nothing in the group session may hand a caller
  // back the plaintext it was asked to encrypt.
  const GS = readFileSync(join(ROOT, 'services', 'crypto', 'groupSession.rn.ts'), 'utf8');
  const fn = GS.match(/export async function groupEncryptMessage[\s\S]*?\n\}/)?.[0] ?? '';
  check('groupEncryptMessage has no `return plaintext` left in it',
    !!fn && !/return plaintext/.test(fn), 'a send-direction plaintext fallback is back');
}

main().then(() => {
  rmSync(WORK, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.message ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});

export default {};
