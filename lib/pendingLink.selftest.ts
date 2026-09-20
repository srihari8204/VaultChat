// lib/pendingLink.selftest.ts — a deep link must survive the auth gate, and
// must NOT survive a sign-out.
//
// Measured on an Honor ELI-NX9: vaultchat://emergency-sos never opened the SOS
// screen, cold or warm. The cause was not that route — app/_layout.tsx's launch
// gate router.replace()s to /onboard or /app-lock on every cold launch that is
// not already signed in and unlocked, and nothing held the URL the app was
// launched with. EVERY deep link into a signed-out or locked app was discarded
// the same way.
//
// The two properties worth pinning are opposites, which is why both are here:
// the link must survive the redirect, and it must be GONE on the way out.

import {
  clearLaunchLink,
  consumeLaunchLink,
  pathFromLaunchUrl,
  stashLaunchLink,
} from './pendingLink';

let failures = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : `  (${detail})`}`);
}

console.log('pendingLink — a deep link across the auth gate\n');

// ── the parse ────────────────────────────────────────────────────────────
console.log('What counts as a destination:');
ok('scheme URL -> path', pathFromLaunchUrl('vaultchat://emergency-sos') === '/emergency-sos',
  String(pathFromLaunchUrl('vaultchat://emergency-sos')));
ok('the second registered scheme works too (app.json declares both)',
  pathFromLaunchUrl('crazzychat://settings') === '/settings',
  String(pathFromLaunchUrl('crazzychat://settings')));
ok('https deep link -> same path, so a browser link behaves identically',
  pathFromLaunchUrl('https://api.corefinite.com/live/join') === '/live/join',
  String(pathFromLaunchUrl('https://api.corefinite.com/live/join')));
ok('query string is kept — a chat link carries its id there',
  pathFromLaunchUrl('vaultchat://chat?id=abc') === '/chat?id=abc',
  String(pathFromLaunchUrl('vaultchat://chat?id=abc')));

// The launcher icon's own URL on some Android skins. Replaying it would
// navigate to "/" and fight the gate that just redirected away from there.
ok('bare scheme is NOT a destination', pathFromLaunchUrl('vaultchat://') === null);
ok('bare scheme with slash is NOT a destination', pathFromLaunchUrl('vaultchat:///') === null);
ok('null/undefined are safe', pathFromLaunchUrl(null) === null && pathFromLaunchUrl(undefined) === null);
ok('a foreign scheme is refused', pathFromLaunchUrl('mailto:someone@example.test') === null,
  String(pathFromLaunchUrl('mailto:someone@example.test')));

// The normal case: _layout hands us usePathname(), already resolved by
// expo-router. Deliberately NOT expo-linking's initial-URL read -- two guards
// forbid that call in the root layout because the splash must gate on
// launchReady alone (startupColdPath.selftest.ts:40,
// games/gamesNative.selftest.ts:520), and they match on raw file text.
ok('a plain path passes through', pathFromLaunchUrl('/emergency-sos') === '/emergency-sos');
ok('a path with a query keeps it', pathFromLaunchUrl('/chat?id=abc') === '/chat?id=abc');
ok('"/" is not a destination — that is where the gate is sending them anyway',
  pathFromLaunchUrl('/') === null);

// ── stash / consume ──────────────────────────────────────────────────────
console.log('\nSurviving the redirect:');
clearLaunchLink();
stashLaunchLink('vaultchat://emergency-sos');
ok('the link is held while the gate redirects', consumeLaunchLink() === '/emergency-sos');

// CONSUMES. Without this a replay could loop, or a link could fire on a later
// crossing the user never asked for.
ok('and is gone after one read', consumeLaunchLink() === null);

clearLaunchLink();
stashLaunchLink('vaultchat://');
ok('a launcher URL stashes nothing', consumeLaunchLink() === null);

clearLaunchLink();
stashLaunchLink('vaultchat://chats');
stashLaunchLink('vaultchat://settings');
ok('a second link wins — it is the one the user just tapped',
  consumeLaunchLink() === '/settings');

console.log('\nNOT surviving a sign-out:');
clearLaunchLink();
stashLaunchLink('vaultchat://emergency-sos');
clearLaunchLink();
ok('clear() drops it unread, so it cannot open under the next account',
  consumeLaunchLink() === null);

// ── the wiring, pinned from source ───────────────────────────────────────
// The behaviour above is worthless if resetTo stops calling it, so the call
// sites are pinned too. Reading the file rather than importing it: authNav
// imports expo-router, which needs a native runtime this test does not have.
console.log('\nThe wiring in lib/authNav.ts:');
const fs = require('node:fs') as typeof import('node:fs');
const nav = fs.readFileSync(require('node:path').join(__dirname, 'authNav.ts'), 'utf8');
ok('resetTo replays only when entering the tab stack',
  /href\.startsWith\('\/\(tabs\)'\)/.test(nav));
ok('…and consumes the link there', /consumeLaunchLink\(\)/.test(nav));
ok('…and CLEARS it on the other branch, which is the sign-out crossing',
  /else\s*\{[\s\S]{0,80}clearLaunchLink\(\)/.test(nav));

const layout = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
console.log('\nThe wiring in app/_layout.tsx:');
// Three redirecting branches: signed-out, locked, and the .catch(). All three
// must stash, and the .catch() is the one most likely to be forgotten — it is
// also the branch a SecureStore failure takes on the device this was found on.
const stashes = (layout.match(/stashLaunchLink\(pathname\)/g) || []).length;
ok(`every redirecting branch stashes (found ${stashes}, want >= 3)`, stashes >= 3);
// The two guards this fix had to respect rather than loosen.
// Needle assembled, not written out: this file is not scanned by those guards,
// but spelling it here invites a copy-paste into one that is.
const banned = 'Linking.' + 'getInitialURL()';
ok('the root layout still does not make the forbidden initial-URL call',
  !layout.includes(banned));
ok('and the gate still awaits exactly the three things the splash waits on',
  /Promise\.all\(\[secure, getLaunchSessionState\(\), isMfaEnabled\(\)\]\)/.test(layout));
ok('the allowed branch does NOT stash — expo-router routes that URL itself',
  /settleLaunchGate\(true\);\s*\n\s*setLaunchGate\('allow'\);/.test(layout));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
