// run: npx tsx lib/storyDuration.selftest.ts
import assert from 'node:assert/strict';
import { storyDurationMs, IMAGE_DURATION_MS, VIDEO_FALLBACK_MS, VIDEO_MAX_MS, VIDEO_MIN_MS } from './storyDuration';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); n++; };
eq(storyDurationMs('image'), IMAGE_DURATION_MS, 'image');
eq(storyDurationMs('text', 9000), IMAGE_DURATION_MS, 'text ignores a duration');
eq(storyDurationMs('video'), VIDEO_FALLBACK_MS, 'unknown video length → fallback');
eq(storyDurationMs('video', 6400.4), 6400, 'real length');
eq(storyDurationMs('video', 300_000), VIDEO_MAX_MS, 'long clip capped');
eq(storyDurationMs('video', 200), VIDEO_MIN_MS, 'tiny clip floored');
eq(storyDurationMs('video', NaN), VIDEO_FALLBACK_MS, 'NaN → fallback');
console.log(`storyDuration selftest: ${n} checks passed`);
