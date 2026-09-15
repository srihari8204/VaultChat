// lib/vaultcheck/detector.ts — the learned deepfake-detection slot.
//
// ── Read this before implementing anything here ──
//
// This module is deliberately EMPTY of detection logic, and that is the
// feature, not an oversight.
//
// crazzychat previously shipped a "World-First AI" deepfake detector whose score
// was computed from JPEG base64 character-code variance plus `Math.random() * 7`
// (constants/deepfakeDetection.ts, since deleted — see
// docs/FEATURE_GAP_MATRIX.md). It produced confident-looking percentages that
// meant nothing. For a feature whose entire purpose is telling a woman whether
// an intimate image of her is fabricated, a fabricated answer is worse than no
// answer: it launders a coin flip into evidence she may act on, or that someone
// else may use against her.
//
// So the contract here is: this returns `available: false` until a real model is
// bundled, and every caller renders that as "not checked" — never as "clean",
// never as a number. Do not add heuristics to fill the gap. Compression
// artefacts, EXIF absence, and file-size ratios are not deepfake detection, and
// dressing them up as a percentage recreates exactly the bug that was removed.
//
// ── What landing a real model requires ──
//
//   1. A model with a licence that permits redistribution (FaceForensics++ and
//      the DFDC-winner EfficientNet weights are the usual candidates), plus
//      recorded provenance and measured accuracy on a held-out set.
//   2. A runtime: onnxruntime-react-native or react-native-fast-tflite. Neither
//      is a dependency today; adding one is a deliberate app-size decision
//      (~5 MB for MesoNet-class, ~20 MB for EfficientNet-B0).
//   3. Delivery: download-on-first-use over Wi-Fi rather than bundling, so the
//      APK stays small for low-bandwidth users, with a signature check on the
//      downloaded weights.
//   4. Calibration: a raw sigmoid output is not a probability. Publish the
//      operating point and the false-positive rate at that threshold, and show
//      the user a band, not a spurious two-decimal figure.
//
// Until all four exist, `run()` reports unavailable and VaultCheck leans on the
// two layers that ARE real: C2PA provenance and rPPG.

export interface DetectorResult {
  available: boolean;
  /** 0–1 likelihood of synthesis. Present ONLY when available === true. */
  score?: number;
  /** Model identifier + version, for auditability of a given verdict. */
  model?: string;
  /** Why the detector could not run. */
  reason?: string;
}

const UNAVAILABLE: DetectorResult = {
  available: false,
  reason: 'No detection model is bundled with this build.',
};

/** True once a real model + runtime are wired up. */
export function isDetectorAvailable(): boolean { return false; }

/**
 * Run the learned detector over an image or video frame.
 *
 * Always resolves — never throws — and currently always reports unavailable.
 * The `_uri` parameter is kept so the call sites and their tests are already in
 * their final shape when a model lands.
 */
export async function run(_uri: string): Promise<DetectorResult> {
  return { ...UNAVAILABLE };
}

export default {};
