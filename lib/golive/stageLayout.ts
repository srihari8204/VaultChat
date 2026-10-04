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

/**
 * How much of a SHARED SCREEN may be cropped to make it fill the panel.
 *
 * Measured on device 2026-08-25: an Honor sharing at 600x1332 (0.450) onto a
 * Redmi panel of 1080x2220 (0.486) leaves a 3.7% black bar down each side and
 * costs 7.4% of the width to close. A shared screen is worth 7% of its edges to
 * stop looking like a postage stamp; it is not worth 30%, which is where the
 * toolbar and the last column live.
 */
export const SCREEN_CROP_BUDGET = 0.12;

/**
 * FIT OR FILL, DECIDED FROM THE ACTUAL FRAME — not from a fixed guess.
 *
 * Every stream ends up in one of three situations and they want opposite
 * things, which is why a single hard-coded objectFit was always going to be
 * wrong for someone:
 *
 *   * A CAMERA fills, always. A cropped face is what every video app on the
 *     phone shows; a letterboxed one reads as broken.
 *   * A SCREEN SHARE from a phone of roughly the viewer's shape fills too —
 *     the bars it would otherwise carry are worth more than the 7% of edge it
 *     costs to close them.
 *   * A SCREEN SHARE of a genuinely different shape — a landscape desktop, a
 *     tablet, our own HLS canvas — is CONTAINED. Filling would throw away a
 *     third of the picture, which is the half of the toolbar and the last
 *     column that the share exists to show.
 *
 * `videoW`/`videoH` come from the track publication. When they are unknown
 * (the frame has not arrived, or the transport cannot tell us — HLS) the caller
 * supplies its own default; this function reports `null` rather than guessing.
 *
 * ONE MEASURED CAVEAT, device 2026-08-25. TrackInfo carries CAPTURE geometry,
 * not display geometry: the Honor's camera arrives as `1280x720` while its
 * renderer draws 720x1280, because a camera sensor captures landscape and the
 * frames carry a rotation the dimensions do not. Screen capture has no such
 * flag — MediaProjection makes its virtual display at the panel's real size, so
 * a portrait phone reports portrait (that same session logged 1200x2664) — and
 * only `isScreen` frames reach the ratio test at all. If a transposed screen
 * frame ever did arrive, the ratio would read as landscape and this would
 * CONTAIN it: bars, not a crop. The wrong answer here is the harmless one, and
 * that is deliberate.
 *
 * Recomputed on every render, so a rotation, a fold, or a split-screen resize
 * re-decides by itself. That is the whole of what makes it responsive.
 */
export function pickFit(
  videoW: number | undefined | null,
  videoH: number | undefined | null,
  winW: number,
  winH: number,
  isScreen: boolean,
): 'cover' | 'contain' | null {
  if (!isScreen) return 'cover';
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!ok(videoW) || !ok(videoH) || !ok(winW) || !ok(winH)) return null;

  const video = videoW / videoH;
  const panel = winW / winH;
  // Filling scales the frame until BOTH edges cover the panel; whatever the
  // wider ratio is, that is the fraction of the frame pushed off screen.
  const overflow = video > panel ? video / panel : panel / video;
  // The epsilon is not decoration: a frame sitting exactly on the budget lands
  // at 0.12000000000000011 in binary floating point and would flip to contain
  // on float dust rather than on anything a viewer could see.
  return overflow - 1 <= SCREEN_CROP_BUDGET + 1e-9 ? 'cover' : 'contain';
}

/**
 * How far in a viewer may pinch the stage. 4x matches app/video-player.tsx, so
 * the gesture feels the same everywhere in the app.
 */
export const ZOOM_MAX = 4;

/**
 * Zoom NEVER goes below 1.
 *
 * Pinching out past the panel would letterbox a live stage inside its own black
 * — the exact complaint this whole change exists to fix — and leave the viewer
 * holding a picture smaller than the screen with no obvious way back. The
 * gesture still tracks below 1 while the fingers are down; this is what it
 * settles to.
 */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, 1), ZOOM_MAX);
}

/**
 * Keep a zoomed stage COVERING the panel.
 *
 * At scale s the picture is s×panel, so there is exactly panel*(s-1)/2 of slack
 * in each direction; past that the viewer has dragged the picture off its own
 * edge and is looking at black. At 1x there is no slack at all, which is why
 * this returns dead centre and the pan is inert until they zoom in.
 */
export function clampZoomPan(
  x: number,
  y: number,
  scale: number,
  winW: number,
  winH: number,
): { x: number; y: number } {
  const s = clampZoom(scale);
  const fit = (v: number, max: number): number =>
    Number.isFinite(v) && max > 0 ? Math.min(Math.max(v, -max), max) : 0;
  return {
    x: fit(x, (Number.isFinite(winW) ? winW : 0) * (s - 1) / 2),
    y: fit(y, (Number.isFinite(winH) ? winH : 0) * (s - 1) / 2),
  };
}

