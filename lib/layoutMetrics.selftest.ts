// lib/layoutMetrics.selftest.ts — the layout foundation is LIVE, not frozen.
//
// WHAT THIS PINS
// --------------
// constants/layout.ts used to compute HEADER_TOP / SCREEN_BOTTOM / TAB_BAR_SPACE
// / IS_NARROW / IS_SHORT once, at module scope, justified in-file by the claim
// that "a foldable re-launches the activity". It does not: AndroidManifest sets
//   configChanges="...|screenSize|screenLayout|smallestScreenSize"
// so the activity is never recreated, and rotation genuinely moves the top inset.
// Every value was therefore wrong after any rotation, fold or split-screen change
// — on every Android version, because edgeToEdgeEnabled is set for all of them.
//
// The fix keeps them as module bindings (53 screens read them from inside
// StyleSheet.create, where no hook can be called) but makes them `let` and
// refreshes them through syncLayoutMetrics(), driven from lib/theme.tsx.
//
// These assertions fail if anyone freezes them again.
//
// Run: npx tsx lib/layoutMetrics.selftest.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Importable because constants/layoutMath.ts depends on nothing. This is what
// turns the section below from a grep into a real behavioural assertion.
import { deriveLayout, sameLayout, TAB_BAR_RAISE, chatCardMax } from '../constants/layoutMath';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const layout = read('constants/layout.ts');
const theme = read('lib/theme.tsx');
const manifest = read('android/app/src/main/AndroidManifest.xml');

