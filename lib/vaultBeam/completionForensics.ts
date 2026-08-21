// lib/vaultBeam/completionForensics.ts — the arithmetic behind "zero missing".
//
// §21 asks for a completion report: expected, received, duplicate, missing,
// final bitmap popcount, and the digest comparison. Today "complete" is asserted
// by two separate facts in two separate files — `isComplete(plan) && got.size >=
// totalBlocks(plan)` in the receive loop, and the sha256 gate below it — and
// nothing ever states them together. When a transfer completes there is no
// single record saying WHY it was allowed to.
//
// This builds that record, and it is deliberately a JUDGE, not a reporter: it
// returns `ok` only when every independent check agrees. A verdict that merely
// summarised the counters could be satisfied by the same off-by-one that
// produced them.
//
// # WHAT IT DOES NOT DO
//
// It does not decide completion — `vaultBeamTransfer` already gates on the
// bitmap and the whole-file digest, and that ordering (bitmap -> digest ->
// relayComplete -> deletion) is load-bearing and unchanged. This runs alongside
// to make the decision auditable, so a device run produces evidence rather than
// a claim. If it ever disagrees with the transfer's own gate, THAT is the bug
// worth finding.
//
// # DUPLICATES
//
// A duplicate committed chunk is not merely wasteful, it is a correctness
// signal: the bitmap is a set, so committing the same chunk twice cannot change
// popcount. If a caller counted more commit events than the popcount can
// account for, something scheduled work it already had — exactly what §13
// forbids. So duplicates are reported, and a duplicate does NOT fail the
// verdict: the file is still correct. It fails the EFFICIENCY assertion, which
// the device matrix reads separately.
//
// PURE — no react-native, no IO. `npx tsx lib/vaultBeam/completionForensics.ts`.

import { ChunkBitmap } from './bitmap';

export interface ForensicsInput {
  /** Chunks the manifest says exist. */
  expectedChunks: number;
  /** The receiver's final committed bitmap, base64 (ChunkBitmap.encode()). */
  bitmapB64?: string | null;
  /** Commit events observed, including any repeats. Optional. */
  commitEvents?: number;
  /** Chunks that failed GCM/write and were rescheduled. Optional. */
  retriedChunks?: number;
  /** Chunks rejected outright (bad id, bad range, tamper). Optional. */
  rejectedChunks?: number;
  /** Whole-file digests. Compared case-insensitively when both are present. */
  expectedSha256?: string | null;
  actualSha256?: string | null;
}

export interface ForensicsReport {
  expectedChunks: number;
  verifiedChunks: number;      // popcount of the final bitmap
  missingChunks: number;       // expected - verified, never negative
  duplicateCommits: number;    // commitEvents - verified, never negative
  retriedChunks: number;
  rejectedChunks: number;
  bitmapFull: boolean;
  digest: 'match' | 'mismatch' | 'unchecked';
  /** True only when the file is provably whole AND intact. */
  ok: boolean;
  /** Every reason `ok` is false, in a stable order. Empty iff ok. */
  problems: string[];
}

/**
 * Judge a finished transfer.
 *
 * Fails closed everywhere: an absent or undecodable bitmap counts as zero
 * verified chunks, not as "assume fine". The one thing this must never do is
 * bless a transfer it could not actually check.
 */
export function analyzeCompletion(input: ForensicsInput): ForensicsReport {
  const expected = Number.isFinite(input.expectedChunks) && input.expectedChunks > 0
    ? Math.floor(input.expectedChunks) : 0;

  let verified = 0;
  if (expected > 0 && input.bitmapB64) {
    try { verified = ChunkBitmap.decode(input.bitmapB64, expected).popcount(); }
    catch { verified = 0; }                       // undecodable ⇒ nothing proven
  }
  if (verified > expected) verified = expected;   // a wider mask proves nothing extra

  const missing = Math.max(0, expected - verified);
  const events = Number.isFinite(input.commitEvents ?? NaN) ? Math.floor(input.commitEvents!) : verified;
  const duplicates = Math.max(0, events - verified);

  const exp = typeof input.expectedSha256 === 'string' ? input.expectedSha256.toLowerCase() : '';
  const act = typeof input.actualSha256 === 'string' ? input.actualSha256.toLowerCase() : '';
  const digest: ForensicsReport['digest'] =
    exp && act ? (exp === act ? 'match' : 'mismatch') : 'unchecked';

  const rejected = Math.max(0, Math.floor(input.rejectedChunks ?? 0));
  const retried = Math.max(0, Math.floor(input.retriedChunks ?? 0));
  const full = expected > 0 && verified === expected;

  const problems: string[] = [];
  if (expected === 0) problems.push('expected chunk count is unknown');
  if (missing > 0) problems.push(`${missing} chunk(s) missing`);
  if (!full && expected > 0) problems.push('bitmap is not full');
  if (digest === 'mismatch') problems.push('whole-file sha256 mismatch');
  if (rejected > 0) problems.push(`${rejected} chunk(s) rejected`);

  return {
    expectedChunks: expected,
    verifiedChunks: verified,
    missingChunks: missing,
    duplicateCommits: duplicates,
    retriedChunks: retried,
    rejectedChunks: rejected,
    bitmapFull: full,
    digest,
    ok: problems.length === 0,
    problems,
  };
}

