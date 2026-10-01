// lib/statusBarOwner.selftest.ts — run: npx tsx lib/statusBarOwner.selftest.ts
//
// ONE owner for the status bar, and a named exemption list for the screens that
// legitimately take it over.
//
// app/_layout.tsx renders a single theme-aware bar (dark glyphs in light mode,
// light in dark). A screen that mounts its own <StatusBar barStyle="light-content">
// overrides that while mounted, so in LIGHT mode the clock and battery turn white
// on a white background and vanish. That is the defect this guards.
//
// THE RULE IS CONDITIONAL, NOT ABSOLUTE, which is why this is an allowlist rather
// than a ban. Three kinds of screen are RIGHT to own the bar:
//
//   * always-dark surfaces — a call, the camera, a media or story viewer. Their
//     background is dark at every theme, so light glyphs are correct at every
//     theme too. constants/callTheme.ts exists for exactly this reason.
//   * immersive surfaces that HIDE the bar (<StatusBar hidden />) — a video
//     player, an active group call. Hiding is not a style override.
//   * a screen with its OWN independent palette — app/reader.tsx has
//     light/sepia/dark reading themes that do not follow the app theme, so it must
//     decide its own glyph colour. A sepia page needs dark glyphs even while the
//     app is in dark mode.
//
// What is NOT allowed is a screen that follows the APP palette and then also sets
// barStyle from it — that is a second copy of _layout's decision, and two copies
// are a place for them to disagree. app/vaultbeam-settings.tsx was exactly that
// (`barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}`, identical to
// _layout's own line) and was removed rather than exempted.
//
// openspec: global-device-support task 2.2.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

/**
 * Screens allowed to render their own <StatusBar>, each with the reason.
 *
 * Adding a line here is a decision, not a formality: it says this surface is dark
 * at every theme, or goes immersive, or owns an independent palette. If it merely
 * follows the app theme, delete its StatusBar instead of listing it.
 */
const ALLOWED: Record<string, string> = {
  'app/_layout.tsx':             'THE owner — the one theme-aware bar',
  'app/camera.tsx':              'immersive: hides the bar',
  'app/video-player.tsx':        'immersive: hides the bar',
  'app/group-call-active.tsx':   'immersive: hides the bar during a call',
  'app/voicecall.tsx':           'always-dark call UI (constants/callTheme.ts)',
  'app/videocall.tsx':           'always-dark call UI (constants/callTheme.ts)',
  'app/incoming-call.tsx':       'always-dark call UI (constants/callTheme.ts)',
  'app/lock.tsx':                'always-dark lock screen',
  'app/media-viewer.tsx':        'always-dark media viewer on #000',
  'app/story-viewer.tsx':        'always-dark story viewer',
  'app/file-viewer.tsx':         'always-dark document surface',
  'app/games.tsx':               'games hub paints its own dark felt surface',
  'app/reader.tsx':              'OWN palette: light/sepia/dark reading themes, independent of the app theme',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

console.log('\nstatus-bar ownership');

const screens = walk(join(ROOT, 'app'));
const offenders: string[] = [];
const renders: string[] = [];

for (const abs of screens) {
  const rel = relative(ROOT, abs).split('\\').join('/');
  // COMMENTS ARE STRIPPED FIRST, and that is not fussiness.
  //
  // Only a RENDERED element counts. The bare word appears in historical comments
  // ("Was: StatusBar.currentHeight …") across seven screens, and counting those is
  // how task 2.1 came to believe 42 screens were involved when 14 render one.
  //
  // Stripping also caught this guard's first false positive: the comment left where
  // vaultbeam-settings.tsx's StatusBar used to be quotes the element it removed, so
  // a naive match flagged the very file that had just been fixed. A guard that
  // reports the fix as the defect is worse than no guard.
  const src = readFileSync(abs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments, incl. JSX {/* … */}
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments, without eating https://
  if (!/<StatusBar[\s/>]/.test(src)) continue;
  renders.push(rel);
  if (!(rel in ALLOWED)) offenders.push(rel);
}

check('every screen rendering a <StatusBar> is a named, justified exemption',
  offenders.length === 0,
  offenders.length ? `unlisted: ${offenders.join(', ')} — justify it in ALLOWED or delete its StatusBar` : '');

// The allowlist must not rot: an entry for a screen that no longer renders one is
// a stale permission that would silently re-admit the defect if the file came back.
const stale = Object.keys(ALLOWED).filter((f) => !renders.includes(f));
check('no stale entries in the allowlist', stale.length === 0,
  stale.length ? `these no longer render a StatusBar: ${stale.join(', ')}` : '');

// A guard that cannot fail is decoration, so prove the matcher sees a real element
// and ignores a mention in prose.
check('the matcher fires on a rendered element', /<StatusBar[\s/>]/.test('  <StatusBar hidden />'));
check('the matcher ignores a comment mention',
  !/<StatusBar[\s/>]/.test('// Was: StatusBar.currentHeight on Android'));

console.log(`\n  ${renders.length} screens render a status bar, all accounted for`);
console.log(failures === 0 ? '\nALL PASSED ✓\n' : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
