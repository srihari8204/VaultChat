// lib/responsiveCoverage.selftest.ts — run: npx tsx lib/responsiveCoverage.selftest.ts
//
// THE RULE: a screen's layout must follow the window, not the window the app
// happened to launch into.
//
// app.json sets `orientation: "default"`, so the app rotates. A module-level
// `const { width } = Dimensions.get('window')` is evaluated ONCE at import and
// never again — so after a rotation, a fold, or a split-screen resize every
// size derived from it is stale. Screens sized their cards with it
// (`width: (SW - 48) / 2`) and kept the pre-rotation geometry.
//
// `useWindowDimensions()` re-renders on every metrics change. Where the value
// feeds a StyleSheet, the factory takes it as a parameter and the useMemo
// depends on it — the `makeStyles(c, width)` shape already used across this
// codebase.
//
// WHAT THIS DOES NOT CLAIM: that every hardcoded fontSize is responsive. Type
// scaling lives in lib/typeScale.ts and reaches text through AppText
// (components/ui/Text.tsx); adoption is incremental and most screens still
// carry fixed sizes. That is a separate, larger migration — this guard only
// pins the rotation-correctness property, which is cheap and absolute.

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['app', 'components'];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

console.log('\nResponsive layout — size follows the window, not the launch\n');

// 1. No module-level Dimensions.get. Inside a component it is still wrong, but
//    module scope is the one that CANNOT ever update, so that is what is pinned.
// Documented exceptions. Each is a decision the codebase already reasoned
// about in a comment at the site; the guard respects those rather than forcing
// a change that reintroduces a known bug.
const FROZEN_EXCEPTIONS: Record<string, string> = {
  'app/facescan.tsx':
    'buildGrid() runs at MODULE scope and reads MW/MH, so a hook there is an '
    + 'invalid-hook error — see the AUDIT F12 note at the site. The mesh is '
    + 'precomputed once at import by design.',
};
const frozen: string[] = [];
for (const abs of ROOTS.flatMap(r => walk(r))) {
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
  if (rel in FROZEN_EXCEPTIONS) continue;
  const src = fs.readFileSync(abs, 'utf8');
  // A top-level `const ... = Dimensions.get(...)` — no leading indentation.
  if (/^const\s[^\n]*Dimensions\.get\(/m.test(src)) {
    frozen.push(rel);
  }
}
check(
  'no module-level Dimensions.get() — it freezes at launch and never updates',
  frozen.length === 0,
  frozen.length
    ? `${frozen.join(', ')}\n      Use useWindowDimensions() in the component; if the value feeds a\n      StyleSheet, thread it in as makeStyles(c, width) with width in the deps.`
    : undefined,
);

// 2. The screens that were converted must keep the width in the memo deps, or
//    the styles are recomputed never and the fix silently reverts.
for (const rel of ['app/network-test.tsx', 'app/voice-effects.tsx', 'app/vaultid.tsx']) {
  if (!fs.existsSync(rel)) continue;
  const src = fs.readFileSync(rel, 'utf8');
  const threaded = /makeS(?:tyles)?\((?:c|colors),\s*(?:SW|width)\)/.test(src);
  const inDeps = /\[(?:c|colors),\s*(?:SW|width)\]/.test(src);
  const hook = /useWindowDimensions\(\)/.test(src);
  check(`${rel}: width threaded into the style factory`, threaded);
  check(`${rel}: ...and present in the memo deps`, inDeps);
  check(`${rel}: ...sourced from useWindowDimensions`, hook);
}

// 3. Fixed widths wider than the smallest phones in use (320dp) overflow them.
//    Known non-layout exceptions are listed rather than silently tolerated.
const WIDTH_EXCEPTIONS: Record<string, string> = {
  'app/chat-export.tsx': 'HTML export template width, not a screen layout',
  'app/docscanner.tsx': 'source image processing dimension, not a view',
  'components/spaces/SpaceGround.tsx':
    'decorative aura blobs inside absoluteFill with pointerEvents="none", '
    + 'positioned off-screen (top:-170, right:-120) — deliberately oversized '
    + 'glows, not layout that anything has to fit inside',
};
const wide: string[] = [];
for (const abs of ROOTS.flatMap(r => walk(r))) {
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
  if (rel in WIDTH_EXCEPTIONS) continue;
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/\bwidth:\s*(\d{3,})\b/g)) {
    if (Number(m[1]) > 320) wide.push(`${rel} (width: ${m[1]})`);
  }
}
check(
  'no fixed width over 320dp — the smallest phones still in use',
  wide.length === 0,
  wide.length ? wide.join(', ') : undefined,
);

// 4. The type scaler must keep covering the whole device range it claims to.
const ts = fs.readFileSync(path.join('lib', 'typeScale.ts'), 'utf8');
check('type scale still floors at a legible minimum', /MIN_SCALE = 0\.9\d/.test(ts));
check('type scale still caps growth so fixed-height rows cannot clip', /MAX_SCALE = 1\.\d+/.test(ts));
check('type scale still treats <360dp as narrow', /NARROW_DP = 360/.test(ts));
check('type scale still grows for tablets', /TABLET_MIN_DP/.test(ts));

console.log(failures ? `\n  ${failures} CHECK(S) FAILED\n` : '\n  all responsive-layout checks passed\n');
process.exit(failures ? 1 : 0);
