// lib/family/presenceLifecycle.selftest.ts
// run: npx tsx lib/family/presenceLifecycle.selftest.ts
//
// Pins the P0 fix for the 60-90s publish stall (openspec change:
// fix-presence-publish-stall). presence.ts imports react-native, so — same as
// financeTheme.selftest — the invariants are pinned against the SOURCE TEXT.
// Brittle by design: if someone rewrites these lifecycle sites, this test
// makes them re-read why they are shaped this way.
//
// The invariants:
//   1. stopPresence tears down the FOREGROUND WATCHER ONLY. It must never end
//      the sharing session (sharing=false / myKey=null / circleIds=[]) and
//      must never broadcast live_location_stop — that teardown, raced against
//      startBackgroundPresence's deliberate stop-then-start window, was the
//      root cause of "not publishing under a checked switch".
//   2. setSharing(false) remains the ONLY real stop: it still announces
//      live_location_stop, still stops the background task, still drops the key.
//   3. The keepalive is the recovery watchdog: it must NOT die on !watcher —
//      it re-checks permission and re-arms via armWatcher instead.
//   4. armWatcher is single-flight (`arming` guard) so concurrent re-arms
//      cannot interleave remove/create.
//   5. handOffToBackground is serialised (bgHandoffChain).
//   6. startPresence keeps its generation guard.
//   7. background.ts keeps the locked-state pillars: a foreground service that
//      survives task removal, and pausesUpdatesAutomatically disabled.

import { readFileSync } from 'fs';
import { join } from 'path';

const P = readFileSync(join(__dirname, 'presence.ts'), 'utf8');
const B = readFileSync(join(__dirname, 'background.ts'), 'utf8');

let failures = 0;
function ok(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
}

/** The CODE of one top-level function — header to the next export, with
 *  comments stripped so an explanatory comment cannot trip a negative pin. */
function body(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('not found: ' + header);
  const next = src.indexOf('\nexport ', start + header.length);
  return src.slice(start, next < 0 ? undefined : next)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

console.log('presenceLifecycle.selftest');

// ── 1. stopPresence: foreground-only teardown ─────────────────────────
const stop = body(P, 'export async function stopPresence');
ok('stopPresence never sets sharing = false', !/sharing\s*=\s*false/.test(stop));
ok('stopPresence never drops the live key', !/myKey\s*=\s*null/.test(stop));
ok('stopPresence never clears circleIds', !/circleIds\s*=\s*\[\]/.test(stop));
ok('stopPresence never broadcasts live_location_stop', !stop.includes('live_location_stop'));
ok('stopPresence still stops watcher + keepalive', /watcher\?\.remove/.test(stop) && stop.includes('stopKeepalive()'));
ok('stopPresence attempts the background handoff when needed', stop.includes('handOffToBackground'));

// ── 2. setSharing(false) is the one real stop ─────────────────────────
const setSh = body(P, 'export async function setSharing');
ok('setSharing(false) still announces live_location_stop', setSh.includes('live_location_stop'));
ok('setSharing(false) still stops the background task', setSh.includes('stopBackgroundPresence'));
ok('setSharing(false) still drops the key', /myKey\s*=\s*null/.test(setSh));
ok('setSharing(true) still gates on the permission prompt', setSh.includes('requestForegroundPermissionsAsync'));

// ── 3. keepalive = watchdog ───────────────────────────────────────────
ok('the fatal !watcher keepalive guard is gone',
  !/!sharing \|\| !myKey \|\| !lastLoc \|\| !watcher/.test(P));
const tick = body(P, 'async function keepaliveTick');
ok('watchdog re-arms a dead watcher', tick.includes('armWatcher'));
ok('watchdog re-checks permission before recovery/re-assert',
  tick.includes('getForegroundPermissionsAsync'));
ok('watchdog re-asserts the last real fix (never invents one)',
  tick.includes('...lastLoc') && !tick.includes('latitude:'));

// ── 4. armWatcher single-flight ───────────────────────────────────────
const arm = body(P, 'async function armWatcher');
ok('armWatcher refuses concurrent entry', /if \(arming\) return;/.test(arm));
ok('armWatcher always releases the flag', /finally \{ arming = false; \}/.test(arm));

// ── 5. serialised handoff ─────────────────────────────────────────────
ok('handOffToBackground rides a serialising chain', P.includes('bgHandoffChain'));

// ── 6. generation guard intact ────────────────────────────────────────
ok('startPresence keeps its generation guard', P.includes('++startGen'));

// ── 7. locked-state pillars in background.ts ──────────────────────────
ok('background task keeps its foreground service', B.includes('foregroundService'));
ok('service survives the app being swiped away', B.includes('killServiceOnDestroy: false'));
ok('OS auto-pause stays disabled', B.includes('pausesUpdatesAutomatically: false'));
ok('headless wakes still flush the upload queue in-wake', /await flushAll\(\)/.test(B));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
