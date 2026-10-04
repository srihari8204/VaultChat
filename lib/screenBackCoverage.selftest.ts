// lib/screenBackCoverage.selftest.ts — run: npx tsx lib/screenBackCoverage.selftest.ts
//
// REPORTED FROM A DEVICE: "broadcast channels lo back click chesthe ravatla
// ledhu" — pressing back on a broadcast/channel screen did nothing.
//
// THE ROOT CAUSE, and it was systemic rather than one screen:
//
//   app/_layout.tsx sets `screenOptions={{ headerShown: false }}` for the whole
//   Stack. A screen that renders `<Stack.Screen options={{ title: 'X' }} />` and
//   nothing else is therefore left with NO header, NO back chevron and no other
//   way off itself — the options it declared are silently inert. The author
//   wrote a title expecting a header; the navigator never drew one.
//
//   The same defect had already been found twice under other names: every games
//   screen (fixed with GameChrome/GameTopBar), and app/live.tsx. lib/spaces
//   hit it too and solved it locally — spaceHeader() sets headerShown:true and
//   its comment says exactly why. Finance solved it with FinHeader's own back
//   button. Fourteen screens were still broken.
//
// This test walks app/ and fails if any screen has no way out. It is deliberately
// generous about WHAT counts as an exit — a native header, a shared header
// component, an explicit back call, a modal close, a redirect — because the
// requirement is "the user is not trapped", not "use one specific component".

import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(process.cwd(), 'app');

/** Anything here means the user can leave the screen. */
const EXIT_PATTERNS: RegExp[] = [
  /<(?:Header|FinHeader|GameTopBar)\b/, // actual navigation components, not ListHeaderComponent
  /router\.back\(\)/,
  /arrow-back/, /chevron-back/,
  /BackHandler/,
  /GameChrome/,
  /navigation\.goBack/,
  /onClose/, /onDismiss/,
  /router\.replace\(/, /router\.dismiss/, /resetTo\(/,
  /spaceHeader/,
  /headerShown:\s*true/,       // a native header draws its own back button
  /<Redirect/,                 // a redirect stub never renders
];

/** Screens that are legitimately dead ends — each needs a stated reason. */
const ALLOWED: Record<string, string> = {
  'app/onboard.tsx':
    'the sign-up ROOT — there is nothing behind it, and Back must exit the app',
  'app/permissions.tsx':
    'orphaned legacy onboarding chain (nothing pushes to it); delete rather than decorate',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

let failures = 0;
const trapped: string[] = [];
let scanned = 0;

for (const abs of walk(APP)) {
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
  const base = path.basename(abs, '.tsx');
  if (base === '_layout' || base === '+not-found') continue;
  if (rel.includes('(tabs)')) continue;          // tab roots have bottom nav
  scanned++;
  if (rel in ALLOWED) continue;
  const src = fs.readFileSync(abs, 'utf8');
  if (!EXIT_PATTERNS.some(re => re.test(src))) trapped.push(rel);
}

console.log('\nEvery screen must have a way out\n');
console.log(`  scanned: ${scanned} screens (tab roots and layouts excluded)`);
console.log(`  documented dead ends: ${Object.keys(ALLOWED).length}`);

if (trapped.length) {
  failures++;
  console.log(`\n  ✗ ${trapped.length} screen(s) with NO exit affordance:`);
  for (const t of trapped) console.log(`      ${t}`);
  console.log('\n  Add one of: headerShown:true in the screen\'s Stack.Screen options,');
  console.log('  a shared Header/FinHeader/GameChrome, or an explicit router.back().');
  console.log('  If it is genuinely a dead end, add it to ALLOWED with a reason.');
} else {
  console.log('  ✓ no screen traps the user');
}

// The root cause itself: if this ever flips to true app-wide, every screen gets
// a header and the per-screen opt-ins become double headers. Pin the default.
const LAYOUT = fs.readFileSync(path.join(APP, '_layout.tsx'), 'utf8');
const rootHidesHeader = /screenOptions=\{\{\s*headerShown:\s*false/.test(LAYOUT);
console.log(rootHidesHeader
  ? '  ✓ root Stack still hides headers by default (screens opt in individually)'
  : '  ✗ root Stack no longer hides headers — screens that opt in now double up');
if (!rootHidesHeader) failures++;

// A screen that opts into a native header must NOT also be in INSET_SCREENS:
// the header already owns the status-bar inset, so both together pad twice.
const insetBlock = LAYOUT.slice(LAYOUT.indexOf('const INSET_SCREENS'), LAYOUT.indexOf('] as const'));
const doubled: string[] = [];
for (const abs of walk(APP)) {
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
  const base = path.basename(abs, '.tsx');
  if (!/headerShown:\s*true/.test(fs.readFileSync(abs, 'utf8'))) continue;
  if (new RegExp(`'${base}',`).test(insetBlock)) doubled.push(base);
}
console.log(doubled.length
  ? `  ✗ double-inset: ${doubled.join(', ')} have a native header AND sit in INSET_SCREENS`
  : '  ✓ no screen is both natively headered and in INSET_SCREENS');
if (doubled.length) failures++;

console.log(failures ? `\n  ${failures} CHECK(S) FAILED\n` : '\n  all screen-exit checks passed\n');
process.exit(failures ? 1 : 0);