/** Breathing room between the corner preview and the edge of the panel. */
export const PIP_MARGIN = 12;

/**
 * Keep a DRAGGED corner preview on the panel.
 *
 * A viewer moves the host's face off whatever part of the share it is covering.
 * The one thing they must not be able to do is throw it off the edge: there is
 * nothing out there to grab it by, and getting it back would mean leaving the
 * stream. Clamped against the SAFE AREA rather than the raw window — a preview
 * parked under the status bar or the gesture pill is not draggable either.
 *
 * Run on EVERY render, not only on release: a rotation swaps the window under a
 * position that was perfectly legal in the other orientation.
 */
export function clampPip(
  x: number,
  y: number,
  winW: number,
  winH: number,
  pipW: number,
  pipH: number,
  topInset = 0,
  bottomInset = 0,
  // Zero in portrait, and decidedly not in landscape — where the notch swings
  // to one side and a corner parked under it is half a corner.
  leftInset = 0,
  rightInset = 0,
): { x: number; y: number } {
  // hi < lo when the preview is larger than the space (a tiny window, a huge
  // inset). Pinning to `lo` keeps the grab handle on screen; the alternative
  // parks it off the top, which is the exact failure this function exists for.
  const fit = (v: number, lo: number, hi: number): number =>
    Number.isFinite(v) ? Math.round(Math.min(Math.max(v, lo), Math.max(lo, hi))) : Math.round(lo);
  return {
    x: fit(x, leftInset + PIP_MARGIN, winW - pipW - rightInset - PIP_MARGIN),
    y: fit(y, topInset + PIP_MARGIN, winH - pipH - bottomInset - PIP_MARGIN),
  };
}

/**
 * The next corner, clockwise, for moving the corner preview WITHOUT dragging —
 * a button in the chrome, or a screen reader's action on the preview itself.
 *
 * Which corner it is in now is read from its centre, so a preview the viewer
 * dragged to the middle-left still moves predictably. Top corners sit at
 * `topY` (the caller's home row, clear of the status pill); bottom corners and
 * the sides go as far as clampPip allows, so the result is always on the panel.
 */
export function nextPipCorner(
  at: { x: number; y: number },
  winW: number,
  winH: number,
  pipW: number,
  pipH: number,
  topY: number,
  topInset = 0,
  bottomInset = 0,
  leftInset = 0,
  rightInset = 0,
): { x: number; y: number } {
  const right = at.x + pipW / 2 > winW / 2;
  const bottom = at.y + pipH / 2 > winH / 2;
  // top-left -> top-right -> bottom-right -> bottom-left -> top-left
  const toRight = !bottom;
  const toBottom = right;
  return clampPip(
    toRight ? winW : 0, toBottom ? winH : topY,
    winW, winH, pipW, pipH, topInset, bottomInset, leftInset, rightInset,
  );
}

