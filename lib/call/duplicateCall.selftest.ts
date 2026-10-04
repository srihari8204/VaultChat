// lib/call/duplicateCall.selftest.ts — one answer must make exactly one call.
//
//   npx tsx lib/call/duplicateCall.selftest.ts
//
// SCOPE: STRUCTURAL. It reads source and asserts the two guards are in place and
// in the right ORDER. It starts no call, so it proves wiring, not runtime —
// device verification stays separate.
//
// WHAT WENT WRONG, MEASURED ON DEVICE
//
// Five call rows appeared on one chat in six minutes, two of them in the same
// minute with different offer tags, each ringing the callee separately. Two
// independent causes, and fixing either alone leaves the bug reachable:
//
//   1. THE ENGINE RACE. startOutgoing checked `alreadyRunning(a)` and then hit
//      three awaits — a dynamic import, checkSessionHealth, and waitForSession
//      (which blocks for SECONDS while a ratchet repairs) — before bootstrap
//      finally assigned `session`. Two invocations inside that window both saw
//      no session, both proceeded, and the second one's bootstrap called
//      hangUp('replaced') on the first: a live call torn down, a second row
//      opened. `alreadyRunning` cannot close this — it reads state that does
//      not exist yet.
//
//   2. THE ROUTER FAN-IN. routeToCall is reachable from FOUR paths: the native
//      answer intent plus three notifee handlers (foreground event, initial
//      notification, background handler). Several firing for one answer is
//      normal. Each did its own router.push, mounting a second call screen
//      whose effect started its own session. routeToIncoming had a duplicate
//      guard; routeToCall had none.
//
// The claim must be taken BEFORE the awaits or it closes nothing, which is what
// check 2 exists to enforce — the ordering is the whole fix.

import { readFileSync } from 'fs';
import { join } from 'path';
import { readRootLayout } from '../../scripts/rootLayoutSources';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const ENGINE = strip(readFileSync(join(ROOT, 'lib/call/engine.ts'), 'utf8'));
// app/_layout.tsx plus the boot sequence that defines routeToCall (scripts/rootLayoutSources).
const LAYOUT = strip(readRootLayout());

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nDuplicate call prevention\n');

// ── 1. both entry points take the claim ───────────────────────────────
for (const fn of ['startOutgoing', 'acceptIncoming']) {
  const i = ENGINE.indexOf(`export async function ${fn}`);
  A(i >= 0, `1. ${fn} exists`);
  const body = ENGINE.slice(i, i + 900);
  A(/claimSetup\(a\)/.test(body), `1a. ${fn} takes the setup claim`);
  A(/setupClaim = \{/.test(body), `1b. ${fn} publishes the claim for others to await`);
}

// ── 2. THE ORDERING — the claim must precede the awaits ───────────────
{
  const i = ENGINE.indexOf('export async function startOutgoing');
  const body = ENGINE.slice(i, i + 1400);
  const claim = body.indexOf('claimSetup(a)');
  const health = body.indexOf('checkSessionHealth');
  const boot = body.indexOf('bootstrap(a');
  A(claim >= 0 && health >= 0 && claim < health,
    '2. claim is taken BEFORE checkSessionHealth — the await that opened the window');
  A(claim >= 0 && boot >= 0 && claim < boot,
    '2a. and before bootstrap, which is where session is finally assigned');
}

// ── 3. the claim is always released ───────────────────────────────────
{
  const releases = (ENGINE.match(/release\(\);/g) || []).length;
  A(releases >= 2, `3. release() in both finallys (found ${releases})`);
  A(/finally \{/.test(ENGINE), '3a. released in a finally, so a FAILED setup cannot');
  A((ENGINE.match(/setupClaim = null/g) || []).length >= 2,
    '3b. and the claim is cleared, so a retry is never swallowed');
}

// ── 4. the router de-duplicates too ───────────────────────────────────
{
  A(/const routeToCall/.test(LAYOUT), '4. routeToCall exists');
  const i = LAYOUT.indexOf('const routeToCall');
  const body = LAYOUT.slice(i - 400, i + 700);
  A(/routedCalls/.test(body), '4a. routeToCall keeps a routed-calls record');
  A(/ROUTE_DEDUPE_MS/.test(body), '4b. with a time box, so a genuine redial still opens a screen');
  const guard = body.indexOf('ROUTE_DEDUPE_MS) return');
  const push = body.indexOf('router.push');
  A(guard >= 0 && push >= 0 && guard < push,
    '4c. and the guard runs BEFORE router.push — a duplicate screen is never mounted');
}

// ── 5. the old guard is still there (belt AND braces) ─────────────────
A(/if \(alreadyRunning\(a\)\) return;/.test(ENGINE),
  '5. alreadyRunning is retained — it still catches the case where setup COMPLETED');

console.log(failed === 0
  ? '\nduplicateCall: all checks passed'
  : `\nduplicateCall: ${failed} FAILED`);
if (failed > 0) process.exit(1);
