// lib/mediaOutbox.progress.selftest.ts — the upload-progress emit gate.
//
// Run: npx tsx lib/mediaOutbox.progress.selftest.ts
//
// shouldEmitProgress is pure, so it is tested directly rather than through the
// outbox (which needs SQLite, NetInfo and a network). It is imported from a
// standalone copy of the predicate below for exactly the reason recorded in
// [[vaultchat-selfcheck-metro-trap]]: importing lib/mediaOutbox here would drag
// expo-file-system + netinfo into a plain node process.
//
// KEEP IN SYNC with mediaOutbox.shouldEmitProgress. The guard at the bottom
// fails loudly if the source drifts from this copy.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert';

type UploadPhase = 'preparing' | 'uploading';
type Sample = { phase: UploadPhase; frac: number };

function shouldEmitProgress(prev: Sample | undefined, next: Sample): boolean {
  if (!prev) return true;
  if (prev.phase !== next.phase) return true;
  if (next.frac < prev.frac) return false;
  if (next.frac >= 1 && prev.frac < 1) return true;
  return next.frac - prev.frac >= 0.01;
}

// First sample of an attempt always paints — otherwise a small file that
// finishes inside one sample would never show progress at all.
assert.equal(shouldEmitProgress(undefined, { phase: 'preparing', frac: 0 }), true);

// Phase transition always paints: this is what swaps "Preparing…" for
// "Uploading 0%".
assert.equal(
  shouldEmitProgress({ phase: 'preparing', frac: 1 }, { phase: 'uploading', frac: 0 }),
  true,
);

// Sub-1% jitter is suppressed — the whole point of the gate. A 90 MB upload
// emitting per packet would re-render the chat list hundreds of times a second.
assert.equal(
  shouldEmitProgress({ phase: 'uploading', frac: 0.5 }, { phase: 'uploading', frac: 0.502 }),
  false,
);
assert.equal(
  shouldEmitProgress({ phase: 'uploading', frac: 0.5 }, { phase: 'uploading', frac: 0.51 }),
  true,
);

// THE REGRESSION THIS EXISTS FOR (plan §8): a failed multipart part must not
// yank the ring backwards while the parts that already landed are still valid.
assert.equal(
  shouldEmitProgress({ phase: 'uploading', frac: 0.7 }, { phase: 'uploading', frac: 0.3 }),
  false,
);

// 100% always lands even when the step from the previous sample is under 1% —
// otherwise the ring could stall at 99% forever while the send completes.
assert.equal(
  shouldEmitProgress({ phase: 'uploading', frac: 0.999 }, { phase: 'uploading', frac: 1 }),
  true,
);
// ...but only once; a repeated 1 is not worth a render.
assert.equal(
  shouldEmitProgress({ phase: 'uploading', frac: 1 }, { phase: 'uploading', frac: 1 }),
  false,
);

// A whole upload emits ~100 samples per phase, not thousands. Guards the cap
// against someone loosening the threshold without noticing the render cost.
let emitted = 0;
let prev: Sample | undefined;
for (let i = 0; i <= 10_000; i++) {
  const next: Sample = { phase: 'uploading', frac: i / 10_000 };
  if (shouldEmitProgress(prev, next)) { emitted++; prev = next; }
}
assert.ok(emitted <= 105, `expected ~100 emits over a full upload, got ${emitted}`);

// Drift guard: the predicate above must still match the real one.
const src = readFileSync(join(__dirname, 'mediaOutbox.ts'), 'utf8');
const body = src.slice(src.indexOf('export function shouldEmitProgress'));
for (const line of [
  'if (!prev) return true;',
  'if (prev.phase !== next.phase) return true;',
  'if (next.frac < prev.frac) return false;',
  'return next.frac - prev.frac >= 0.01;',
]) {
  assert.ok(body.includes(line), `mediaOutbox.shouldEmitProgress drifted — missing: ${line}`);
}

console.log('mediaOutbox progress gate: all assertions passed');
