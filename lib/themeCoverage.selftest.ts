/**
 * lib/themeCoverage.selftest.ts
 *   run with: npx tsx lib/themeCoverage.selftest.ts
 *
 * Theme coverage rots silently. Nothing crashes when a screen hardcodes
 * `backgroundColor: '#111D32'` — it just renders a dark slab in light mode, on
 * one screen, that nobody opens until a user does. The whole app was swept onto
 * palette tokens; this is what stops the next hardcoded neutral from drifting
 * back in unnoticed.
 *
 * The rule: a NEUTRAL colour (grey/near-grey, i.e. the role of a surface, a
 * border, or body text) must come from the palette. Saturated colours are
 * exempt — a red danger pill and a green presence dot are semantic, identical
 * in both themes, and correctly hardcoded.
 *
 * EXEMPT below are surfaces that deliberately own their look. Each one is a
 * decision, not an oversight, and the reason is written next to it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const EXEMPT = new Set([
  // Call UI is always-dark by product decision (constants/callTheme.ts).
  'app/voicecall.tsx', 'app/videocall.tsx', 'app/incoming-call.tsx',
  'app/group-call-active.tsx',
  'components/call/CallChatSheet.tsx', 'components/call/CallExtras.tsx',
  // Content surfaces: anything but neutral behind the media is wrong.
  'app/media-viewer.tsx', 'app/file-preview.tsx', 'app/image-editor.tsx',
  'app/docscanner.tsx', 'app/reader.tsx',
  'app/story-viewer.tsx', 'app/whiteboard.tsx', 'app/live-view.tsx',
  // Camera viewfinders.
  'app/camera.tsx',
  // Renders after the tree threw — must not read context. See the file.
  'components/ErrorBoundary.tsx',
  // Their own published design systems.
  'components/finance/ui.tsx',
  'components/games/Rummy.tsx', 'components/games/Chess.tsx', 'components/games/Ludo.tsx',
]);
const EXEMPT_PREFIX = ['app/finance/', 'app/spaces/', 'lib/games/', 'lib/groups/'];

const rgb = (h: string): [number, number, number] => {
  let x = h.replace('#', '');
  if (x.length === 3) x = x.split('').map(c => c + c).join('');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
};
/** Neutral = low chroma. These carry SURFACE/TEXT roles and must be tokens. */
const isNeutral = (h: string) => {
  const [r, g, b] = rgb(h);
  return Math.max(r, g, b) - Math.min(r, g, b) < 42;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.expo', 'dist', 'android', 'ios'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const ROLE = /(backgroundColor|color|border[A-Za-z]*Color)\s*:\s*'(#[0-9A-Fa-f]{3,6})'/g;

/**
 * Pure white and pure black as a TEXT colour are not theme bugs — they are the
 * deliberate contrast choice on an accent fill (white on the violet FAB stays
 * white in both themes). A surface or a border, though, always has to theme,
 * and so does any MID-grey text, which is body copy in disguise.
 */
const exemptRole = (prop: string, hex: string) => {
  if (!prop.startsWith('color')) return false;
  const [r, g, b] = rgb(hex);
  const l = (r + g + b) / 3;
  return l > 235 || l < 20;
};
const offenders: { file: string; hex: string; line: number }[] = [];

for (const file of [...walk('app'), ...walk('components')]) {
  if (EXEMPT.has(file) || EXEMPT_PREFIX.some(p => file.startsWith(p))) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // Skip data tables of swatch values — those are content, not styling.
    if (/\b(?:id|name|key|icon|label|gradient|palette|swatch)\s*:/.test(line)) return;
    // A literal may opt out in place, with its reason beside it — better than a
    // central list nobody reads when they edit the line.
    if (line.includes('theme-exempt')) return;
    for (const m of line.matchAll(ROLE)) {
      const [, prop, hex] = m;
      if (isNeutral(hex) && !exemptRole(prop, hex)) offenders.push({ file, hex, line: i + 1 });
    }
  });
}

ok(
  offenders.length === 0
    ? 'every non-exempt screen and component takes its neutrals from the palette'
    : `hardcoded neutral colours found:\n` +
      offenders.map(o => `      ${o.file}:${o.line}  ${o.hex}`).join('\n'),
  offenders.length === 0,
);

// The exemption list is only trustworthy if it stays honest — a stale entry
// silently un-covers a file that was since deleted or renamed.
for (const f of EXEMPT) {
  ok(`exempt file still exists: ${f}`, fs.existsSync(f));
}

// -- A theme-following screen must not force the status bar --------
//
// app/_layout.tsx renders ONE theme-aware bar: dark glyphs in light mode,
// light in dark. A screen that mounts its own <StatusBar barStyle="light-
// content"/> overrides it while mounted, so in LIGHT mode the clock and
// battery turned white on a white background - invisible. 18 screens did
// this; app/email-bridge.tsx paired it with backgroundColor="#FFFFFF",
// which is white-on-white stated outright.
//
// The rule is conditional, not absolute: a screen whose surface is dark at
// EVERY theme - a call, the camera, a media or story viewer - is right to
// force light-content. Those do not call useTheme, which is what separates
// them here. A screen that reads the palette must let the root bar decide.
const forcing: string[] = [];
for (const dir of ['app', 'components']) {
  for (const f of walk(dir)) {
    if (!f.endsWith('.tsx')) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('barStyle')) continue;
    if (!src.includes('useTheme')) continue;          // dark-always surface
    if (/barStyle={/.test(src)) continue;             // already conditional
    if (src.includes('statusbar-exempt:')) continue;
    forcing.push(f);
  }
}
ok(
  forcing.length === 0
    ? 'no theme-following screen hardcodes the status bar style'
    : 'these read the palette but force a fixed status bar style: ' + forcing.join(', '),
  forcing.length === 0,
);

console.log(`themeCoverage.selftest: ${n} assertions passed, ${EXEMPT.size} documented exemptions`);
