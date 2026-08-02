// lib/vaultcheck/rppgCore.ts — the rPPG signal processing, free of React Native.
//
// Living skin changes colour very slightly with each cardiac cycle as blood
// fills the capillaries near the surface. A camera records it; the signal is
// buried under motion and lighting noise but recoverable with standard signal
// processing. A generated face has no cardiovascular system, so there is no
// pulse to recover — which makes "is there a pulse?" a useful, if partial,
// authenticity signal.
//
// ── The method ──
//
//   1. Per-frame mean R/G/B over a face region arrives from native
//      (plugins/android/VaultMediaModule.kt · sampleVideoChannels).
//   2. CHROM projection (de Haan & Jeanne 2013): X = 3R − 2G, Y = 1.5R + G − 1.5B,
//      then S = X − alpha*Y with alpha = sigma(X)/sigma(Y). This cancels the
//      specular/motion component far better than the naive "just use the green
//      channel", which is why green-only implementations report pulses on
//      static images.
//   3. Detrend, Hann window, DFT over the pulse band only.
//   4. Look for a dominant peak in 0.7–3.0 Hz (42–180 BPM).
//
// ── What a result actually means ──
//
// A found pulse is decent evidence of a live human. A MISSING pulse is much
// weaker evidence of a fake: bad lighting, a moving camera, heavy compression,
// a small or turned face, or simply too short a clip all destroy the signal.
// So `verdict` distinguishes 'pulse' / 'no-pulse' / 'inconclusive', and callers
// must not collapse the last two together. Reporting "no heartbeat → deepfake"
// on a shaky low-light clip of a real person is the failure mode this module is
// written to avoid.
//
// No React Native imports here on purpose — rppg.selftest.ts exercises this
// under plain node.

export interface RppgSample { tMs: number; r: number; g: number; b: number }

export interface RppgResult {
  verdict: 'pulse' | 'no-pulse' | 'inconclusive';
  /** Estimated rate in BPM when verdict === 'pulse'. */
  bpm?: number;
  /** Peak-to-mean spectral ratio in the pulse band; higher is a cleaner pulse. */
  snr?: number;
  /** Effective sampling rate actually achieved (frames/sec). */
  fps?: number;
  frames: number;
  reason?: string;
}

const BAND_LOW = 0.7;    // 42 BPM
const BAND_HIGH = 3.0;   // 180 BPM

/** Minimum usable clip: below this the frequency resolution is too coarse. */
const MIN_SECONDS = 4;
const MIN_FRAMES = 48;

/**
 * How far above the band's mean power the peak must stand to count as a pulse.
 *
 * This CANNOT be a fixed number, which an earlier revision got wrong: pure
 * noise reliably scored 4.2 against a fixed threshold of 4.0 and was reported
 * as a heartbeat. The reason is statistical, not a tuning accident — for a
 * periodogram of white noise the bin powers are exponentially distributed, so
 * the expected peak-to-mean ratio over n independent bins is the harmonic
 * number, ≈ ln(n) + γ. A longer clip has finer frequency resolution, hence more
 * independent bins, hence a HIGHER expected noise peak. Any constant threshold
 * is therefore either too permissive for long clips or too strict for short
 * ones.
 *
 * Independent bins = band width × duration (resolution is 1/T), and the
 * threshold is that expectation with a 2× margin. Measured against synthetic
 * series: noise lands at 2.5–6.1 and genuine pulses at 11–18, so a 12-second
 * clip's bar of ≈7.8 sits in the gap with room on both sides.
 *
 * The margin is deliberately biased toward missing a real pulse rather than
 * inventing one. A missed pulse yields 'no-pulse', which the verdict layer
 * treats as weak evidence of nothing; a false pulse would be presented to the
 * user as evidence of a live human.
 */
const EULER_MASCHERONI = 0.5772;
const SNR_MARGIN = 2.0;
const SNR_FLOOR = 5.0;

function snrThreshold(durationSeconds: number): number {
  const independentBins = Math.max(2, (BAND_HIGH - BAND_LOW) * durationSeconds);
  return Math.max(SNR_FLOOR, (Math.log(independentBins) + EULER_MASCHERONI) * SNR_MARGIN);
}

function mean(a: number[]): number { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }

