// progressMonotonic.selftest.ts — the bar must not walk backwards.
//
// # THE DEFECT, MEASURED
//
// VaultBeam builds its segment plan REACTIVELY: relayGrow appends segments as
// throughput is sampled, so `block_count` climbs while the transfer runs. On a
// real 755 MB send, captured from the phone and the server together:
//
//     07:38:23   UI  59%    server blocks=32
//     07:39:09   UI  91%    server blocks=32
//     07:39:55   UI 100%    server blocks=96
//     07:47      —          server blocks=157
//
// The bar was `done / plannedBlocks`. Every time the plan grew the denominator
// grew, so it filled to ~100%, fell back, and climbed again — repeatedly. The
// user read that as "it is uploading again and again", which is exactly what it
// looks like, and the ETA derived from it was meaningless.
//
// Nothing was actually re-sent: uploaded_mask only ever grows. The bytes were
// always right; the DISPLAY denominator was wrong.
//
// # THE FIX
//
// `totalBytes` comes from the manifest and never changes, and the underlying
// byte counters are cumulative (`uploadedBytes += bytes`). So progress is
// measured against the FILE, and blocks are only a last-resort fallback for a
// transfer whose size is somehow unknown.
//
// These checks drive the SAME formula the bubble and the notification use, so
// they cannot pass while the shipped code disagrees.
//
//   npx tsx lib/vaultBeam/progressMonotonic.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { notificationText } from './backgroundService';

const ROOT = join(__dirname, '..', '..');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const BUBBLE = strip(readFileSync(join(ROOT, 'components', 'VaultBeamBubble.tsx'), 'utf8'));
const CTRL = strip(readFileSync(join(ROOT, 'lib', 'vaultBeamController.ts'), 'utf8'));

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

/** The shipped formula, mirrored so the arithmetic can be exercised directly. */
const percent = (bytes: number, totalBytes: number): number =>
  totalBytes > 0
    ? Math.min(100, Math.floor((Math.max(0, Math.min(bytes, totalBytes)) / totalBytes) * 100))
    : 0;

console.log('\nVaultBeam progress — immutable denominator\n');

// ── 1. THE MEASURED REGRESSION ─────────────────────────────────────
{
  const TOTAL = 792_106_404;                       // the real 755 MB transfer
  // Bytes climb monotonically while the PLAN grows underneath them.
  const timeline = [
    { bytes: 100_000_000, blocks: 32 },
    { bytes: 300_000_000, blocks: 32 },
    { bytes: 460_000_000, blocks: 96 },            // plan grew here
    { bytes: 600_000_000, blocks: 157 },           // and here
    { bytes: 792_106_404, blocks: 189 },
  ];
  let prev = -1;
  let everFell = false;
  for (const t of timeline) {
    const p = percent(t.bytes, TOTAL);
    if (p < prev) everFell = true;
    prev = p;
  }
  A(!everFell, '1. across the real 32→96→157 plan growth, percent never falls');
  A(percent(timeline[4].bytes, TOTAL) === 100, '2. and reaches exactly 100% at the last byte');

  // The old formula, for contrast — this is what shipped.
  const oldPct = (done: number, total: number) => Math.min(100, Math.round((done / total) * 100));
  const oldFell = oldPct(32, 32) > oldPct(40, 96);
  A(oldFell, '3. the OLD done/plannedBlocks formula demonstrably fell back (100% → 42%)');
}

// ── 2. MONOTONIC UNDER ARBITRARY PLAN CHANGES ──────────────────────
{
  const TOTAL = 1_000_000;
  let prev = 0, ok = true;
  for (let b = 0; b <= TOTAL; b += 37_000) {
    const p = percent(b, TOTAL);
    if (p < prev) ok = false;
    prev = p;
  }
  A(ok, '4. percent is monotonic for any monotonic byte counter');
}

// ── 3. BOUNDS: 0 <= transferred <= total ───────────────────────────
A(percent(0, 1000) === 0, '5. zero bytes is 0%');
A(percent(1000, 1000) === 100, '6. all bytes is 100%');
A(percent(1500, 1000) === 100, '7. an overshoot clamps to 100, never 150');
A(percent(-5, 1000) === 0, '8. a negative counter clamps to 0');
A(percent(500, 0) === 0, '9. an unknown total yields 0, not NaN or Infinity');

// ── 4. THE PARTIAL FINAL BLOCK ─────────────────────────────────────
{
  // 755 MB is not a whole number of 4 MiB blocks: the last one is partial.
  const TOTAL = 792_106_404;
  const BLOCK = 4 * 1024 * 1024;
  const wholeBlocks = Math.floor(TOTAL / BLOCK);
  A(TOTAL % BLOCK !== 0, '10. the fixture really does have a partial final block');
  A(percent(wholeBlocks * BLOCK, TOTAL) < 100,
    '11. padded block capacity is never counted as a finished file');
  A(percent(TOTAL, TOTAL) === 100, '12. only the real final byte reaches 100%');
}
{
  // floor, not round: 99.6% must not render as 100%.
  const TOTAL = 1000;
  A(percent(996, TOTAL) === 99, '13. 99.6% floors to 99 — never 100 with bytes outstanding');
}

// ── 5. THE SHIPPED CODE USES THIS, NOT BLOCKS ──────────────────────
A(/const pct = st && st\.totalBytes > 0/.test(BUBBLE),
  '14. the bubble prefers totalBytes as the denominator');
A(/Math\.floor\(\(Math\.max\(0, Math\.min\(st\.bytes, st\.totalBytes\)\) \/ st\.totalBytes\)/.test(BUBBLE),
  '15. clamped and floored, exactly as above');
A(!/const pct = st && st\.total > 0/.test(BUBBLE),
  '16. and no longer leads with the growing block plan');
A(/if \(t\.totalBytes > 0\)/.test(readFileSync(join(ROOT, 'lib', 'vaultBeam', 'backgroundService.ts'), 'utf8')),
  '17. the notification uses the same denominator');
A(/bytes: Math\.min\(done \* CHUNK_BYTES, opts\.size\)/.test(CTRL) &&
  /bytes: Math\.min\(done \* CHUNK_BYTES, manifest\.size\)/.test(CTRL),
  '18. the direct paths clamp chunk-count bytes to the real file size');

// ── 6. THE NOTIFICATION AGREES WITH THE BAR ────────────────────────
{
  const t = {
    transferId: 'x', role: 'sender' as const, status: 'uploading',
    done: 40, total: 157,                 // a mid-growth plan
    bytes: 396_053_202, totalBytes: 792_106_404,
    transport: 'R2_RELAY',
  };
  const { text } = notificationText([t]);
  A(/50%/.test(text),
    '19. the notification reports 50% from BYTES, not 25% from the block plan');
  A(!/25%/.test(text), '20. the block-derived number never appears');
}

// ── 7. STAGED IS NOT DELIVERED ─────────────────────────────────────
{
  const { text } = notificationText([{
    transferId: 'x', role: 'sender', status: 'uploading',
    done: 189, total: 189, bytes: 792_106_404, totalBytes: 792_106_404,
    transport: 'R2_RELAY',
  }]);
  A(/100%/.test(text), '21. a fully staged upload reads 100%');
  A(!/Delivered|Complete|Verified/i.test(text),
    '22. but is never called delivered — the peer has not pulled it yet');
}

console.log(failures === 0
  ? '\nALL PROGRESS CHECKS PASSED ✓  (device re-run of the 755 MB case still required)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
