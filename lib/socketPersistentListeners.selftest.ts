/**
 * lib/socketPersistentListeners.selftest.ts
 *   run with: npx tsx lib/socketPersistentListeners.selftest.ts
 *
 * Guards the ordering invariant that keeps INCOMING CALLS RINGING.
 *
 * addPersistentListener() attaches a handler to the live socket only when
 * `socket` is already assigned; otherwise it just records it in the map, and
 * connect() copies the map onto the socket at construction. That works only
 * while the FIRST getSocket() comes from addPersistentListener itself — which
 * is how it used to work by accident.
 *
 * The boot warm-up (app/_layout.tsx → components/root/useBootSequence) deliberately breaks that ordering: it
 * opens the socket BEFORE any listener exists, so the construction-time copy
 * sees an empty map, and a handler registered mid-handshake attaches to
 * nothing. Calls then stop ringing with nothing in any log to say why.
 *
 * connect() therefore re-applies on the 'connect' event too. This is a SOURCE
 * SCAN because the guarantee is an ordering side-effect, not a pure value —
 * and a source scan belongs in a *.selftest.ts, never embedded in app code
 * (an fs require inside a shipped module breaks assembleRelease).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRootLayout } from '../scripts/rootLayoutSources';

const root = join(__dirname, '..');
const socketSrc = readFileSync(join(root, 'lib', 'socket.ts'), 'utf8');
// app/_layout.tsx plus the boot sequence it calls (scripts/rootLayoutSources).
const layoutSrc = readRootLayout();

console.log('\nPersistent listeners survive a socket opened before they exist:');

const applyCalls = (socketSrc.match(/applyPersistent\(s\)/g) || []).length;
assert.ok(
  applyCalls >= 2,
  `applyPersistent(s) must run at construction AND on 'connect'; found ${applyCalls} call(s). ` +
  `Dropping the second one makes incoming calls stop ringing whenever the socket ` +
  `is opened before a listener is registered.`,
);
console.log(`  ✓ applyPersistent(s) called ${applyCalls}x — construction + reconnect`);

// It must be INSIDE the connect handler, not merely present somewhere: a call
// that runs once at build time is exactly the version this test exists to fail.
const connectHandler = socketSrc.slice(socketSrc.indexOf("s.on('connect'"));
assert.ok(
  connectHandler.indexOf('applyPersistent(s)') > -1,
  "applyPersistent(s) must appear inside the s.on('connect') handler",
);
console.log("  ✓ and one of them is inside the s.on('connect') handler");

// off() before on() is what makes running it twice safe rather than duplicating
// every handler — which would ring, notify and decrypt each event twice over.
assert.ok(
  /\.off\(event, h\)[\s\S]{0,40}\.on\(event, h\)/.test(socketSrc),
  'applyPersistent must off() before on() so re-applying cannot double-register',
);
console.log('  ✓ off() precedes on() — re-applying cannot double-register handlers');

console.log('\nThe boot warm-up that depends on all of the above:');
assert.ok(
  /getSocket\(\)\.catch\(/.test(layoutSrc),
  'the root should start the handshake at boot, fire-and-forget',
);
console.log('  ✓ the root starts the handshake at boot, fire-and-forget');
// The warm-up moved from module scope into the boot sequence, as its FIRST
// step (see the note above it). It must stay ahead of the rest of that work,
// or the handshake stops overlapping the render.
const bootAt = layoutSrc.indexOf("mark('boot_effect_start')");
const warmAt = layoutSrc.indexOf('void getSocket()');
assert.ok(
  bootAt > -1 && warmAt > bootAt &&
    ['runSecurityCheck()', 'getAccessToken()', 'InteractionManager.runAfterInteractions']
      .every((w) => layoutSrc.indexOf(w) > warmAt),
  'the warm-up must be the first step of the boot sequence, before the scan, the token read and deferred work',
);
console.log('  ✓ first step of the boot sequence, so it overlaps the handshake with the render');

console.log('\nAll persistent-listener checks passed.\n');
