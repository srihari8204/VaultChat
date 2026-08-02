// lib/call/quality.selftest.ts — run: npx tsx lib/call/quality.selftest.ts
//
// The tuning IS the feature here, so this checks the behaviours that decide
// whether a call feels stable: that a bad link drops immediately, that recovery
// is slow enough not to flap, and that missing stats never ratchet quality up.

import {
  INITIAL_CURSOR, INITIAL_QUALITY, TIERS, UP_STREAK,
  nextQuality, sampleFromTotals, type QualitySample, type QualityState,
} from './quality';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const clean: QualitySample  = { lossRatio: 0.001, rttMs: 80 };
const lossy: QualitySample  = { lossRatio: 0.09,  rttMs: 120 };
const laggy: QualitySample  = { lossRatio: 0.001, rttMs: 650 };
const meh: QualitySample    = { lossRatio: 0.03,  rttMs: 250 };   // neither good nor bad
const unknown: QualitySample = { lossRatio: 0,    rttMs: null };

const run = (start: QualityState, samples: QualitySample[]) =>
  samples.reduce((st, s) => nextQuality(st, s), start);

console.log('tiers are ordered and monotonic:');
check('bitrate high > medium > low',
  TIERS.high.maxBitrate > TIERS.medium.maxBitrate && TIERS.medium.maxBitrate > TIERS.low.maxBitrate);
check('framerate high > medium > low',
  TIERS.high.maxFramerate > TIERS.medium.maxFramerate && TIERS.medium.maxFramerate > TIERS.low.maxFramerate);
check('downscale increases as tier drops',
  TIERS.low.scaleResolutionDownBy > TIERS.medium.scaleResolutionDownBy
  && TIERS.medium.scaleResolutionDownBy > TIERS.high.scaleResolutionDownBy);

console.log('\ndown is immediate — one bad sample is enough:');
eq('packet loss drops a tier', nextQuality(INITIAL_QUALITY, lossy).tier, 'medium');
eq('high RTT drops a tier', nextQuality(INITIAL_QUALITY, laggy).tier, 'medium');
eq('two bad samples reach low', run(INITIAL_QUALITY, [lossy, lossy]).tier, 'low');
eq('low is the floor', run(INITIAL_QUALITY, [lossy, lossy, lossy, lossy]).tier, 'low');
eq('dropping resets the recovery streak',
  run({ tier: 'high', goodStreak: 2 }, [lossy]).goodStreak, 0);

console.log('\nup is slow — recovery needs a sustained clean link:');
let st = run({ tier: 'low', goodStreak: 0 }, [clean, clean]);
eq(`${UP_STREAK - 1} clean samples do NOT step up yet`, st.tier, 'low');
eq('...but the streak is counted', st.goodStreak, 2);
st = nextQuality(st, clean);
eq(`${UP_STREAK} clean samples step up`, st.tier, 'medium');
eq('streak resets after stepping up', st.goodStreak, 0);
eq('another 3 clean samples reach high', run(st, [clean, clean, clean]).tier, 'high');
eq('high is the ceiling', run({ tier: 'high', goodStreak: 0 }, [clean, clean, clean, clean]).tier, 'high');

console.log('\nno flapping — a mediocre link holds its tier:');
eq('mediocre samples neither raise nor lower', run({ tier: 'medium', goodStreak: 0 }, [meh, meh, meh]).tier, 'medium');
eq('a mediocre sample breaks the streak', run({ tier: 'low', goodStreak: 2 }, [meh]).goodStreak, 0);
check('a mediocre sample with a zero streak is a no-op (same reference)',
  (() => { const s: QualityState = { tier: 'medium', goodStreak: 0 }; return nextQuality(s, meh) === s; })());
// The real oscillation risk: alternating good/bad must not climb.
eq('alternating good/bad settles DOWN, never up',
  run(INITIAL_QUALITY, [lossy, clean, lossy, clean, lossy, clean]).tier, 'low');

console.log('\nmissing stats must never ratchet quality upward:');
eq('null RTT is not "good"', run({ tier: 'low', goodStreak: 0 }, [unknown, unknown, unknown, unknown]).tier, 'low');
eq('null RTT does not count toward the streak',
  run({ tier: 'low', goodStreak: 0 }, [unknown, unknown, unknown]).goodStreak, 0);
eq('null RTT alone does NOT trigger a drop', nextQuality(INITIAL_QUALITY, unknown).tier, 'high');

console.log('\nsampleFromTotals — loss is a delta, not a total:');
let r = sampleFromTotals({ packetsSent: 1000, packetsLost: 50 }, 100, INITIAL_CURSOR);
eq('first sample uses the delta from zero', Number(r.sample.lossRatio.toFixed(3)), 0.05);
r = sampleFromTotals({ packetsSent: 2000, packetsLost: 55 }, 100, { packetsSent: 1000, packetsLost: 50 });
eq('second sample sees only the NEW loss', Number(r.sample.lossRatio.toFixed(3)), 0.005);
check('cursor advances', r.cursor.packetsSent === 2000);
r = sampleFromTotals({ packetsSent: 1005, packetsLost: 50 }, 100, { packetsSent: 1000, packetsLost: 50 });
eq('too few packets -> neutral, rtt withheld', r.sample, { lossRatio: 0, rttMs: null });
r = sampleFromTotals({ packetsSent: 10, packetsLost: 0 }, 50, { packetsSent: 5000, packetsLost: 10 });
eq('counter reset does not fabricate loss', r.sample.lossRatio, 0);

console.log(failures === 0
  ? '\nALL QUALITY POLICY CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
