// lib/orphanRoutes.selftest.ts — run: npx tsx lib/orphanRoutes.selftest.ts
//
// AN UNROUTED SCREEN IS STILL A ROUTABLE URL.
//
// expo-router turns every file in app/ into a route whether or not anything in
// the app links to it. A screen nobody can reach through the UI is therefore
// not inert — it is reachable by deep link, and it rots, because no one
// exercises it. app/lock.tsx proved the point: unrouted for months, it still
// carried "if no PIN and no secret code are set, let any code in".
//
// The audit of 2026-09-17 found ten. The three that were genuinely useful are
// routed from Settings rather than deleted; the rest are duplicates of live
// screens, listed here so the distinction is written down rather than
// rediscovered.
//
// 2026-09-17, second pass. This guard was proved unfalsifiable by mutation and
// had to be rebuilt, because three separate things it did were not checks:
//
//   • It matched navigation as ONE byte sequence — no spaces, double quotes,
//     router.push only. Reintroducing the bug in this file's own prevailing
//     style (single quotes, `=> `, or router.replace, or <Link href>) left it
//     green. Everything below goes through refsTo(), which finds the route as a
//     STRING LITERAL wherever it appears, so quoting, spacing and the choice of
//     push/replace/navigate/Link are all irrelevant.
//   • It asserted the six duplicates STILL EXIST. That is backwards: deleting
//     dead code made it fail, and nothing checked the property that actually
//     matters — that nothing navigates to them. Inverted below.
//   • It asserted that COMMENTS were present ('FIRST-TIME ACCESS REMOVED') or
//     absent ('let them in'). A comment is documentation; it constrains no
//     behaviour and both are gone. Comments are now stripped before every scan
//     so prose can neither satisfy nor trip an assertion.
//
// It still does not re-derive reachability from the navigator — that needs a
// nav-aware scan, and a wrong answer there would either nag forever or give
// false comfort. It derives it from "does the route name appear as a literal
// anywhere in app/, components/ or lib/", which errs towards nagging.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

/** Source with /* *\/ and // comments removed. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (p: string) => strip(fs.readFileSync(p, 'utf8'));

/** Every file that could hold a navigation, minus the selftests — those name
 *  the routes they guard and would otherwise count as callers of them. */
const SOURCES: { file: string; src: string }[] = [];
function walk(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.[jt]sx?$/.test(e.name) && !e.name.includes('.selftest.')) {
      SOURCES.push({ file: p.replace(/\\/g, '/'), src: code(p) });
    }
  }
}
['app', 'components', 'lib'].forEach(walk);
ok('the scan reaches beyond app/ top level', SOURCES.some((s) => s.file.startsWith('app/(tabs)/'))
  && SOURCES.some((s) => s.file.startsWith('components/')) && SOURCES.length > 300);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Files mentioning `route` as a path literal. Deliberately method-blind: it
 *  catches router.push/replace/navigate, push({ pathname }), <Link href> and
 *  `'/x' as any` alike, because all of them spell the route inside quotes. */
const refsTo = (route: string) => {
  const re = new RegExp(`['"\`]${esc(route)}(?=['"\`?#/])`);
  return SOURCES.filter((s) => re.test(s.src)).map((s) => s.file);
};
/** Everything from the first `{` at/after `from` through its matching `}`. */
const blockAt = (src: string, from: number) => {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced braces from index ' + from);
};

// ── Routed, not deleted ───────────────────────────────────────────────
const settings = code('app/settings.tsx');
ok('App permissions is reachable from Settings', /['"`]\/permissions\?from=settings/.test(settings));
ok('Network test is reachable from Settings', refsTo('/network-test').includes('app/settings.tsx'));
// Its only entry used to live in a screen that was itself unreachable.
ok('Export chat is reachable from the chat menu', refsTo('/chat-export').includes('app/chat.tsx'));
ok('Device-to-device status is reachable from Settings', refsTo('/d2de-status').includes('app/settings.tsx'));

// permissions.tsx must come BACK to Settings, not fall into the old
// onboarding's success screen, which is what all three of its exits did.
const perms = code('app/permissions.tsx');
ok('permissions reads where it was opened from', /from\s*===\s*['"`]settings['"`]/.test(perms));
const doneAt = perms.indexOf('const done');
ok('permissions has one exit helper', doneAt !== -1);
const done = blockAt(perms, doneAt);
ok('permissions returns to Settings instead of onboarding',
   /fromSettings/.test(done) && /router\s*\.\s*back\s*\(\s*\)/.test(done));

// ── Deleted, and nothing may navigate to them ─────────────────────────
// 2026-10-04 screen audit: mock screens that claimed things the app never did
// (a 2-second setTimeout "sent with D2DE", a seeded demo queue, a fake scan),
// the legacy onboarding chain, and unwired duplicates of live screens
// (/location, /chat-code, the GifPicker stickers tab). An unrouted file is
// still a deep-linkable URL (see the top of this file), so they were deleted
// rather than left to rot. A literal pointing at one of them is now a dead end
// — expo-router's "Unmatched route" screen — so any caller fails this check.
const DELETED = [
  '/scanner', '/email-bridge', '/vaultdrop', '/contact', '/lock',
  '/security-questions', '/biometric-setup', '/setup-complete', '/call-recording',
  '/voice-effects', '/meeting-scheduler', '/stickers', '/voice-speed',
  '/voice-transcribe', '/slideshow', '/current-location', '/location-sharing',
  '/sync-contact', '/msgrequests',
];
for (const route of DELETED) {
  ok(`app${route}.tsx is deleted`, !fs.existsSync(`app${route}.tsx`));
  const stray = refsTo(route);
  ok(`nothing navigates to deleted ${route}` + (stray.length ? ` — found: ${stray.join(', ')}` : ''),
     stray.length === 0);
}
// The components that only ever linked to those screens went with them.
for (const f of ['components/VaultFeatureSheet.tsx', 'components/ui/ChatRow.tsx']) {
  ok(`${f} is deleted`, !fs.existsSync(f));
}
ok('nothing imports the deleted components',
   !SOURCES.some((s) => /import[^;]*\b(VaultFeatureSheet|ChatRow)\b[^;]*from\s+['"][^'"]*(VaultFeatureSheet|components\/ui|ChatRow)['"]/.test(s.src)));

// ── The duplicates, written down ──────────────────────────────────────
// Each is a second implementation of something the live app already does. The
// property worth guarding is NOT that the files survive — deleting dead code is
// an improvement — it is that nothing navigates to them, because routing them
// would give the user two ways to set the same thing, which is how the two PIN
// systems in this repo came about. Each route names the callers it is
// ALLOWED, and a caller appearing anywhere else fails. (The legacy onboarding
// screens that used to be listed here are deleted — see DELETED above.)
const REACHABLE_FROM: Record<string, string[]> = {
  // Genuinely unrouted. The live group path is /chat plus /group-info.
  '/group-chat': [],
  // A redirect shim kept only for old deep links; nothing in-app may route to it.
  '/creator-channels': [],
};
for (const [route, allowed] of Object.entries(REACHABLE_FROM)) {
  const found = refsTo(route).sort();
  ok(`${route} is reached only from ${allowed.length ? allowed.join(', ') : 'nowhere'}` +
     (found.join() === allowed.slice().sort().join() ? '' : ` — found: ${found.join(', ') || 'nothing'}`),
     found.join() === allowed.slice().sort().join());
}

console.log(`\norphanRoutes.selftest: ${n} assertions passed`);
