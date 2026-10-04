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
  hrefWithQuery,
  deliverTap,
  isLockOrAuthRoute,
  markLaunchRouted,
  onDeliveredTap,
  openWhenUnlocked,
  pathFromLaunchUrl,
  setResumeLockCheck,
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

// ── the query survives (broadcast invites carry ?code=) ─────────────────
console.log('\nKeeping the query:');
ok('pathname + query params -> one href',
  hrefWithQuery('/broadcast', { code: 'AB12' }) === '/broadcast?code=AB12',
  hrefWithQuery('/broadcast', { code: 'AB12' }));
ok('no params -> the bare path', hrefWithQuery('/settings', {}) === '/settings');
ok('values are encoded', hrefWithQuery('/chat', { id: 'a b&c' }) === '/chat?id=a%20b%26c',
  hrefWithQuery('/chat', { id: 'a b&c' }));
ok('a dynamic segment is already in the path, so it is not repeated',
  hrefWithQuery('/join/XYZ', { code: 'XYZ', ref: 'qr' }, ['join', '[code]']) === '/join/XYZ?ref=qr',
  hrefWithQuery('/join/XYZ', { code: 'XYZ', ref: 'qr' }, ['join', '[code]']));
ok('a catch-all segment likewise',
  hrefWithQuery('/add/a/b', { segments: ['a', 'b'] }, ['add', '[...segments]']) === '/add/a/b');
ok('non-string route state (nested navigator params) is not a query',
  hrefWithQuery('/x', { a: '1', params: { screen: 'y' } as any, n: undefined }) === '/x?a=1',
  hrefWithQuery('/x', { a: '1', params: { screen: 'y' } as any, n: undefined }));
ok('array query values repeat the key',
  hrefWithQuery('/x', { t: ['1', '2'] }) === '/x?t=1&t=2');
clearLaunchLink();
stashLaunchLink(hrefWithQuery('/broadcast', { code: 'AB12' }));
ok('and the stashed broadcast link replays WITH its code',
  consumeLaunchLink() === '/broadcast?code=AB12');

