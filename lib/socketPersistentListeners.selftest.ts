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
 * The boot warm-up in app/_layout.tsx deliberately breaks that ordering: it
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

const root = join(__dirname, '..');
const socketSrc = readFileSync(join(root, 'lib', 'socket.ts'), 'utf8');
const layoutSrc = readFileSync(join(root, 'app', '_layout.tsx'), 'utf8');

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
  'app/_layout.tsx should start the handshake at module scope',
);
console.log('  ✓ _layout starts the handshake at boot, fire-and-forget');
assert.ok(
  layoutSrc.indexOf('getSocket()') < layoutSrc.indexOf('export default'),
  'the warm-up must be at module scope, before the component — that is the point',
);
console.log('  ✓ at module scope, so it overlaps the handshake with React mounting');

console.log('\nAll persistent-listener checks passed.\n');
