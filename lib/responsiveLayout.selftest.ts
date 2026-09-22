/**
 * lib/responsiveLayout.selftest.ts
 *   run with: npx tsx lib/responsiveLayout.selftest.ts
 *
 * Two layout bugs in this app are invisible on the developer's device and
 * obvious on a user's. Both are cheap to assert and expensive to discover.
 *
 * 1. A FIXED height on a container that holds text. Raise the system font size
 *    — Android Settings > Display > Font size, or iOS Dynamic Type — and the
 *    text grows while the box does not, so descenders and second lines are cut
 *    off. The app has 3879 raw <Text> elements against 66 <AppText>, so a
 *    wrapper-level cap would protect ~2% of them; flexible containers are what
 *    actually protect the other 98%. `minHeight` gives the same visual result
 *    at default scale and simply grows when it has to.
 *
 * 2. A scroll container on a tab screen that does not reserve TAB_BAR_SPACE.
 *    The tab bar is `position: absolute` so content scrolls under its blur —
 *    that is the design — but it means the last row of any list is unreachable
 *    unless the list pads for it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'dist', 'android', 'ios'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

// ── 1. No fixed height on a text-bearing layout container ────────────
//
// 2026-09-17: the name filter here was a lie. It was a \b keyword list, and
// \b needs a NON-word character on the other side — but every style key in
// this app is camelCase with no separators, so `searchRow`, `addBtn`,
// `typeCell` and `navBtn` had no boundary in front of the keyword and never
// matched. The guard only ever fired on a key that was EXACTLY one of the
// words, which is why ~18 clipping containers sat green for months. The
// deeper problem is that a keyword list cannot see the ones that matter
// anyway: PhoneField's `code`, new-chat's `searchWrap` and six `cta` buttons
// are text boxes with no keyword in their names at all.
//
// So the name filter is gone. What is left is the structural filter this
// check already had — a style only counts if it lays children out — plus one
// addition: a square box (width === height) is an icon slot, not a text box.
// That is what separates the 40x40 `backBtn` holding one glyph from the 40dp
// search pill holding a 15sp input, and it drops the noise from 123 to 32
// without losing a single real offender.
const clipped: string[] = [];

// Documented exemptions. Same idea as the in-body `layout-exempt` note, for
// sites this agent does not own and must not edit. Each is a real fixed
// height on a text-bearing box; the debt is visible, not hidden.
// 2026-09-18: 22 of the original 32 are FIXED and their lines are gone from
// this map - the guard now holds those sites for real. What is left is two
// different things, and the distinction matters:
//
//   - waveform / preview / seek-bar boxes. These are MEDIA, not text: a
//     waveform does not font-scale, so a fixed height is correct. They want an
//     in-place layout-exempt note from their owner, not a repair.
//   - callBtn, zoomBtn, key. Verified icon slots and a keypad grid. A glyph
//     does not font-scale, and PinPad's callers centre it in a container that
//     does not scroll, so growing the keys pushes them off a short screen.
//
// app/lock-alert.tsx navBtn is the one genuine leftover: it wraps now
// (flexWrap added 2026-09-17) so it no longer clips horizontally, but its 68dp
// height is still pinned. Delete a line here when its site is fixed.
// Deliberately EMPTY, and kept so it stays that way (2026-09-18).
//
// A central allow-list is the wrong place for this: it sits in a file nobody
// opens while editing a screen, so an entry outlives the reason for it and a
// reader of the style has no idea an exemption exists. Every former entry now
// carries a `layout-exempt:` note beside the style it excuses — where the next
// person to touch that height will actually read it. Two of the ten were not
// exemptions at all and were fixed instead (chat-wallpaper previewBox,
// lock-alert navBtn).
//
// Add nothing here. Put the note in the style.
const EXEMPT = new Set<string>([]);

for (const file of [...walk('app'), ...walk('components')]) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(\w+)\s*:\s*\{([^{}]*)\}/g)) {
    const [, name, body] = m;
    // Opt out in place, with the reason beside it.
    if (body.includes('layout-exempt')) continue;
    if (EXEMPT.has(`${file} ${name}`)) continue;
    // Only containers that actually lay children out can clip text.
    if (!/flexDirection|alignItems|justifyContent|paddingHorizontal/.test(body)) continue;
    const h = body.match(/(?<!min)(?<!max)\bheight:\s*(\d+)/);
    if (!h || Number(h[1]) < 28) continue;
    // A square is an icon slot — the glyph does not scale with the font.
    const w = body.match(/(?<!min)(?<!max)\bwidth:\s*(\d+)/);
    if (w && w[1] === h[1]) continue;
    clipped.push(`${file}  ${name}: height ${h[1]}`);
  }
}
ok(
  clipped.length === 0
    ? 'no text-bearing container pins a fixed height'
    : 'fixed heights that will clip at large font sizes:\n      ' + clipped.join('\n      '),
  clipped.length === 0,
);

// ── 2. Tab screens reserve room for the floating bar ─────────────────
// The exemption below is derived from the navigator rather than hardcoded:
// re-show the bar on a screen and its padding requirement returns automatically,
// with no list here to remember to update. The inverse is checked too — a screen
// with no bar must NOT reserve room for one, or it carries ~80px of dead space.
//
// Comments are stripped before matching (2026-09-23). They were not, and a
// comment reading "NOT TAB_BAR_SPACE any more" satisfied this check on a file
// that had removed the padding entirely — prose standing in for code, the exact
// substitution lib/financeBtnLatch.selftest.ts strips comments to prevent.
const decomment = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const navSrc = decomment(fs.readFileSync(path.join(process.cwd(), 'app/(tabs)/_layout.tsx'), 'utf8'));
/** Screens whose Tabs.Screen sets tabBarStyle display:'none'. */
const barless = new Set<string>();
for (const m of navSrc.matchAll(/<Tabs\.Screen\s+name="([^"]+)"([\s\S]*?)\/>/g)) {
  if (/tabBarStyle:\s*\{\s*display:\s*'none'\s*\}/.test(m[2])) barless.add(m[1]);
}
ok('the navigator is still readable as the exemption source', navSrc.includes('<Tabs.Screen'));