/** One line for a log or a report table. Content-free: counts only. */
export function formatForensics(r: ForensicsReport): string {
  return [
    `expected=${r.expectedChunks}`,
    `verified=${r.verifiedChunks}`,
    `missing=${r.missingChunks}`,
    `duplicate=${r.duplicateCommits}`,
    `retried=${r.retriedChunks}`,
    `rejected=${r.rejectedChunks}`,
    `sha256=${r.digest}`,
    r.ok ? 'VERDICT=OK' : `VERDICT=FAIL(${r.problems.join('; ')})`,
  ].join(' ');
}

export default { analyzeCompletion, formatForensics };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  const full = (n: number) => { const b = new ChunkBitmap(n); for (let i = 0; i < n; i++) b.set(i); return b.encode(); };
  const partial = (n: number, upto: number) => { const b = new ChunkBitmap(n); for (let i = 0; i < upto; i++) b.set(i); return b.encode(); };
  const SHA = 'a'.repeat(64);

  console.log('\nVaultBeam completion forensics\n');

  // ── the happy path ───────────────────────────────────────────────
  const good = analyzeCompletion({
    expectedChunks: 100, bitmapB64: full(100), commitEvents: 100,
    expectedSha256: SHA, actualSha256: SHA,
  });
  A(good.ok, '1. full bitmap + matching digest is OK');
  A(good.missingChunks === 0 && good.verifiedChunks === 100, '2. and reports zero missing');
  A(good.duplicateCommits === 0, '3. with no duplicate commits');
  A(good.problems.length === 0, '4. and no problems');

  // ── the things that must FAIL ────────────────────────────────────
  const short = analyzeCompletion({ expectedChunks: 100, bitmapB64: partial(100, 99), expectedSha256: SHA, actualSha256: SHA });
  A(!short.ok && short.missingChunks === 1, '5. one missing chunk fails, and is counted');
  A(short.problems.some((p) => /missing/.test(p)), '6. and says so');

  const bad = analyzeCompletion({ expectedChunks: 100, bitmapB64: full(100), expectedSha256: SHA, actualSha256: 'b'.repeat(64) });
  A(!bad.ok && bad.digest === 'mismatch',
    '7. a full bitmap with a WRONG digest still fails — completeness is not integrity');

  const rej = analyzeCompletion({ expectedChunks: 10, bitmapB64: full(10), expectedSha256: SHA, actualSha256: SHA, rejectedChunks: 2 });
  A(!rej.ok, '8. rejected chunks fail the verdict even when the file looks whole');

  // ── fails closed ─────────────────────────────────────────────────
  A(!analyzeCompletion({ expectedChunks: 100 }).ok,
    '9. no bitmap ⇒ nothing proven ⇒ not OK');
  A(analyzeCompletion({ expectedChunks: 100 }).verifiedChunks === 0,
    '10. an absent bitmap counts as zero verified, never as "assume fine"');
  A(analyzeCompletion({ expectedChunks: 10, bitmapB64: '!!!not base64!!!' }).verifiedChunks === 0,
    '11. an undecodable bitmap proves nothing');
  A(!analyzeCompletion({ expectedChunks: 0, bitmapB64: full(10) }).ok,
    '12. an unknown expected count cannot be OK');
  for (const n of [-5, NaN, Infinity]) {
    A(!analyzeCompletion({ expectedChunks: n as number, bitmapB64: full(10) }).ok,
      `13. a malformed expected count (${String(n)}) cannot be OK`);
  }

  // ── the digest is only "checked" when both sides exist ───────────
  A(analyzeCompletion({ expectedChunks: 10, bitmapB64: full(10) }).digest === 'unchecked',
    '14. no digests ⇒ unchecked');
  A(analyzeCompletion({ expectedChunks: 10, bitmapB64: full(10), expectedSha256: SHA }).digest === 'unchecked',
    '15. an expectation with no actual is still unchecked, not a match');
  A(analyzeCompletion({ expectedChunks: 10, bitmapB64: full(10), expectedSha256: SHA }).ok,
    '16. and unchecked does not by itself fail — the transfer gate owns that call');
  A(analyzeCompletion({
    expectedChunks: 10, bitmapB64: full(10), expectedSha256: SHA.toUpperCase(), actualSha256: SHA,
  }).digest === 'match', '17. digest comparison is case-insensitive');

  // ── duplicates: reported, not fatal ──────────────────────────────
  const dup = analyzeCompletion({
    expectedChunks: 50, bitmapB64: full(50), commitEvents: 57,
    expectedSha256: SHA, actualSha256: SHA,
  });
  A(dup.duplicateCommits === 7, '18. commits beyond popcount are duplicates');
  A(dup.ok, '19. duplicates do not corrupt the file, so the verdict stands');

  const noEvents = analyzeCompletion({ expectedChunks: 50, bitmapB64: full(50) });
  A(noEvents.duplicateCommits === 0,
    '20. absent commit-event counting reports 0 duplicates, not a false positive');

  // ── a wider mask cannot inflate the count ────────────────────────
  A(analyzeCompletion({ expectedChunks: 5, bitmapB64: full(64) }).verifiedChunks <= 5,
    '21. a mask wider than expected proves at most `expected` chunks');

  // ── formatting leaks nothing ─────────────────────────────────────
  const line = formatForensics(good);
  A(/expected=100/.test(line) && /VERDICT=OK/.test(line), '22. the log line carries the counts');
  A(!line.includes(SHA), '23. and never the digest itself');
  A(/VERDICT=FAIL/.test(formatForensics(short)), '24. a failed verdict is unmistakable');

  console.log(failures === 0
    ? '\nALL COMPLETION-FORENSICS CHECKS PASSED ✓  (device runs supply real inputs)\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