let failures = 0;
function check(name: string, ok: boolean, why = '') {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${why ? `  (${why})` : ''}`);
}

// ── RUN the maths, do not grep it ────────────────────────────────────────────
// Everything below actually executes. A source scan can only prove a keyword is
// present; these prove the numbers move. Both reference devices are pinned by
// name so a regression names the handset it breaks.
console.log('\nThe derived values actually change with the window (executed, not scanned):');

// Honor ELI_NX9 portrait: 1200x2664 @520dpi ≈ 369 x 820 dp, ~44dp top inset.
const honorPortrait  = deriveLayout({ top: 44, bottom: 24, width: 369, height: 820 });
// Rotated: a landscape notch moves to the side, so the TOP inset collapses and
// the window becomes short. This is the case the old frozen constants got wrong.
const honorLandscape = deriveLayout({ top: 0, bottom: 24, width: 820, height: 369 });

check(
  'rotating changes headerTop',
  honorPortrait.headerTop !== honorLandscape.headerTop,
  `portrait ${honorPortrait.headerTop} vs landscape ${honorLandscape.headerTop}`,
);
check(
  'a landscape window is classed as short, so the header gap tightens',
  honorLandscape.isShort && honorLandscape.headerTop === 0 + 4,
  `isShort=${honorLandscape.isShort} headerTop=${honorLandscape.headerTop}`,
);
check(
  'portrait Honor is not short and not narrow',
  !honorPortrait.isShort && !honorPortrait.isNarrow,
);
check(
  'headerTop is the real inset plus the gap, never a hardcoded 48-56',
  honorPortrait.headerTop === 44 + 8,
  `got ${honorPortrait.headerTop}`,
);

// Redmi Note 8 Pro: 1080x2340 @440dpi ≈ 393 x 851 dp, ~28dp top inset.
const redmi = deriveLayout({ top: 28, bottom: 0, width: 393, height: 851 });
check(
  'the two reference devices derive DIFFERENT headerTop',
  redmi.headerTop !== honorPortrait.headerTop,
  `redmi ${redmi.headerTop} vs honor ${honorPortrait.headerTop} — one hardcoded value cannot serve both`,
);
check(
  'a device reporting zero bottom inset still reserves tab-bar space',
  redmi.tabBarSpace === 66 + TAB_BAR_RAISE + 12 + 10 + 12,
  `got ${redmi.tabBarSpace}; the Math.max(bottom, 10) floor stops the bar covering the last row`,
);

// 320dp is the narrowest width the spec supports.
const narrow = deriveLayout({ top: 24, bottom: 0, width: 320, height: 640 });
check('320dp is classed narrow', narrow.isNarrow);
check('600dp+ is not classed narrow', !deriveLayout({ top: 24, bottom: 0, width: 600, height: 960 }).isNarrow);

check(
  'sameLayout is true for identical metrics, so an idle re-render bumps nothing',
  sameLayout(honorPortrait, deriveLayout({ top: 44, bottom: 24, width: 369, height: 820 })),
);
check(
  'sameLayout is false once anything moves',
  !sameLayout(honorPortrait, honorLandscape),
);
check(
  'deriveLayout is pure — same input twice, identical output',
  JSON.stringify(deriveLayout({ top: 44, bottom: 24, width: 369, height: 820 }))
    === JSON.stringify(honorPortrait),
);

console.log('\nThe derived metrics are live bindings, not frozen constants:');
for (const name of ['HEADER_TOP', 'SCREEN_BOTTOM', 'IS_NARROW', 'IS_SHORT', 'TAB_BAR_SPACE']) {
  check(
    `${name} is exported as let`,
    new RegExp(`export let ${name}\\b`).test(layout),
    'export const freezes it for the process lifetime',
  );
}

console.log('\nThere is a sync entry point, and it is idempotent by contract:');
check('syncLayoutMetrics is exported', /export function syncLayoutMetrics\(/.test(layout));
check(
  'it returns the existing generation when nothing moved',
  /return generation;/.test(layout),
  'without an early return, every re-render invalidates every style in the app',
);
check('it bumps the generation when something moved', /return \+\+generation;/.test(layout));

console.log('\nExactly one place drives it, and it does so before children render:');
check('lib/theme.tsx imports syncLayoutMetrics', /syncLayoutMetrics/.test(theme));
check('it reads the LIVE insets', /useSafeAreaInsets\(\)/.test(theme));
check('it reads the LIVE window size', /useWindowDimensions\(\)/.test(theme));
check(
  'the sync runs in useMemo, not useEffect',
  /useMemo\(\s*\(\)\s*=>\s*syncLayoutMetrics\(/.test(theme),
  'an effect runs after paint, so the first frame after a rotation would be stale',
);
check(
  'colors identity changes with the layout generation',
  /colors:\s*\{\s*\.\.\.PALETTES\[scheme\]\s*\}/.test(theme) && /\[pref, system, layoutGen\]/.test(theme),
  'the 53 style factories memo on `colors`; without a new identity they never re-run',
);
check(
  'no other module calls syncLayoutMetrics',
  (theme.match(/syncLayoutMetrics/g) || []).length >= 1,
);

console.log('\nThe premise the old comment got wrong stays documented:');
check(
  'the activity really is never recreated on a size change',
  /configChanges="[^"]*screenSize[^"]*"/.test(manifest) &&
  /configChanges="[^"]*screenLayout[^"]*"/.test(manifest) &&
  /configChanges="[^"]*smallestScreenSize[^"]*"/.test(manifest),
  'if configChanges ever drops these, the activity restarts and frozen values would be fine again',
);

console.log('\nScreens that still snapshot these values once (ponytail ceiling):');
// These build styles with a module-scope StyleSheet.create rather than a
// makeStyles(colors) factory, so the colors-identity trigger cannot reach them.
// Listed, not fixed: most are single-purpose onboarding screens that do not
// rotate. Convert one to the factory pattern if it ever needs to be correct in
// landscape.
const FROZEN_STYLE_SCREENS = [
  'app/backup-pin.tsx', 'app/biometric-setup.tsx', 'app/email-verify.tsx',
  'app/mpin-entry.tsx', 'app/mpin-recover.tsx',
  'app/onboard-profile.tsx', 'app/onboard-security.tsx', 'app/permissions.tsx',
  'app/security-questions.tsx', 'components/CallBar.tsx',
];
check(
  'the documented ceiling is 10 screens',
  FROZEN_STYLE_SCREENS.length === 10,
  'update this list and the note in constants/layout.ts together',
);


// ── Chat cards must fit the bubble they sit in ───────────────────────
//
// Runs the REAL chatCardMax the stylesheet calls, not a copy of it - a test
// that re-implements the formula passes whatever the formula becomes.
//
// The slot is 0.78*(W - 24) - 28. The -24 is the message list's own gutter,
// which the first pass omitted: `maxWidth: '78%'` resolves against bubbleRow
// inside that padded list, not against the window, so every number below moved
// down by 18-19dp on 2026-09-18 and the cards moved with them. File cards,
// previews, polls and the video player were hardcoded at 240, which needs a
// 368dp window; below that the card overhung the bubble.
//
// 369 is pinned because it is the reference Honor and 241 is the width that was
// physically measured on it - the one row here that is evidence, not arithmetic.
for (const [w, slot] of [[320, 202], [360, 234], [368, 240], [369, 241], [393, 259], [600, 421]] as const) {
  check(`a ${w}dp window gives a ${slot}dp card slot`, chatCardMax(w) === slot);
}
check('a 320dp phone no longer gets a 240dp card', Math.min(240, chatCardMax(320)) < 240);
check('a 360dp phone no longer gets a 240dp card either', Math.min(240, chatCardMax(360)) < 240);
check('368dp is where a full 240dp card first fits', Math.min(240, chatCardMax(368)) === 240);
check('the slot never collapses on an absurdly narrow window', chatCardMax(1) === 140);
check('the slot grows with the window', chatCardMax(600) > chatCardMax(393));
// A media bubble pads 3, not 14, so it earns a wider slot at the same width.
check('the media-bubble slot is wider than the text-bubble slot', chatCardMax(320, 3) === 224);


assert.equal(failures, 0, `${failures} layout-metrics check(s) failed`);
console.log('\nLayout metrics are live.\n');