// ── notification taps vs the lock ────────────────────────────────────────
async function taps() {
  console.log('\nNotification taps never open over the lock:');
  ok('lock and sign-in routes are recognised',
    ['/app-lock', '/onboard', '/onboard-mpin', '/mpin-entry', '/mpin-recover', '/email-verify', '/blocked']
      .every(isLockOrAuthRoute));
  ok('ordinary screens and the splash are not',
    !isLockOrAuthRoute('/chat') && !isLockOrAuthRoute('/(tabs)/chats') && !isLockOrAuthRoute('/'));
  ok('"/app-lock-chats" is a feature screen, not the lock', !isLockOrAuthRoute('/app-lock-chats'));

  const opened: string[] = [];
  const open = (h: string) => { opened.push(h); };
  clearLaunchLink();

  await openWhenUnlocked('/chat?id=1', Promise.resolve(true), () => '/(tabs)/chats', open);
  ok('unlocked + allowed: opened at once', opened.join() === '/chat?id=1' && consumeLaunchLink() === null);

  // An allowed cold start that opened on '/': index.tsx is about to replace
  // the top entry with Chats, so a tap pushed now would be overwritten.
  opened.length = 0;
  await openWhenUnlocked('/chat?id=0', Promise.resolve(true), () => '/', open);
  ok('allowed launch still on the splash: held for index to replay',
    opened.length === 0 && consumeLaunchLink() === '/chat?id=0');
  markLaunchRouted();
  await openWhenUnlocked('/chat?id=0b', Promise.resolve(true), () => '/', open);
  ok('…and once index has routed, a tap opens (its push queues after the replace)',
    opened.join() === '/chat?id=0b');

  opened.length = 0;
  await openWhenUnlocked('/family-alerts?circleId=c', Promise.resolve(false), () => '/', open);
  ok('cold start redirected to the lock/sign-in: held, not pushed',
    opened.length === 0 && consumeLaunchLink() === '/family-alerts?circleId=c');

  await openWhenUnlocked('/chat?id=2', Promise.resolve(true), () => '/app-lock', open);
  ok('the lock is on screen: held', opened.length === 0 && consumeLaunchLink() === '/chat?id=2');

  await openWhenUnlocked('/chat?id=3', Promise.resolve(true), () => '/blocked', open);
  ok('a security verdict is on screen: held', opened.length === 0 && consumeLaunchLink() === '/chat?id=3');

  // The resume race: the lock decision is still in flight when the tap routes.
  let decide!: (v: boolean) => void;
  setResumeLockCheck(new Promise<boolean>((r) => { decide = r; }));
  const pendingTap = openWhenUnlocked('/chat?id=4', Promise.resolve(true), () => '/(tabs)/chats', open);
  await Promise.resolve();
  ok('a tap waits while the resume lock is deciding', opened.length === 0);
  decide(true);
  await pendingTap;
  ok('…and is held when the lock goes up', opened.length === 0 && consumeLaunchLink() === '/chat?id=4');

  setResumeLockCheck(Promise.resolve(false));
  await openWhenUnlocked('/chat?id=5', Promise.resolve(true), () => '/(tabs)/chats', open);
  ok('after unlock the decision is cleared and taps open again', opened.join() === '/chat?id=5');

  opened.length = 0;
  setResumeLockCheck(Promise.reject(new Error('SecureStore')));
  await openWhenUnlocked('/chat?id=6', Promise.resolve(true), () => '/(tabs)/chats', open);
  ok('a failed lock check does not strand taps', opened.join() === '/chat?id=6');
  setResumeLockCheck(Promise.resolve(false));

  // The gate settles once per process. A launch sent to the lock or sign-in
  // must not hold every later tap after the user has unlocked.
  opened.length = 0;
  await openWhenUnlocked('/chat?id=7', Promise.resolve(false), () => '/onboard', open);
  ok('redirected launch, still signing in: held', opened.length === 0 && consumeLaunchLink() === '/chat?id=7');
  await openWhenUnlocked('/chat?id=8', Promise.resolve(false), () => '/(tabs)/chats', open);
  ok('redirected launch, unlocked since: opened', opened.join() === '/chat?id=8' && consumeLaunchLink() === null);

  // Taps from notifee's background handler (a family alert pressed while the
  // app was backgrounded, or at JS load before the root mounted).
  console.log('\nTaps delivered from outside React:');
  const got: string[] = [];
  deliverTap('/family-alerts?circleId=a', 1_000);
  const off = onDeliveredTap((h) => { got.push(h); });
  ok('a tap that arrived before the root subscribed is delivered on subscribe',
    got.join() === '/family-alerts?circleId=a');
  deliverTap('/family-alerts?circleId=a', 3_000);
  ok('the same press seen again (getInitialNotification) is not opened twice', got.length === 1);
  deliverTap('/family-alerts?circleId=b', 3_500);
  ok('a different alert is delivered', got.join() === '/family-alerts?circleId=a,/family-alerts?circleId=b');
  deliverTap('/family-alerts?circleId=b', 60_000);
  ok('the same alert tapped again later is delivered', got.length === 3);
  off();
  deliverTap('/family-alerts?circleId=c', 70_000);
  ok('after unsubscribe a tap is held, not lost', got.length === 3);
  const off2 = onDeliveredTap((h) => { got.push(h); });
  ok('…and handed to the next subscriber', got[3] === '/family-alerts?circleId=c');
  off2();
}

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
const stashes = (layout.match(/stashLaunchLink\(launchHref\)/g) || []).length;
ok(`every redirecting branch stashes the href WITH its query (found ${stashes}, want >= 3)`, stashes >= 3);
ok('…which is built from the global search params', /hrefWithQuery\(pathname, globalParams, segments\)/.test(layout));
ok('notification taps go through the unlock gate, not a bare push',
  /openWhenUnlocked\(/.test(layout)
  && !/router\.push\(\{ pathname: '\/(chat|games|family|family-alerts)'/.test(layout)
  && !/router\.push\('\/group-invitations'/.test(layout));
const resume = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'components', 'ResumeLock.tsx'), 'utf8');
ok('ResumeLock publishes each resume decision before acting on it',
  /setResumeLockCheck\(lock\)/.test(resume));
const bg = fs.readFileSync(require('node:path').join(__dirname, 'callBackground.ts'), 'utf8');
ok('the notifee background handler routes a family-alert press to the root',
  /type === 'family-alert'[\s\S]{0,300}deliverTap\(hrefWithQuery\('\/family-alerts'/.test(bg));
ok('the root subscribes and opens delivered taps through the lock-aware opener',
  /onDeliveredTap\(openHref\)/.test(layout) && /const openHref[\s\S]{0,120}openWhenUnlocked\(href/.test(layout));
const indexSrc = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'app', 'index.tsx'), 'utf8');
ok('index replays a tap held on the splash instead of overwriting it',
  /router\.replace\("\/\(tabs\)\/chats"[\s\S]{0,80}markLaunchRouted\(\);[\s\S]{0,80}consumeLaunchLink\(\)/.test(indexSrc));
const appLock = fs.readFileSync(
  require('node:path').join(__dirname, '..', 'app', 'app-lock.tsx'), 'utf8');
ok('app-lock replays a held tap after a resume unlock',
  /router\.back\(\);[\s\S]{0,400}consumeLaunchLink\(\)/.test(appLock));
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

taps().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
});
