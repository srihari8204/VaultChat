// srcBinding.selftest.ts — a resumed send must not re-seal a CHANGED source.
//
// THE BUG THIS PINS
// -----------------
// The relay sender seals chunk N as AES-GCM(K_t, nonce=f(transferId, chunkId)).
// Both K_t and chunkId are persisted across a crash, so a resume re-seals the
// same chunkId under the same key — which is exactly right, and exactly why
// resume is cheap. It is sound on ONE condition: the plaintext under a given
// chunkId never changes.
//
// A block whose PUT reached R2 but whose relayMarkUploaded never landed is
// re-uploaded on the next launch. The old resume path checked `fi.exists` and
// nothing else, so if the bytes behind srcPath had changed in the meantime —
// the DocumentPicker cache is app-managed and evictable, and a user can re-pick
// an edited file to the same path — R2 then held two ciphertexts under one
// (key, nonce). XOR of those recovers the keystream, and with it the GHASH
// authentication key: forgery, not merely disclosure.
//
// SIZE ALONE IS NOT ENOUGH. An in-place edit that preserves the byte count is
// the normal case, not the exotic one, which is why mtime is checked too. The
// same-size-different-mtime case below is the one that matters.
//
//   npx tsx lib/vaultBeam/srcBinding.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { sourceMatches } from './persistence';

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam source binding — no re-seal over changed plaintext\n');

// ── BEHAVIOUR: the predicate the resume path gates on ───────────────
const REC = { srcSize: 10 * 1024 * 1024, srcMtime: 1_700_000_000 };

A(sourceMatches(REC, { size: REC.srcSize, mtime: REC.srcMtime }),
  '1. an UNCHANGED source still resumes — resume must not regress');

// THE HEADLINE CASE. Same byte count, different mtime: an in-place edit.
A(!sourceMatches(REC, { size: REC.srcSize, mtime: REC.srcMtime + 1 }),
  '2. SAME SIZE, different mtime is REFUSED — size alone would have re-sealed it');
A(!sourceMatches(REC, { size: REC.srcSize, mtime: REC.srcMtime - 1 }),
  '3. an mtime that moved BACKWARDS is refused too (a restored/copied file)');

A(!sourceMatches(REC, { size: REC.srcSize + 1, mtime: REC.srcMtime }),
  '4. a different size is refused even when mtime is preserved');

// FAIL-CLOSED. An unreadable stat is precisely the case where we cannot prove
// the bytes are the same, so it must not be read as "fine".
A(!sourceMatches(REC, {}),
  '5. an unreadable source is refused, not waved through');
A(!sourceMatches(REC, { size: REC.srcSize, mtime: undefined }),
  '6. a missing mtime on a bound record is refused');
A(!sourceMatches(REC, { size: String(REC.srcSize), mtime: REC.srcMtime }),
  '7. a non-numeric size never compares equal');

// One upgrade exception: records written before the binding existed carry
// NEITHER field. Mass-failing every in-flight send on one app update would be a
// worse outcome than the window it closes, and those records are also the only
// ones the old `fi.exists` check ever guarded.
A(sourceMatches({}, { size: 1, mtime: 2 }),
  '8. a pre-binding record (neither field) keeps the old behaviour');
A(!sourceMatches({ srcSize: 5 }, { size: 6, mtime: 2 }),
  '9. a half-bound record still enforces the field it does have');

// ── WIRING: the live resume path must actually use it ───────────────
const ROOT = join(__dirname, '..', '..');
const CTRL = readFileSync(join(ROOT, 'lib', 'vaultBeamController.ts'), 'utf8');
const resume = (() => {
  const i = CTRL.indexOf('export async function resumePendingSends');
  const j = CTRL.indexOf('\nlet _listenersArmed', i);
  return i < 0 ? '' : CTRL.slice(i, j > i ? j : CTRL.length);
})();

A(resume !== '', '10. resumePendingSends still exists');
A(/sourceMatches\(r, cur\)/.test(resume),
  '11. the resume path gates on sourceMatches, not on existence alone');
A(!/if \(!fi\?\.exists\) \{ await unpersistSend\(r\.transferId\); continue; \}\s*setState/.test(resume),
  '12. the bare exists-only gate is gone');
A(/sendTransfer\(/.test(resume) && resume.indexOf('sourceMatches') < resume.indexOf('sendTransfer('),
  '13. the check runs BEFORE any byte is re-sealed');
A(/relayAbort\(r\.transferId\)/.test(resume),
  '14. a refused resume purges the relay copy, so the old ciphertext is not left paired with a future one');

// And the binding has to be RECORDED, or the check can never fire.
A(/srcSize: srcStat\.size, srcMtime: srcStat\.mtime/.test(CTRL),
  '15. startSend records size+mtime with the persisted send');
A(/srcSize\?: number; srcMtime\?: number/.test(CTRL),
  '16. PersistedSend carries the two fields');

// ── #2: the client must actually SEND sessionVersion ────────────────
// The server has four vbStaleVersion gates; they are dead weight while the
// client omits the field, because an absent version is deliberately not a
// mismatch (pre-vbm3 clients).
const RELAY = readFileSync(join(ROOT, 'lib', 'vaultbeamRelay.ts'), 'utf8');
for (const fn of ['relayGrow', 'relayMarkUploaded']) {
  const i = RELAY.indexOf('export const ' + fn);
  const body = i < 0 ? '' : RELAY.slice(i, RELAY.indexOf('\n\n', i) + 1 || undefined);
  A(/sessionVersion: versions\.get\(transferId\)/.test(body),
    `17. ${fn} now rides the session version`);
}
A(/relayInit[\s\S]{0,400}?noteVersion\(transferId, r\)/.test(RELAY),
  '18. relayInit caches the version the server assigned');
A(/relayState[\s\S]{0,200}?noteVersion\(transferId, r\)/.test(RELAY),
  '19. relayState refreshes it — the resume path reads state before it mutates');

console.log(failures === 0 ? '\nsrcBinding: OK\n' : `\nsrcBinding: ${failures} FAILED\n`);
if (failures) process.exit(1);
