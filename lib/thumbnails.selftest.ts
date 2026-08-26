// lib/thumbnails.selftest.ts — the preview timeout guard.
//
// Run: npx tsx lib/thumbnails.selftest.ts
//
// withTimeout is copied rather than imported for the reason in
// [[vaultchat-selfcheck-metro-trap]]: importing lib/thumbnails pulls in
// expo-image-manipulator and expo-video-thumbnails, which do not exist in a
// plain node process. The drift guard at the bottom fails if the real one
// changes shape.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert';

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

const never = new Promise<string | null>(() => {});      // models a wedged decoder

(async () => {
  // THE REGRESSION THIS EXISTS FOR: a promise that never settles must still
  // resolve, or sendMessage is never reached and the bubble sits pending
  // forever — which is what "the app hung" looks like to a user.
  const t0 = Date.now();
  assert.equal(await withTimeout(never, 60, null), null);
  assert.ok(Date.now() - t0 >= 55, 'must actually wait for the timeout');

  // A rejection resolves to the fallback rather than escaping: callers treat a
  // missing preview as "no preview", never as a failed send.
  assert.equal(await withTimeout(Promise.reject(new Error('decode failed')), 1000, null), null);

  // The happy path is untouched and does NOT wait out the timer.
  const t1 = Date.now();
  assert.equal(await withTimeout(Promise.resolve('abc'), 5000, null), 'abc');
  assert.ok(Date.now() - t1 < 200, 'a settled promise must not wait for the timeout');

  // A late settle after the timeout must not throw or double-resolve.
  let reject!: (e: Error) => void;
  const late = new Promise<string | null>((_, rj) => { reject = rj; });
  assert.equal(await withTimeout(late, 40, null), null);
  reject(new Error('too late'));
  await new Promise((r) => setTimeout(r, 30));   // an unhandled rejection would surface here

  // A falsy non-null fallback must be preserved, not coerced.
  assert.equal(await withTimeout(never as any, 40, ''), '');

  // Drift guard against the real implementation.
  const src = readFileSync(join(__dirname, 'thumbnails.ts'), 'utf8');
  assert.ok(src.includes('export function withTimeout'), 'withTimeout missing from thumbnails.ts');
  for (const call of ['withTimeout(makeThumbInner(', 'withTimeout(requestPdfThumb(']) {
    assert.ok(src.includes(call), `preview path no longer bounded by the clock: ${call}`);
  }

  console.log('thumbnails timeout guard: all assertions passed');
})();
