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
A(/pointerEvents="none"/.test(code),
  '17. the corner preview does not eat the double tap it floats over');

// ── chat folds away ────────────────────────────────────────────────
A(/const \[chatOpen, setChatOpen\]/.test(code) && /autoFocus/.test(code),
  '18. chat folds away and opens focused — the keyboard arrives with the tap');
A(/KeyboardAvoidingView/.test(code),
  '19. and the composer lifts clear of that keyboard instead of under it');
A(/unread/.test(code) && /badge/i.test(code),
  '20. a folded chat still says when someone spoke');
A(/pinned\s*=\s*chatOpen \|\| inviteOpen \|\| pollDraft !== null/.test(code),
  '21. the chrome does not retire out from under a half-typed message');

// ── nothing was quietly dropped ────────────────────────────────────
for (const kept of ['sendBroadcastChat', 'votePoll', 'createPoll', 'closePoll', 'makeInvite']) {
  A(SRC.includes(kept), `19. ${kept} survived the rework`);
}

console.log(failures === 0
  ? '\nALL IMMERSIVE-STAGE CHECKS PASSED ✓  (device verification separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
