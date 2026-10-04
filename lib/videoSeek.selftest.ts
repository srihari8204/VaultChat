/**
 * lib/videoSeek.selftest.ts
 *   run with: npx tsx lib/videoSeek.selftest.ts
 */
import assert from 'node:assert/strict';
import { seekFraction, seekTargetMs, resumeKey } from './videoSeek';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

// seekFraction
ok('middle of track', seekFraction(50, 200) === 0.25);
ok('clamped below 0', seekFraction(-30, 200) === 0);
ok('clamped above 1', seekFraction(500, 200) === 1);
ok('unmeasured track is 0, not NaN/Infinity', seekFraction(10, 0) === 0);
ok('NaN location is 0', seekFraction(NaN, 200) === 0);

// seekTargetMs — the stale-closure bug was "duration 0 → never seeks"; the
// screen now reads a live duration, and an unknown one is an explicit null.
ok('unknown duration → null', seekTargetMs(0.5, 0) === null);
ok('half of 60s', seekTargetMs(0.5, 60_000) === 30_000);
ok('fraction clamped', seekTargetMs(2, 60_000) === 60_000);
ok('negative clamped', seekTargetMs(-1, 60_000) === 0);

// resumeKey
const latin = 'file:///data/user/0/app/cache/clip.mp4';
ok('Latin-1 key unchanged from the old btoa scheme',
  resumeKey(latin) === `vc_video_pos_${btoa(latin).substring(0, 40)}`);
let threw = false;
let k = '';
try { k = resumeKey('file:///cache/वीडियो.mp4'); } catch { threw = true; }
ok('non-Latin-1 path does not throw', !threw && k.startsWith('vc_video_pos_'));

console.log(`videoSeek selftest: ${n} checks passed`);