const SCROLLER = /<(?:ScrollView|FlatList|SectionList|KeyboardAwareScrollView)\b/;
const missing: string[] = [];
const wasteful: string[] = [];
for (const file of walk('app/(tabs)')) {
  if (file.endsWith('_layout.tsx')) continue;
  const src = decomment(fs.readFileSync(file, 'utf8'));
  if (!SCROLLER.test(src)) continue;
  const screen = path.basename(file).replace(/\.tsx$/, '');
  // paddingBottom SPECIFICALLY, not merely the identifier anywhere in the file.
  // Mutation showed the looser test was vacuous: app/(tabs)/chats.tsx also uses
  // TAB_BAR_SPACE to position its FAB (`bottom:`), so deleting the LIST's
  // padding still left the string present and the check still passed.
  const reserves = /paddingBottom:\s*TAB_BAR_SPACE/.test(src);
  if (barless.has(screen)) { if (reserves) wasteful.push(file); }
  else if (!reserves) missing.push(file);
}
ok(
  missing.length === 0
    ? 'every tab screen that SHOWS the bar reserves TAB_BAR_SPACE'
    : 'tab screens whose content can hide under the floating bar:\n      ' + missing.join('\n      '),
  missing.length === 0,
);
ok(
  wasteful.length === 0
    ? 'no tab screen reserves room for a bar it hides'
    : 'tab screens padding for a bar that is not rendered:\n      ' + wasteful.join('\n      '),
  wasteful.length === 0,
);

