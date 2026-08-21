// lib/golive/stageLayout.ts — who gets the full frame, and how big the corner is.
//
// WHY THIS IS NOT INLINE IN THE SCREEN
//
// A publisher on stage can be sending a camera AND a screen at the same time,
// under one identity. Deciding which of the two owns the stage is three lines
// of `??` and exactly the kind of three lines that get it backwards: the screen
// share replaces the host's face instead of appearing beside it, or the camera
// picture-in-picture ends up rendering the same stream as the stage behind it.
// Both failures look like "the stream is fine" from the publisher's side, which
// is why they survive a casual test.
//
// PURE — takes stream URLs and window numbers, returns a decision. No React, no
// react-native import, so it runs under `npx tsx` and the screen supplies
// Dimensions/insets itself.

export interface StagePick {
  /** The stream that fills the screen. Null when there is nothing to show. */
  main: string | null;
  /** The stream that shrinks to the corner, or null when there is only one. */
  pip: string | null;
  /** True when `main` is a screen share — which changes how it must be drawn. */
  mainIsScreen: boolean;
}

/**
 * A SCREEN SHARE ALWAYS WINS THE STAGE.
 *
 * It is the thing being shown, and it carries text that is unreadable at
 * thumbnail size. The camera keeps a face on screen — the reason a live stream
 * beats a screenshot — so it demotes to the corner rather than disappearing.
 *
 * With no screen share there is no picture-in-picture at all: a camera floating
 * over a copy of itself is the bug this function exists to make impossible.
 */
export function pickStage(
  camera: string | null | undefined,
  screen: string | null | undefined,
): StagePick {
  if (screen) return { main: screen, pip: camera ?? null, mainIsScreen: true };
  return { main: camera ?? null, pip: null, mainIsScreen: false };
}

/** Smallest and largest a corner preview may be, whatever the panel. */
export const PIP_MIN = 84;
export const PIP_MAX = 140;

/**
 * Picture-in-picture geometry, DERIVED — never a fixed box.
 *
 * A quarter of the SHORT edge, so it carries the same visual weight in portrait
 * and landscape and on any panel size, then clamped so it is neither a postage
 * stamp on a small phone nor a second stage on a tablet. 4:3 portrait, which is
 * roughly what a front camera cropped to a corner wants.
 */
export function pipSize(winW: number, winH: number): { width: number; height: number } {
  const short = Math.min(winW, winH);
  const usable = Number.isFinite(short) && short > 0 ? short : PIP_MIN * 4;
  const width = Math.round(Math.min(Math.max(usable * 0.25, PIP_MIN), PIP_MAX));
  return { width, height: Math.round(width * 4 / 3) };
}

export default { pickStage, pipSize, PIP_MIN, PIP_MAX };

// ── self-check ────────────────────────────────────────────────────
//
// PURE ONLY — no fs, no path. This module is imported by the app, and Metro
// resolves require() statically: a `require('fs')` in here fails the bundle
// even though the branch never runs on device. The structural assertions about
// app/live-view.tsx live in immersiveStage.selftest.ts, which nothing imports.
//
//   npx tsx lib/golive/stageLayout.ts
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  console.log('\nGo Live stage layout\n');

  // ── which stream owns the frame ──────────────────────────────────
  const CAM = 'stream://camera';
  const SCR = 'stream://screen';

  const both = pickStage(CAM, SCR);
  A(both.main === SCR, '1. a screen share takes the stage');
  A(both.pip === CAM, '2. the camera demotes to the corner, it does not vanish');
  A(both.mainIsScreen, '3. the stage is flagged as a screen, so it can be drawn as one');

  const camOnly = pickStage(CAM, null);
  A(camOnly.main === CAM, '4. with no share, the camera has the stage');
  A(camOnly.pip === null, '5. and there is NO picture-in-picture — a camera never floats over itself');
  A(!camOnly.mainIsScreen, '6. a camera stage is not flagged as a screen');

  const scrOnly = pickStage(null, SCR);
  A(scrOnly.main === SCR && scrOnly.pip === null, '7. a share with the camera off fills the screen alone');

  const neither = pickStage(null, undefined);
  A(neither.main === null && neither.pip === null, '8. nothing published yields nothing to draw');

  for (const [c, s] of [[CAM, SCR], [CAM, null], [null, SCR], [null, null]] as const) {
    const r = pickStage(c, s);
    A(r.pip === null || r.pip !== r.main, `9. pip never duplicates the stage (${c ? 'cam' : '-'}/${s ? 'scr' : '-'})`);
  }

  // ── corner geometry, on real panels ──────────────────────────────
  for (const [w, h, label] of [
    [360, 640, 'small 16:9 phone'],
    [412, 915, 'tall 20:9 phone'],
    [320, 568, 'smallest supported phone'],
    [834, 1194, 'tablet'],
    [915, 412, 'phone in landscape'],
  ] as const) {
    const { width, height } = pipSize(w, h);
    A(width >= PIP_MIN && width <= PIP_MAX, `10. ${label}: pip width ${width} stays inside [${PIP_MIN},${PIP_MAX}]`);
    A(width < w && height < h, `11. ${label}: pip fits on the panel`);
  }
  A(pipSize(915, 412).width === pipSize(412, 915).width,
    '12. rotating the device does not resize the corner — it reads the SHORT edge');
  for (const [w, h] of [[0, 0], [NaN, 100], [-5, -5]] as const) {
    const r = pipSize(w as number, h as number);
    A(r.width >= PIP_MIN && Number.isFinite(r.height), `13. an unmeasurable window ${w}x${h} still yields a usable box`);
  }

  console.log(failures === 0
    ? '\nALL STAGE-LAYOUT CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
