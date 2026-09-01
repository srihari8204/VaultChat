// immersiveStage.selftest.ts — the live screen must stay usable on a phone.
//
// WHY THIS READS SOURCE INSTEAD OF RENDERING
//
// The properties that matter here are not "does it render" — it did before, on
// the one handset it was measured against. They are:
//
//   * the exit is always reachable         (chrome that can hide the only way
//                                           off the screen strands a viewer,
//                                           and this screen is reached by
//                                           router.replace, so back exits the
//                                           app rather than going back)
//   * nothing carries a pixel offset       (top: 100 / bottom: 300 / bottom:
//                                           352 were measured against one
//                                           panel; on a short screen the poll
//                                           card, the invite sheet and the chat
//                                           drew on top of each other)
//   * a screen share is drawn as a screen  (cropped or mirrored, it is
//                                           unreadable — and it still looks
//                                           "live" to the person sharing it)
//
// Each is a one-token edit away from silently regressing and none of them
// throws when it does. STRUCTURAL: reads the file, renders nothing, opens no
// transport. DEVICE VERIFICATION IS SEPARATE.
//
// Kept out of stageLayout.ts because that module IS imported by the app, and
// Metro resolves require() statically — a `require('fs')` in there fails the
// bundle even on a branch that never runs. Nothing imports this file.
//
//   npx tsx lib/golive/immersiveStage.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'app', 'live-view.tsx'), 'utf8');

/** Strip comments, so prose about an offset cannot satisfy — or fail — a check. */
const code = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nGo Live immersive stage — app/live-view.tsx\n');

// ── ADAPTIVE, not measured ─────────────────────────────────────────
A(!/(top|bottom):\s*\d{2,}/.test(code),
  '1. no hand-measured pixel offsets survive — the chrome is laid out, not positioned');
A(/useSafeAreaInsets\(\)/.test(code) && /insets\.top/.test(code) && /insets\.bottom/.test(code),
  '2. the chrome is pinned to the real safe area, top AND bottom');
A(/useWindowDimensions\(\)/.test(code),
  '3. sizes are read from the live window, not assumed');
A(/pipSize\(win\.width, win\.height\)/.test(code),
  '4. the picture-in-picture is sized from the window by the tested helper');