export default {
  pickStage, pipSize, pickFit, clampPip, nextPipCorner, clampZoom, clampZoomPan,
  PIP_MIN, PIP_MAX, PIP_MARGIN, SCREEN_CROP_BUDGET, ZOOM_MAX,
};

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

  // ── fit or fill, from the real frame ─────────────────────────────
  {
    // THE MEASURED CASE, device 2026-08-25: Honor sharing 600x1332 to a Redmi
    // panel of 1080x2220. 8% overflow — fills, and the share stops looking small.
    A(pickFit(600, 1332, 1080, 2220, true) === 'cover',
      '22. a phone screen shared to a phone of nearly the same shape FILLS the panel');
    // Our own HLS canvas is 16:9 whatever the publisher was.
    A(pickFit(1280, 720, 1080, 2220, true) === 'contain',
      '23. a landscape frame on a portrait phone is CONTAINED — filling would eat two thirds of it');
    A(pickFit(1080, 2220, 1080, 2220, true) === 'cover',
      '24. an exact match fills, with nothing cropped at all');
    A(pickFit(720, 1280, 1080, 2220, false) === 'cover',
      '25. a camera always fills — a cropped face beats a letterboxed one');
    for (const [w, h] of [[0, 0], [NaN, 100], [-4, 8], [undefined, undefined]] as any[]) {
      A(pickFit(w, h, 1080, 2220, true) === null,
        `26. an unknown frame size (${w}x${h}) reports null instead of guessing`);
    }
    // The boundary itself, from both sides — the budget must be the thing that
    // decides, not a rounding artefact.
    const edge = 1080 * (1 + SCREEN_CROP_BUDGET);
    A(pickFit(edge, 2220, 1080, 2220, true) === 'cover', '27. exactly at the crop budget, it still fills');
    A(pickFit(edge * 1.02, 2220, 1080, 2220, true) === 'contain', '28. one percent past it, it contains');
    // Rotation re-decides by itself: the same share against a landscape panel.
    A(pickFit(600, 1332, 2220, 1080, true) === 'contain',
      '29. rotating the VIEWER re-decides — a portrait share must not be cropped into a landscape panel');
  }

  // ── pinch zoom ───────────────────────────────────────────────────
  {
    A(clampZoom(1) === 1 && clampZoom(2.5) === 2.5, '30. a zoom inside the range is left alone');
    A(clampZoom(0.4) === 1, '31. pinching out never shrinks the stage below the panel');
    A(clampZoom(99) === ZOOM_MAX, '32. and never past the ceiling');
    A(clampZoom(NaN) === 1, '33. an unmeasurable pinch settles at 1x');

    const W = 1080, H = 2220;
    const at1 = clampZoomPan(500, -900, 1, W, H);
    A(at1.x === 0 && at1.y === 0, '34. at 1x there is no slack — the pan is inert, not merely small');

    const at2 = clampZoomPan(9999, 9999, 2, W, H);
    A(at2.x === W / 2 && at2.y === H / 2, '35. at 2x it stops exactly where the picture still covers the panel');
    const neg = clampZoomPan(-9999, -9999, 2, W, H);
    A(neg.x === -W / 2 && neg.y === -H / 2, '36. and the same the other way');

    const inside = clampZoomPan(100, -200, 3, W, H);
    A(inside.x === 100 && inside.y === -200, '37. a legal pan is left where the finger put it');
    // Zooming back out has to pull an old pan in with it, or the picture is
    // stranded off-centre showing black down one side.
    const shrunk = clampZoomPan(W / 2, H / 2, 1.2, W, H);
    A(Math.abs(shrunk.x - W * 0.1) < 1e-9 && Math.abs(shrunk.y - H * 0.1) < 1e-9,
      '38. zooming back out drags the old pan back inside the new slack');
    A(clampZoomPan(NaN, NaN, 2, W, H).x === 0, '39. an unmeasurable pan centres rather than throwing');
  }

  // ── a dragged corner stays reachable ─────────────────────────────
  {
    const W = 412, H = 915, PW = 103, PH = 137, TOP = 44, BOT = 24;
    const at = (x: number, y: number) => clampPip(x, y, W, H, PW, PH, TOP, BOT);

    const mid = at(150, 400);
    A(mid.x === 150 && mid.y === 400, '14. a legal position is left exactly where the finger put it');

    const offRight = at(9999, 400);
    A(offRight.x === W - PW - PIP_MARGIN, '15. flung off the right edge, it comes back inside');
    const offLeft = at(-9999, 400);
    A(offLeft.x === PIP_MARGIN, '16. and off the left edge too');

    const offTop = at(150, -9999);
    A(offTop.y === TOP + PIP_MARGIN, '17. it never hides under the status bar — the SAFE area is the ceiling');
    const offBottom = at(150, 9999);
    A(offBottom.y === H - PH - BOT - PIP_MARGIN, '18. nor under the gesture pill');

    // THE ROTATION CASE. A position that was legal in landscape is off the
    // panel in portrait, and nothing re-drags it — so the clamp has to run on
    // render, and has to be right when it does.
    const landscape = clampPip(700, 300, 915, 412, PW, PH, TOP, BOT);
    const rotated = clampPip(landscape.x, landscape.y, W, H, PW, PH, TOP, BOT);
    A(rotated.x + PW <= W && rotated.y + PH <= H,
      '19. rotating the device pulls the corner back onto the new panel');

    const huge = clampPip(0, 0, 100, 100, 400, 400, TOP, BOT);
    A(huge.x === PIP_MARGIN && Number.isFinite(huge.y),
      '20. a preview bigger than the window still lands somewhere grabbable');
    const nan = at(NaN, NaN);
    A(Number.isFinite(nan.x) && Number.isFinite(nan.y), '21. an unmeasurable drag yields a legal position');

    // LANDSCAPE, which is where a shared game puts the viewer. The notch is now
    // on a SIDE, and the corner has to keep off it in x, not in y.
    const LW = 2220, LH = 1080, NOTCH = 88;
    const leftEdge = clampPip(-9999, 400, LW, LH, PW, PH, 0, 0, NOTCH, 0);
    A(leftEdge.x === NOTCH + PIP_MARGIN, '21b. in landscape it keeps clear of a left-hand notch');
    const rightEdge = clampPip(9999, 400, LW, LH, PW, PH, 0, 0, 0, NOTCH);
    A(rightEdge.x === LW - PW - NOTCH - PIP_MARGIN, '21c. and of a right-hand one');
  }

  console.log(failures === 0
    ? '\nALL STAGE-LAYOUT CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
