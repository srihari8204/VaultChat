// vbHaveWiring.selftest.ts — the receiver-progress nudge must be heard, and must
// not be able to cause a duplicate send.
//
// relay/received has always emitted `vb_have` to the sender the instant the
// receiver commits verified chunks — the server calls it a nudge "so it
// re-derives its work-list immediately rather than waiting for its next poll".
// Nothing listened, so the signal went nowhere and the sender's only view of the
// peer was its own upload progress, which after a broken direct transfer is not
// the same thing at all.
//
// The listener is deliberately PASSIVE. The dangerous version of this feature is
// the obvious one: hear the nudge, immediately re-derive the work-list, and race
// the in-flight derivation into staging the same block twice. So the checks
// below are mostly about what it must NOT do.
//
// STRUCTURAL: reads source, sends nothing.
//
//   npx tsx lib/vaultBeam/vbHaveWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'lib', 'vaultBeamController.ts'), 'utf8');
const code = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

/** The listener body, so assertions cannot be satisfied by unrelated code. */
const body = (() => {
  const i = code.indexOf("addPersistentListener('vb_have'");
  if (i < 0) return '';
  const j = code.indexOf("addPersistentListener('vb_abort'", i);
  return code.slice(i, j > i ? j : i + 1200);
})();

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam vb_have — receiver progress nudge\n');

A(body !== '', '1. a vb_have listener exists at all');
A(/addPersistentListener\('vb_have'/.test(code),
  '2. registered through the same persistent-listener path as vb_complete/vb_abort');
A(/peerVerified\?: number;/.test(code),
  '3. the sender state carries the peer\'s verified count');
A(/setState\(id, \{ peerVerified: got \}\)/.test(body),
  '4. and the nudge records it');

// ── WHAT IT MUST NOT DO ────────────────────────────────────────────
for (const forbidden of ['sendTransfer(', 'serveDirect(', 'relayBlockUrls(', 'push(', 'relayGrow(']) {
  A(!body.includes(forbidden),
    `5. the listener never calls ${forbidden} — hearing a nudge must not start sending`);
}
A(!/controllers\.get\(id\)\?\.abort\(\)/.test(body),
  '6. and never aborts the in-flight transfer');

// ── IDEMPOTENT / MONOTONIC ─────────────────────────────────────────
A(/if \(typeof s\.peerVerified === 'number' && got <= s\.peerVerified\) return;/.test(body),
  '7. a repeated or out-of-order nudge cannot walk the count backwards');
A(/if \(!Number\.isFinite\(got\) \|\| got < 0\) return;/.test(body),
  '8. a malformed count is ignored rather than stored');

// ── SCOPED ─────────────────────────────────────────────────────────
A(/s\.role !== 'sender'/.test(body),
  '9. only a SENDER acts on it — a receiver has its own bitmap');
A(/status === 'complete' \|\| s\.status === 'cancelled' \|\| s\.status === 'failed'/.test(body),
  '10. a terminal transfer ignores late nudges, so nothing resurrects');
A(/const id = d\?\.transferId; if \(!id\) return;/.test(body),
  '11. an event without a transfer id is dropped');

// ── the sender work-list it complements ────────────────────────────
const XFER = readFileSync(join(ROOT, 'lib', 'vaultBeamTransfer.ts'), 'utf8');
A(/blocksReceiverAlreadyHas\(\{/.test(XFER),
  '12. the sender work-list subtracts what the receiver already holds');
A(/expectedReceived: st\.received/.test(XFER),
  '13. and corroborates the mask against the server\'s own count');
A(/chunkBytes: st\.chunkBytes/.test(XFER),
  '14. using the transfer\'s own chunk size, not a module constant');

console.log(failures === 0
  ? '\nALL VB_HAVE WIRING CHECKS PASSED ✓  (device evidence separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