function stdev(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(mean(a.map(v => (v - m) ** 2)));
}

/** Remove linear trend — slow lighting drift otherwise dominates the spectrum. */
function detrend(a: number[]): number[] {
  const n = a.length;
  if (n < 2) return a.slice();
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = mean(xs), my = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (a[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  return a.map((v, i) => v - (slope * i + intercept));
}

/**
 * CHROM projection. Combines the channels so that the motion/specular component
 * — which is achromatic and therefore equal across R, G and B — cancels, while
 * the blood-volume component (which is not) survives.
 */
function chrom(samples: RppgSample[]): number[] {
  // Normalise each channel by its own mean so absolute exposure drops out.
  const rs = samples.map(s => s.r), gs = samples.map(s => s.g), bs = samples.map(s => s.b);
  const mr = mean(rs) || 1, mg = mean(gs) || 1, mb = mean(bs) || 1;
  const X: number[] = [], Y: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const r = rs[i] / mr, g = gs[i] / mg, b = bs[i] / mb;
    X.push(3 * r - 2 * g);
    Y.push(1.5 * r + g - 1.5 * b);
  }
  const dx = detrend(X), dy = detrend(Y);
  const sy = stdev(dy);
  const alpha = sy === 0 ? 0 : stdev(dx) / sy;
  return dx.map((v, i) => v - alpha * dy[i]);
}

/** Hann window — reduces spectral leakage from the finite record length. */
function hann(a: number[]): number[] {
  const n = a.length;
  return a.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
}

/**
 * Direct DFT over just the pulse band. The record is short (a few hundred
 * samples) and we only need ~200 bins, so a full FFT would be more code for no
 * measurable gain.
 */
function bandSpectrum(sig: number[], fps: number, bins = 256): { freq: number; power: number }[] {
  const n = sig.length;
  const out: { freq: number; power: number }[] = [];
  for (let k = 0; k < bins; k++) {
    const f = BAND_LOW + ((BAND_HIGH - BAND_LOW) * k) / (bins - 1);
    const w = (2 * Math.PI * f) / fps;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += sig[i] * Math.cos(w * i); im -= sig[i] * Math.sin(w * i); }
    out.push({ freq: f, power: (re * re + im * im) / (n * n) });
  }
  return out;
}

/**
 * Analyse a sampled series for a cardiac pulse.
 *
 * Returns 'inconclusive' — not 'no-pulse' — whenever the input could not
 * support a reliable answer (too few frames, too short, uneven sampling). See
 * the header for why that distinction is load-bearing.
 */
export function analyse(samples: RppgSample[]): RppgResult {
  const frames = samples.length;
  if (frames < MIN_FRAMES) {
    return { verdict: 'inconclusive', frames, reason: `need ≥${MIN_FRAMES} frames, got ${frames}` };
  }

  const durationMs = samples[frames - 1].tMs - samples[0].tMs;
  if (durationMs < MIN_SECONDS * 1000) {
    return { verdict: 'inconclusive', frames, reason: `clip too short (${Math.round(durationMs / 1000)}s)` };
  }
  const fps = (frames - 1) / (durationMs / 1000);
  if (fps < 2 * BAND_HIGH) {
    // Below Nyquist for the top of the band — a "pulse" here could be an alias.
    return { verdict: 'inconclusive', frames, fps, reason: `sampling too sparse (${fps.toFixed(1)} fps)` };
  }

  const sig = hann(detrend(chrom(samples)));
  if (stdev(sig) === 0) {
    return { verdict: 'inconclusive', frames, fps, reason: 'flat signal (static or fully saturated region)' };
  }

  const spec = bandSpectrum(sig, fps);
  let peak = spec[0];
  for (const s of spec) if (s.power > peak.power) peak = s;
  const avg = mean(spec.map(s => s.power));
  const snr = avg === 0 ? 0 : peak.power / avg;

  const threshold = snrThreshold(durationMs / 1000);
  if (snr < threshold) {
    return {
      verdict: 'no-pulse', frames, fps, snr,
      reason: `no dominant frequency in the cardiac band (${snr.toFixed(1)} < ${threshold.toFixed(1)})`,
    };
  }
  return { verdict: 'pulse', bpm: Math.round(peak.freq * 60), snr, fps, frames };
}

