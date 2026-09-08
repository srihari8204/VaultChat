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
// Plurals count. camera.tsx's `tabs: { flexDirection:'row', width:260, height:32 }`
// holds two text labels and sailed through this check, because \btab\b does not
// match "tabs" — the trailing s is a word character, so there is no boundary.
const ROWISH = /\b(row|item|cell|header|bar|chip|btn|button|tab|card|entry|entries|field|input|option|pill|tile)s?\b/i;
const clipped: string[] = [];

for (const file of [...walk('app'), ...walk('components')]) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(\w+)\s*:\s*\{([^{}]*)\}/g)) {
    const [, name, body] = m;
    if (!ROWISH.test(name)) continue;
    // Opt out in place, with the reason beside it.
    if (body.includes('layout-exempt')) continue;
    // Only containers that actually lay children out can clip text.
    if (!/flexDirection|alignItems|justifyContent|paddingHorizontal/.test(body)) continue;
    const h = body.match(/(?<!min)(?<!max)\bheight:\s*(\d+)/);
    if (h && Number(h[1]) >= 28) clipped.push(`${file}  ${name}: height ${h[1]}`);
  }
}
ok(
  clipped.length === 0
    ? 'no text-bearing container pins a fixed height'
    : 'fixed heights that will clip at large font sizes:\n      ' + clipped.join('\n      '),
  clipped.length === 0,
);

// ── 2. Tab screens reserve room for the floating bar ─────────────────
const SCROLLER = /<(?:ScrollView|FlatList|SectionList|KeyboardAwareScrollView)\b/;
const missing: string[] = [];
for (const file of walk('app/(tabs)')) {
  if (file.endsWith('_layout.tsx')) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (!SCROLLER.test(src)) continue;
  if (!src.includes('TAB_BAR_SPACE')) missing.push(file);
}
ok(
  missing.length === 0
    ? 'every tab screen with a scroll container reserves TAB_BAR_SPACE'
    : 'tab screens whose content can hide under the floating bar:\n      ' + missing.join('\n      '),
  missing.length === 0,
);

// ── 3. Fixed-height chrome caps its own text ─────────────────────────
// The tab bar cannot grow — it is a 66pt pill — so unlike the rest of the app
// its labels must be bounded, or a large-text user loses them entirely.
const tabs = fs.readFileSync('app/(tabs)/_layout.tsx', 'utf8');
for (const [label, needle] of [
  ['tab labels', 'styles.tabLabel'],
  ['the Apps label', 'styles.centerLabel'],
  ['the unread badge', 'styles.badgeTxt'],
] as [string, string][]) {
  const line = tabs.split('\n').find(l => l.includes(needle) && l.includes('AppText'));
  ok(`${label} cap font scaling`, !!line && /maxFontSizeMultiplier=\{[\d.]+\}/.test(line));
  ok(`${label} stay on one line`, !!line && /numberOfLines=\{1\}/.test(line));
}

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

console.log(`responsiveLayout.selftest: ${n} assertions passed`);
