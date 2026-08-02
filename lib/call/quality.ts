// lib/call/quality.ts — adaptive video quality policy.
//
// WHY THIS IS A SEPARATE, PURE MODULE
// -----------------------------------
// libwebrtc adapts on its own, but only within whatever ceiling the sender is
// given, and by default that ceiling is "as much as the link seems to allow".
// On mid-tier Android that is the wrong target: the encoder, the radio and the
// display are competing for the same thermal and battery budget, and a call
// that looks marginally better while draining the battery and throttling the
// CPU is a bad trade. Capping deliberately — and stepping the cap with measured
// conditions — is what the product spec means by "adaptive bitrate / adaptive
// FPS / battery efficiency".
//
// The policy is pure so it can be tested. Feeding real getStats() samples
// through a reducer, with no WebRTC objects involved, means the tuning that
// actually matters — when to drop, when to recover, and how not to oscillate —
// is verified in Node instead of guessed at on a phone.
//
// TUNING RATIONALE
//   Down fast, up slow. One bad sample steps down; recovery needs several
//   consecutive good ones. Users forgive a quality drop far more than they
//   forgive a freeze, and oscillating between tiers looks worse than sitting at
//   the lower one.
//
//   Thresholds are chosen against mobile reality, not a LAN: 5% loss and 400 ms
//   RTT are ordinary on a congested cell, so those are the DOWN triggers, while
//   UP needs a genuinely clean link (<2% loss, <200 ms).

export interface QualityTier {
  name: 'high' | 'medium' | 'low';
  /** Encoder ceiling in bits/sec, handed to RTCRtpSender.setParameters. */
  maxBitrate: number;
  maxFramerate: number;
  /** 1 = native capture resolution; 2 = half width and height. */
  scaleResolutionDownBy: number;
}

export const TIERS: Record<QualityTier['name'], QualityTier> = {
  high:   { name: 'high',   maxBitrate: 1_200_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  medium: { name: 'medium', maxBitrate:   600_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 },
  low:    { name: 'low',    maxBitrate:   250_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
};

const ORDER: QualityTier['name'][] = ['low', 'medium', 'high'];

/** One observation, distilled from an RTCStatsReport. */
export interface QualitySample {
  /** Fraction of packets lost since the previous sample, 0..1. */
  lossRatio: number;
  /** Round-trip time in ms, or null when not yet reported. */
  rttMs: number | null;
}

export interface QualityState {
  tier: QualityTier['name'];
  /** Consecutive clean samples — the ratchet that gates stepping back up. */
  goodStreak: number;
}

export const INITIAL_QUALITY: QualityState = { tier: 'high', goodStreak: 0 };

/** Loss/RTT above which we step down immediately. */
export const DOWN_LOSS = 0.05;
export const DOWN_RTT_MS = 400;
/** Loss/RTT that counts a sample as clean. */
export const UP_LOSS = 0.02;
export const UP_RTT_MS = 200;
/** Clean samples needed before stepping back up. */
export const UP_STREAK = 3;

/**
 * Next quality state. Pure: same inputs, same output, no clock, no I/O.
 *
 * A null rttMs (nothing measured yet, common in the first seconds) is treated as
 * "not bad" for the down-check but NOT as good for the up-check — absence of
 * evidence must not ratchet quality upward.
 */
export function nextQuality(state: QualityState, s: QualitySample): QualityState {
  const idx = ORDER.indexOf(state.tier);

  const bad = s.lossRatio >= DOWN_LOSS || (s.rttMs !== null && s.rttMs >= DOWN_RTT_MS);
  if (bad) {
    return { tier: ORDER[Math.max(0, idx - 1)], goodStreak: 0 };
  }

  const good = s.lossRatio <= UP_LOSS && s.rttMs !== null && s.rttMs <= UP_RTT_MS;
  if (!good) return state.goodStreak === 0 ? state : { ...state, goodStreak: 0 };

  const streak = state.goodStreak + 1;
  if (streak < UP_STREAK || idx === ORDER.length - 1) {
    return { tier: state.tier, goodStreak: streak };
  }
  return { tier: ORDER[idx + 1], goodStreak: 0 };
}

/**
 * Distil an RTCStatsReport into a sample. `prev` carries the previous cumulative
 * counters, since getStats reports totals and loss is only meaningful as a delta.
 *
 * Tolerant by design: partial or missing stats yield a neutral sample rather
 * than a fabricated one, so a device that reports little cannot be mistaken for
 * a device on a perfect link.
 */
export interface StatsCursor { packetsSent: number; packetsLost: number }
export const INITIAL_CURSOR: StatsCursor = { packetsSent: 0, packetsLost: 0 };

export function sampleFromTotals(
  cur: StatsCursor, rttMs: number | null, prev: StatsCursor,
): { sample: QualitySample; cursor: StatsCursor } {
  const dSent = cur.packetsSent - prev.packetsSent;
  const dLost = cur.packetsLost - prev.packetsLost;
  // Too few packets to judge (or counters reset) → neutral, not "good".
  const lossRatio = dSent > 20 && dLost >= 0 ? Math.min(1, dLost / dSent) : 0;
  const usable = dSent > 20;
  return {
    sample: { lossRatio, rttMs: usable ? rttMs : null },
    cursor: cur,
  };
}

export default {};