// ── 3. Tab chrome grows for profile and OS text scaling ──────────────
const tabs = fs.readFileSync('app/(tabs)/_layout.tsx', 'utf8');
for (const [label, needle] of [
  ['tab labels', 'styles.tabLabel'],
  ['the Apps label', 'styles.centerLabel'],
] as [string, string][]) {
  const line = tabs.split('\n').find(l => l.includes(needle) && l.includes('AppText'));
  ok(`${label} keeps normal labels on one line and enlarged labels on two`, !!line &&
    /numberOfLines=\{normalLabels \? 1 : 2\}/.test(line) &&
    /maxFontSizeMultiplier=\{1\.2\}/.test(line));
}
ok('the tab bar grows with profile and OS text and icon scale', tabs.includes('visionTabBarGrowth(fontScale, metrics.textScale, metrics.lineScale, metrics.controlScale)'));
const badgeLine = tabs.split('\n').find(l => l.includes('styles.badgeTxt') && l.includes('AppText'));
ok('the unread count stays inside its badge', !!badgeLine && /numberOfLines=\{1\}/.test(badgeLine) && /maxFontSizeMultiplier=\{[\d.]+\}/.test(badgeLine));

// ── 4. The type scale stays inert on real phones ─────────────────────
// Guards the promise lib/typeScale.ts makes: adopting it moved no pixels on any
// device in use. If someone widens the range, every screen silently reflows.
const ts = fs.readFileSync('lib/typeScale.ts', 'utf8');
ok('typeScale still declares a narrow-phone floor', /NARROW_DP\s*=\s*360/.test(ts));
ok('typeScale keeps its scale clamps', /MIN_SCALE\s*=\s*0\.9\d/.test(ts) && /MAX_SCALE\s*=\s*1\.\d+/.test(ts));

// ── 5. A component that measures the window must FOLLOW the window ───
//
// app.json is orientation:"default" with supportsTablet, so a screen really can
// change size under a running component. Dimensions.get() returns the current
// size when it runs but subscribes to nothing, so a component that sizes itself
// from it keeps whatever it was built with until it remounts. Found this way:
// the shared bottom Sheet capped its list at 60% of the LAUNCH height (in
// landscape that is taller than the screen, and Cancel goes off the bottom),
// the status GateChallenge sized its puzzle board the same way, and
// call-recording froze its progress bar at a module-scope width.
//
// The rule: any file that reads Dimensions.get must also hold a live
// useWindowDimensions(). The established pattern here is a module read used
// ONLY for static constants paired with the hook for anything rendered — that
// combination passes, a lone Dimensions.get does not.
//
// Opt out in place with `layout-exempt:` and the reason, like the checks above.
const dimFiles: string[] = [];
for (const dir of ['app', 'components']) {
  for (const f of walk(dir)) {
    if (!f.endsWith('.tsx')) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('Dimensions.get(')) continue;
    if (src.includes('useWindowDimensions')) continue;
    if (/layout-exempt:/.test(src)) continue;
    dimFiles.push(f);
  }
}
ok(
  dimFiles.length === 0
    ? 'every file that measures the window also subscribes to it'
    : 'files frozen at their launch size (add useWindowDimensions, or a layout-exempt: note):\n      ' +
        dimFiles.join('\n      '),
  dimFiles.length === 0,
);

// ── 6. Bottom-pinned controls must clear the gesture bar ─────────────
//
// edgeToEdgeEnabled=true in android/gradle.properties applies at EVERY API
// level, so the app draws under the navigation area on every Android device,
// not only 15+. A control pinned with a literal `bottom:` therefore sits INSIDE
// the gesture strip: create-group's Create button was at bottom:0, the two
// finance FABs at bottom:20 under a 48dp inset.
//
// These are the sites repaired on 2026-09-17. Each must keep an inset in the
// pinned offset — via SCREEN_BOTTOM where the styles are built by a factory
// (live binding, refreshes with the theme), or via insets.bottom applied at the
// element where the StyleSheet is module-scope and would otherwise freeze at
// launch. This guards the repairs; the wider sweep of literal offsets is still
// open and is deliberately NOT asserted here.
const insetPinned: Array<[string, RegExp]> = [
  ['app/create-group.tsx', /paddingBottom:\s*16\s*\+\s*SCREEN_BOTTOM/],
  ['components/MessageActionSheet.tsx', /paddingBottom:\s*Math\.max\(34,\s*12\s*\+\s*SCREEN_BOTTOM\)/],
  ['components/VaultFeatureSheet.tsx', /paddingBottom:\s*SCREEN_BOTTOM/],
  ['components/GifPicker.tsx', /paddingBottom:\s*SCREEN_BOTTOM/],
  ['app/finance/ledger/index.tsx', /bottom:\s*insets\.bottom\s*\+\s*20/],
  ['app/finance/chitti/index.tsx', /bottom:\s*insets\.bottom\s*\+\s*20/],
  ['app/family-map.tsx', /BOT_0\s*=\s*10\s*\+\s*insets\.bottom/],
];
for (const [f, re] of insetPinned) {
  const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  ok(`${f} keeps its bottom inset on the pinned control`, re.test(src));
}

