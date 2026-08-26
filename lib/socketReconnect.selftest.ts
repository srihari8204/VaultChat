/**
 * lib/socketReconnect.selftest.ts — run with: npx tsx lib/socketReconnect.selftest.ts
 *
 * These guard the decision that makes a network switch feel instant instead of
 * taking ~15s. Every case below is one the naive version gets wrong.
 */
import assert from 'node:assert/strict';
import { netKeyOf, reconnectReason, shouldKickOnForeground, shouldAbandonPendingConnect, PENDING_CONNECT_STALE_MS, SETTLE_MS } from './socketReconnect';

const net = (type: string, isConnected: boolean | null = true, reach: boolean | null = true) =>
  ({ type, isConnected, isInternetReachable: reach });

console.log('\nA usable network gets an identity; an unusable one gets none:');
assert.equal(netKeyOf(net('wifi')), 'wifi');
console.log('  ✓ wifi is itself');
assert.equal(netKeyOf(net('cellular')), 'cellular');
console.log('  ✓ cellular is itself');
assert.equal(netKeyOf(net('none', false)), null);
console.log('  ✓ disconnected has no identity');
assert.equal(netKeyOf(net('wifi', true, false)), null);
console.log('  ✓ connected-but-unreachable has no identity (captive portal)');

// THE trap. NetInfo reports null while probing. Treating that as offline makes
// every probe read as a network change and fires a reconnect storm.
assert.equal(netKeyOf(net('wifi', true, null)), 'wifi');
console.log('  ✓ a still-probing reachability (null) is NOT offline');

console.log('\nRebuild only when the network actually changed:');
assert.equal(reconnectReason('wifi', 'wifi'), null);
console.log('  ✓ same network, no churn');
assert.equal(reconnectReason('wifi', 'cellular'), 'net-switch:wifi->cellular');
console.log('  ✓ wifi -> cellular rebuilds, and names both ends');
assert.equal(reconnectReason('cellular', 'wifi'), 'net-switch:cellular->wifi');
console.log('  ✓ cellular -> wifi rebuilds too');
assert.equal(reconnectReason(null, 'cellular'), 'net-up:cellular');
console.log('  ✓ network returning rebuilds');

// Losing the network must NOT trigger retries — there is nothing to reach and
// a retry loop against a dead radio is exactly how battery disappears.
assert.equal(reconnectReason('wifi', null), null);
console.log('  ✓ losing the network does NOT start a retry loop');
assert.equal(reconnectReason(null, null), null);
console.log('  ✓ still offline, still quiet');

console.log('\nForeground rebuilds only a socket that is not already live:');
assert.equal(shouldKickOnForeground(false), true);
console.log('  ✓ dead socket on resume -> rebuild (Doze kills these silently)');
assert.equal(shouldKickOnForeground(true), false);
console.log('  ✓ healthy socket on resume -> left alone, no churn per app switch');

console.log('\nSettle window is short but non-zero:');
assert.ok(SETTLE_MS > 0, 'connecting into a half-up interface burns an attempt');
assert.ok(SETTLE_MS <= 1000, 'a settle this long would be its own perceptible delay');
console.log(`  ✓ ${SETTLE_MS}ms — covers the route/DNS gap, stays imperceptible`);

// A full switch is one transition, not two: the old key must be replaced, not
// accumulated, or a later identical switch would look like "no change".
console.log('\nA wifi -> cellular -> wifi round trip fires exactly twice:');
let key: string | null = 'wifi';
let fired = 0;
for (const s of [net('cellular'), net('cellular'), net('wifi')]) {
  const next = netKeyOf(s);
  if (reconnectReason(key, next)) fired++;
  key = next;
}
assert.equal(fired, 2, 'a repeated identical state must not re-fire');
console.log('  ✓ two switches, two rebuilds, no duplicate on the repeat');

console.log('\nA hung connect is abandoned, a live one is protected:');
assert.equal(shouldAbandonPendingConnect(null, 1_000_000), false);
console.log('  ✓ nothing in flight -> nothing to abandon');
assert.equal(shouldAbandonPendingConnect(1_000_000, 1_000_000 + 500), false);
console.log('  ✓ a connect that just started is left alone');
assert.equal(shouldAbandonPendingConnect(1_000_000, 1_000_000 + 9_000), false);
console.log('  ✓ still protected at 9s — inside the 10s handshake timeout');

// THE WEDGE this exists for. connect() settles only on 'ready' or
// 'connect_error'; a transport that opens without completing the handshake
// fires NEITHER, so the promise hangs and every caller queues behind it.
// Observed on device: offline banner with ZERO sockets open, on a link that
// answered HTTPS 200 — only a force-stop recovered it.
assert.equal(shouldAbandonPendingConnect(1_000_000, 1_000_000 + PENDING_CONNECT_STALE_MS), true);
console.log('  ✓ at the deadline the hung attempt is abandoned');
assert.equal(shouldAbandonPendingConnect(1_000_000, 1_000_000 + 60_000), true);
console.log('  ✓ and stays abandonable after — the wedge can never be permanent');
assert.ok(PENDING_CONNECT_STALE_MS > 10_000, 'must outlast the 10s client handshake timeout');
console.log(`  ✓ ${PENDING_CONNECT_STALE_MS}ms clears the 10s timeout, so a slow link is not read as a dead one`);

console.log('\nAll socket reconnect checks passed.\n');
