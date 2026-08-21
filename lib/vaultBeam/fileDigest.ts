// lib/vaultBeam/fileDigest.ts — the manifest's optional whole-file SHA-256.
//
// # WHAT WAS ACTUALLY MISSING
//
// The integrity GATE already existed and was already in the right order —
// lib/vaultBeamTransfer.ts hashes the assembled file and throws BEFORE
// relayComplete, so a corrupt file never causes the relay copy to be purged:
//
//     if (opts.expectedSha256) { ... if (!verified) throw ... }
//     await relayComplete(opts.transferId);
//
// What was missing is that nothing ever supplied `expectedSha256`: VBManifest
// carried no digest, so the branch was dead. This module is the small piece that
// makes it live — validating the value on both sides so a malformed or hostile
// digest can neither be stored nor enforced.
//
// # WHY OPTIONAL, PERMANENTLY
//
// A manifest is delivered over E2EE and is already in flight for transfers
// created by older builds. An absent digest MUST therefore keep working exactly
// as before — per-chunk AES-GCM plus bitmap completeness, which is what has been
// protecting these transfers all along. Absent means "no extra check", never
// "fail closed", or every in-flight legacy transfer would break.
//
// PURE — no fs, no native, no crypto. `npx tsx lib/vaultBeam/fileDigest.ts`.

/** A SHA-256 hex digest: exactly 64 hex characters, stored lowercase. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Accept a digest only if it is exactly 64 hex characters; normalise to
 * lowercase. Anything else — wrong length, non-hex, whitespace, a number, an
 * object — becomes `undefined`, i.e. "no digest", which falls back to the
 * pre-existing behaviour rather than failing a transfer.
 */
export function normalizeDigest(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return HEX64.test(s) ? s : undefined;
}

export type DigestVerdict = 'skip' | 'match' | 'mismatch';

/**
 * Compare a received file's digest against the manifest's.
 *
 * `skip`     — the manifest carried no (valid) digest. Legacy path, unchanged.
 * `match`    — verified; the transfer may complete and the relay copy may go.
 * `mismatch` — the file is not what the sender sent. The caller MUST NOT
 *              complete and MUST NOT purge the relay copy, because that copy is
 *              the only thing left to retry from.
 *
 * An unreadable/absent ACTUAL digest with an expected one present is a
 * `mismatch`, not a `skip`: failing to hash the file is not evidence that the
 * file is correct.
 */
export function digestVerdict(expected: unknown, actual: unknown): DigestVerdict {
  const want = normalizeDigest(expected);
  if (!want) return 'skip';
  const got = normalizeDigest(actual);
  if (!got) return 'mismatch';
  return got === want ? 'match' : 'mismatch';
}

/** True when the verdict permits completion + relay deletion. */
export const digestAllowsCompletion = (v: DigestVerdict): boolean => v !== 'mismatch';

export default { normalizeDigest, digestVerdict, digestAllowsCompletion };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  const GOOD = 'a'.repeat(64);
  const REAL = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  console.log('\nVaultBeam whole-file digest\n');

  A(normalizeDigest(REAL) === REAL, '1. a real 64-hex digest is accepted');
  A(normalizeDigest(REAL.toUpperCase()) === REAL, '2. an uppercase digest is normalised to lowercase');
  A(normalizeDigest('  ' + REAL + '  ') === REAL, '3. surrounding whitespace is trimmed');

  for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), REAL + 'a',
                     'not a digest', '0x' + 'a'.repeat(62), null, undefined, 12345,
                     {}, [], true, 'a'.repeat(32)]) {
    A(normalizeDigest(bad) === undefined, `4. rejects ${JSON.stringify(bad)?.slice(0, 24)}`);
  }

  // ── BACKWARD COMPATIBILITY: absent digest must not fail a transfer ──
  A(digestVerdict(undefined, REAL) === 'skip', '5. an old manifest with NO digest still completes');
  A(digestVerdict('', REAL) === 'skip', '6. an empty digest is treated as absent, not as a mismatch');
  A(digestVerdict('garbage', REAL) === 'skip',
    '7. a malformed digest degrades to the legacy path rather than failing everything');
  A(digestAllowsCompletion('skip'), '8. and skip permits completion');

  // ── ENFORCEMENT when a valid digest IS present ──
  A(digestVerdict(REAL, REAL) === 'match', '9. matching digests verify');
  A(digestVerdict(REAL, REAL.toUpperCase()) === 'match', '10. case does not matter on either side');
  A(digestVerdict(REAL, GOOD) === 'mismatch', '11. a different digest is a MISMATCH');
  A(!digestAllowsCompletion('mismatch'), '12. and a mismatch forbids completion + relay deletion');
  A(digestAllowsCompletion('match'), '13. a match permits both');

  // A single flipped byte must not slip through.
  const flipped = REAL.slice(0, 63) + (REAL[63] === '8' ? '9' : '8');
  A(digestVerdict(REAL, flipped) === 'mismatch', '14. one changed hex character is caught');

  // Failing to HASH is not evidence of correctness.
  A(digestVerdict(REAL, undefined) === 'mismatch',
    '15. expected present but actual unreadable ⇒ mismatch, never a silent pass');
  A(digestVerdict(REAL, '') === 'mismatch', '16. an empty actual digest is a mismatch too');

  console.log(failures === 0
    ? '\nALL FILE-DIGEST CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