// -- The chat card slot has to stay WIRED, not just correct ----------
//
// layoutMetrics.selftest runs the arithmetic. What it cannot see is whether
// the stylesheet still calls it, and whether the memo recomputes when the
// window moves. useS() memoised on `narrow` alone, which is a 360dp
// breakpoint: without cardMax in the dependency list the cards would keep
// their launch size through every resize that did not cross 360.
const chatStyles = fs.readFileSync('components/chat/chatStyles.ts', 'utf8');
ok('chat cards are sized by chatCardMax, not a literal', /cardMax: chatCardMax\(width\)/.test(chatStyles));
ok('the chat style memo recomputes when the card slot moves', /m\.narrow, m\.cardMax,/.test(chatStyles));
for (const style of ['fileCard', 'filePreview', 'fileRow', 'pollWrap', 'audioRow']) {
  const line = chatStyles.split(String.fromCharCode(10)).find((l) => l.trimStart().startsWith(style + ':')) ?? '';
  ok(`${style} is capped by the bubble slot`, /Math\.min\(\d+, m\.cardMax\)/.test(line));
}

// -- A screen the navigator already insets must not inset itself ------
//
// app/_layout.tsx gives every name in INSET_SCREENS a contentStyle with
// paddingTop: HEADER_TOP and paddingBottom: SCREEN_BOTTOM. A screen in that
// list that also pads itself for the status bar pays twice: onboard-mpin
// (56) and onboard-success (88) each sat under a 52dp HEADER_TOP on the
// Honor, leaving 108dp and 140dp of blank space above their titles.
//
// The crisp half of the rule - never reference HEADER_TOP from a screen the
// container already pads - is what this asserts. A bare number cannot be
// judged from source (32 is a design gap, 56 was a status bar), so the two
// corrected values are pinned instead.
const layoutSrc = fs.readFileSync('app/_layout.tsx', 'utf8');
const listed = (layoutSrc.match(/const INSET_SCREENS = \[([^\]]*)\]/) ?? [, ''])[1]
  .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok('INSET_SCREENS was found and is not empty', listed.length > 10);

const doubled = listed.filter((name) => {
  const f = `app/${name}.tsx`;
  if (!fs.existsSync(f)) return false;
  // Strip line comments first: the note explaining this very fix names
  // HEADER_TOP, and a guard that trips on its own documentation is noise.
  const code = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10))
    .map((l) => l.split('//')[0]).join(String.fromCharCode(10));
  return code.includes('HEADER_TOP');
});
ok(
  doubled.length === 0
    ? 'no INSET_SCREENS screen adds HEADER_TOP on top of the container inset'
    : 'these are padded by the navigator AND by themselves: ' + doubled.join(', '),
  doubled.length === 0,
);
ok('onboard-mpin keeps the de-doubled gap',
   /paddingTop: 32,/.test(fs.readFileSync('app/onboard-mpin.tsx', 'utf8')));
ok('onboard-success keeps the de-doubled gap',
   /paddingTop: 64,/.test(fs.readFileSync('app/onboard-success.tsx', 'utf8')));

console.log(`responsiveLayout.selftest: ${n} assertions passed`);
