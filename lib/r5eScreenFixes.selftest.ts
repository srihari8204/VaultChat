// lib/r5eScreenFixes.selftest.ts — npx tsx lib/r5eScreenFixes.selftest.ts
//
// Pins the round-5 fixes on the calls / live / storage / games screens, which
// are screen wiring rather than pure functions, by reading their sources.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

// 1. Storage manager: the 400 ms counter is never in a live region; start and finish are announced once.
const sm = read('app/storage-manager.tsx');
ok(!/accessibilityLiveRegion/.test(sm), '1. the loading view is not a live region');
ok((sm.match(/announceForAccessibility\(/g) ?? []).length === 2, '1a. start and finish are announced, nothing else');

// 2. Offline mode: the retry snapshot is dropped once settled, and by a newly queued message.
const om = read('app/offline-mode.tsx');
ok(/if \(next\.waiting === 0\) retryBase\.current = null;/.test(om), '2. a settled retry stops re-describing');
ok(/const onPending = \(\) => \{ retryBase\.current = null; refresh\(\); \};/.test(om)
  && /on\('pending', onPending\)/.test(om), '2a. a new message is not counted against the old retry');

// 3. Group call: every sheet update goes through the mounted guard.
const gc = read('app/group-call-active.tsx');
ok(/const setSheet = useCallback\(\(v: typeof sheet\) => \{ if \(mounted\.current\) setSheetState\(v\); \}, \[\]\);/.test(gc),
  '3. group-call sheet updates are dropped after unmount');
ok(!/'rgba\(/.test(gc), '3a. call chrome rgba literals live in constants/callTheme.ts');

// 4. Incoming call: the ponytail names the transport that lacks the ack.
const ic = read('app/incoming-call.tsx');
ok(/ccwire_app_events\.go/.test(ic) && !/handlers\.go `relay`/.test(ic), '4. the ponytail points at ccwire');

// 5. Network test: re-probed per run, and every saved row says which server measured it.
const nt = read('app/network-test.tsx');
ok(/const t = await checkServerStatus\(\);/.test(nt) && !/target \?\? await checkServerStatus/.test(nt), '5. each run re-probes');
ok(/server: t\.host,/.test(nt), '5a. history rows record the server');

// 6. Live: error kinds come from the HTTP status, not the message text.
const lv = read('app/live.tsx');
ok(/const already = status === 409;/.test(lv) && /const unconfigured = status === 503;/.test(lv)
  && !/msg\.includes\('409'\)/.test(lv), '6. goLive classifies by status');

// 7. Games invite sheet: a failed chat load is not "No chats yet".
const inv = read('components/games/InviteSheet.tsx');
ok(/setLoadFailed\(true\)/.test(inv) && /loadFailed \?/.test(inv), '7. a failed load says so and offers a retry');

// 8. Live invite: a failed copy is not reported as copied.
const li = read('components/live/LiveInvitePanel.tsx');
ok(/catch \{\s*Alert\.alert\('Could not copy'/.test(li), '8. clipboard failure is reported');

console.log(`r5eScreenFixes.selftest: ${n} assertions passed`);