A(/pickStage\(/.test(code),
  '5. which stream owns the stage comes from the tested helper, not inline ??');

// ── THE EXIT MUST STAY REACHABLE ───────────────────────────────────
//
// This is the one that turns a nice idea into a trap. A viewer arrives by
// deep link via router.replace, so there is no history and the hardware back
// button exits the app; if the chrome can hide while there is nothing else on
// screen, there is no way out at all.
A(/chromeShown\s*=\s*chrome\s*\|\|\s*!stageReady/.test(code),
  '6. chrome is FORCED visible whenever there is no stream — the exit cannot hide');
A(/lastTap/.test(code) && /320/.test(code) && /setChrome\(v => !v\)/.test(code),
  '7. a double tap toggles the chrome back on');
A(/leaveAsViewer/.test(code) && /confirmStop/.test(code),
  '8. both exits are still wired — viewer leave and host end');
A(/accessibilityLabel="Leave"/.test(code) && /accessibilityLabel="End broadcast"/.test(code),
  '9. and both are reachable to a screen reader, which cannot see an icon');
A(!/useNativeControls\b(?!=\{false\})/.test(code),
  '10. the HLS player no longer covers the screen with controls that swallow the tap');

// ── A HOST NEVER RENDERS THEIR OWN SCREEN CAPTURE ──────────────────
//
// Found on device 2026-08-20, and it is not a cosmetic bug: FLAG_SECURE excludes
// VaultChat's own window from MediaProjection, so a host's own capture is BLACK
// for exactly as long as they are looking at this screen. Promoting it to the
// stage replaced the host's camera with a black rectangle and read as "screen
// sharing is broken" while viewers were receiving the share perfectly.
//
// The fix must never be to lower FLAG_SECURE. It is to not render the thing
// that cannot be rendered.
A(/const screenStream = onStage \? null :/.test(code),
  '11. a host never promotes their own screen capture — FLAG_SECURE makes it black');
A(/localScreenURL/.test(code) === false,
  '12. and nothing on this screen reads a local screen-capture URL at all');
A(/media\.screen &&[\s\S]{0,400}?S\.sharingChip/.test(code),
  '13. the host is TOLD a share is running, since they cannot see it');

// ── a screen share drawn as a screen ───────────────────────────────
A(/objectFit=\{screenStream \? 'contain' : 'cover'\}/.test(code),
  '14. a screen share is contained, never cropped — cropping cuts off what it was shared to show');
A(/mirror=\{!screenStream\}/.test(code),
  '15. a screen share is never mirrored');
A(/zOrder=\{1\}/.test(code) && /zOrder=\{0\}/.test(code),
  '16. the corner preview is composited ABOVE the stage, not behind it');
// ── the corner belongs to the VIEWER ───────────────────────────────
//
// It floats over the share, and where it floats is a guess — the one thing
// worth sharing may be exactly under it. It used to be pointerEvents="none",
// which made that guess final. Three things have to hold now:
A(/\{\.\.\.pipPan\.panHandlers\}/.test(code),
  '17. the corner preview can be DRAGGED out of the way');
A(/clampPip\(/.test(code) && /left: pipAt\.x, top: pipAt\.y/.test(code),
  '18. and is clamped onto the safe area every render, so a rotation cannot strand it off-panel');
A(/pipStream && pipOn/.test(code) && /setPipOn\(v => !v\)/.test(code),
  '19. it can be hidden outright, and the control that hid it is still there to bring it back');
A(/Math\.abs\(g\.dx\) < 4 && Math\.abs\(g\.dy\) < 4\) d\.tap\(\)/.test(code),
  '20. a tap on the corner still reaches the stage — the chrome toggles wherever the thumb lands');

// ── it must not arrive TINY ────────────────────────────────────────
//
// HLS is composited onto a fixed landscape canvas, so a portrait publisher —
// every publisher this product has — arrives pillarboxed. Containing that on a
// portrait phone spends a quarter of the screen on a picture that is mostly
// black bars, which is what "the screen share looks tiny" actually was.
A(/pickFit\(stageFrame\?\.width, stageFrame\?\.height, win\.width, win\.height, stageIsScreen\)/.test(code),
  '21a. the fit is DECIDED from the real frame against the real panel, by the tested helper');
A(/const fill = fillPref \?\? \(autoFit !== null \? autoFit === 'cover' : !lowLatency\)/.test(code),
  '21b. with no frame size to read — HLS — it still fills, because that canvas is landscape by construction');
A(/setStageDims/.test(code) && /stageDims\[mainStream\]/.test(code)
  && /onReadyForDisplay=\{\(e: any\) =>/.test(code),
  '21c. the frame size is READ — off the publication on WebRTC, off the player on HLS — never guessed');
// A HOST WHO TURNS THEIR PHONE. The publication's dimensions are captured once,
// at subscribe; the renderer's keep coming. Measured on device 2026-08-25: a
// share went 600x1332 -> 960x540 mid-stream while the subscription never moved,
// and covering a landscape game against a stale portrait decision crops it to a
// sliver — worse than the letterbox this whole change removes.
A(/onDimensionsChange=\{\(e\) =>/.test(code),
  '21d. and it is re-read LIVE from the renderer, so a host who rotates mid-share is followed');
A(/resizeMode=\{fill \? ResizeMode\.COVER : ResizeMode\.CONTAIN\}/.test(code),
  '22. the HLS player honours it');
A(/objectFit=\{fill \? 'cover' : 'contain'\}/.test(code),
  '23. so does the low-latency renderer');
A(/setFillPref\(!fill\)/.test(code),
  '24. and the viewer can override either — a landscape publisher would be cropped by the default');

// ── pinch to zoom, on both renderers ───────────────────────────────
//
// "It fills the panel" and "I want to read that cell" are different questions.
// Auto-fit answers the first; this answers the second, and it has to reach the
// WebRTC surface and the HLS player alike or it works on private lives only.
A(/onTouchStart=\{stageTouchStart\}/.test(code) && /onTouchMove=\{stageTouchMove\}/.test(code),
  '24a. the stage layer takes raw touches, so a pinch is available at all');
A((code.match(/style=\{\[S\.video, zoomStyle\]\}/g) || []).length >= 2,
  '24b. the zoom transform wraps BOTH renderers — the share and the HLS player');
A(/clampZoom\(/.test(code) && /clampZoomPan\(/.test(code),
  '24c. and both the scale and the pan go through the tested clamps');
A(/if \(!touch\.current\.moved\) tapStage\(\)/.test(code),
  '24d. a pinch is not also a tap — the chrome does not toggle under a zoom');
A(/zoomAt\.current = \{ scale: 1, x: 0, y: 0 \}/.test(code),
  '24e. a new stream resets the zoom, so nobody inherits a magnified corner');

// ── PUBG: the panel has to turn ────────────────────────────────────
//
// Nothing about fit or fill rescues a landscape game on a portrait phone — a
// landscape picture does not go into a portrait hole. The app is portrait-locked
// in app.json AND the manifest, so this screen unlocks it and turns the phone
// for a landscape SHARE, then puts it back.
A(/expo-screen-orientation/.test(code) && /OrientationLock\.LANDSCAPE/.test(code),
  '24f. a landscape share turns the viewer’s phone');
// Leaving RESTORES rotation; it does not re-lock portrait. Re-locking was
// correct while the whole app was portrait-only — it put the app default back.
// With rotation unlocked app-wide it would leave every screen after a broadcast
// stuck in portrait until the app restarted, turning the stage into a global
// setting. The unlock is the restore now.
A(/\.then\(O => O\.unlockAsync\(\)\)/.test(code),
  '24g. and leaving restores rotation, whatever the stage was doing');
A(/const frame = stageIsScreen \? stageFrame : undefined/.test(code),
  '24h. only a SCREEN may turn the panel — a camera reports capture geometry and would spin it for a face');

// ── public gets what private gets ──────────────────────────────────
//
// An HLS viewer receives a fixed landscape composite, so the player’s own
// reading of it describes the CANVAS and not the publisher. The server is told
// the real geometry by LiveKit (migration 116) and its answer wins.
A(/b\?\.shareWidth && b\?\.shareHeight/.test(code) && /useMemo\(/.test(code),
  '24i. the server’s share geometry is read, and memoised — a fresh object per render would re-issue lockAsync forever');
A(/serverShare \?\? stageDims\[b\?\.hlsUrl \?\? ''\]/.test(code),
  '24j. and preferred over the player’s reading of the canvas');
A(/stage\.mainIsScreen \|\| \(!mainStream && !!serverShare\)/.test(code),
  '24k. so a public viewer knows a share is on the stage at all');

// ── chat goes to the RIGHT when the panel is wide ──────────────────
//
// A landscape stream is a game, and a chat strip across the bottom covers the
// part people are watching. Portrait keeps the bottom sheet: a third of a 393dp
// phone is 134dp, which is two words a line.
A(/const landscape = win\.width > win\.height/.test(code),
  '24l. orientation is read from the live window, not stored');
A(/landscape && \{[\s\S]{0,120}?alignSelf: 'flex-end'/.test(code),
  '24m. chat moves to the right-hand side in landscape');
A(/win\.height \* \(landscape \? 0\.5 : 0\.28\)/.test(code),
  '24n. and gets the height a column can use, instead of a strip’s share');

// ── chat folds away ────────────────────────────────────────────────
A(/const \[chatOpen, setChatOpen\]/.test(code) && /autoFocus/.test(code),
  '25. chat folds away and opens focused — the keyboard arrives with the tap');
A(/KeyboardAvoidingView/.test(code),
  '26. and the composer lifts clear of that keyboard instead of under it');
A(/unread/.test(code) && /badge/i.test(code),
  '27. a folded chat still says when someone spoke');
A(/pinned\s*=\s*chatOpen \|\| inviteOpen \|\| pollDraft !== null/.test(code),
  '28. the chrome does not retire out from under a half-typed message');

// ── nothing was quietly dropped ────────────────────────────────────
for (const kept of ['sendBroadcastChat', 'votePoll', 'createPoll', 'closePoll', 'makeInvite']) {
  A(SRC.includes(kept), `29. ${kept} survived the rework`);
}

console.log(failures === 0
  ? '\nALL IMMERSIVE-STAGE CHECKS PASSED ✓  (device verification separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
