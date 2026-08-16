// lib/call/mode.selftest.ts — run: npx tsx lib/call/mode.selftest.ts
//
// This module decides whether a call is peer-to-peer or server-routed, and that
// decision carries a SECURITY consequence: mesh keeps 1:1 end-to-end encrypted
// (D-1). The SFU preserves it too, because RTCFrameCryptor encrypts each frame
// BEFORE it leaves the device — so "every call is E2EE" is the invariant, and
// the transport underneath it is free to change.
//
// The other invariant worth pinning: an audience member must not be able to
// publish. The media server enforces it, but the UI has to agree — offering a
// mic button the SFU will refuse is a bug the user experiences as breakage.

import {
  BROADCAST_MAX, BROADCAST_MAX_PUBLISHERS, MAX_RENDERED_TILES, MESH_MAX, SFU_MAX,
  canJoin, canPublish, capacityFor, publisherSlotsLeft, simulcastLayers, tilesToRender,
  topologyFor, VIEWER_MAX, broadcastTierFor, transportFor, expectedLatencyMs,
  promotionNeedsTransportSwitch, interactiveCapacityFor, mintsMediaKey,
} from './mode';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const topo = (participants: number, o: Record<string, unknown> = {}) =>
  topologyFor({ participants, ...o });

console.log('\nCall topology self-test\n');

// ── the security-relevant one ──────────────────────────────────────────
console.log('EVERY call rides the SFU — frame E2EE keeps D-1 true (owner decision 2026-08-16):');
eq('a 1:1 call is SFU', topo(2), 'sfu');
eq('3 people is SFU', topo(3), 'sfu');
eq('exactly MESH_MAX is SFU', topo(MESH_MAX), 'sfu');
check('every participant count yields sfu while the SFU is available',
  Array.from({ length: MESH_MAX }, (_, i) => topo(i + 1)).every(t => t === 'sfu'));

console.log('\nbeyond the mesh cap, the SFU takes over:');
eq('one past the cap switches to sfu', topo(MESH_MAX + 1), 'sfu');
eq('64 is sfu', topo(64), 'sfu');
eq('an unavailable SFU degrades to mesh rather than failing',
  topo(20, { sfuAvailable: false }), 'mesh');

console.log('\nbroadcast is chosen, never inferred:');
eq('a 2-person broadcast is still a broadcast', topo(2, { isBroadcast: true }), 'broadcast');
eq('a 500-person broadcast is a broadcast', topo(500, { isBroadcast: true }), 'broadcast');
check('a large ORDINARY call is never silently a broadcast', topo(500) === 'sfu');

// ── capacity ───────────────────────────────────────────────────────────
console.log('\ncapacity:');
eq('mesh capacity', capacityFor('mesh'), MESH_MAX);
eq('sfu capacity is the 64 target', capacityFor('sfu'), SFU_MAX);
eq('broadcast is UNLIMITED — the CDN absorbs the tail', capacityFor('broadcast'), VIEWER_MAX);
eq('but its WebRTC tier is finite, and that is what sizes servers',
  interactiveCapacityFor('broadcast'), BROADCAST_MAX);
check('a millionth viewer can still join', canJoin('broadcast', 1_000_000));
check('an ordinary sfu call is NOT unlimited', capacityFor('sfu') === SFU_MAX);
check('a full mesh refuses another joiner', !canJoin('mesh', MESH_MAX));
check('a mesh with room accepts', canJoin('mesh', MESH_MAX - 1));
check('the 64th person can join an SFU call', canJoin('sfu', 63));
check('the 65th cannot', !canJoin('sfu', 64));

// ── publish rights ─────────────────────────────────────────────────────
console.log('\npublish rights:');
check('everyone may publish in mesh', (['host', 'cohost', 'speaker', 'audience'] as const).every(r => canPublish('mesh', r)));
check('everyone may publish in an ordinary sfu call', (['host', 'cohost', 'speaker', 'audience'] as const).every(r => canPublish('sfu', r)));
check('an AUDIENCE member may NOT publish in a broadcast', !canPublish('broadcast', 'audience'));
check('host, cohost and speaker may', (['host', 'cohost', 'speaker'] as const).every(r => canPublish('broadcast', r)));

eq('publisher slots are capped in a broadcast', publisherSlotsLeft('broadcast', 0), BROADCAST_MAX_PUBLISHERS);
eq('and run out', publisherSlotsLeft('broadcast', BROADCAST_MAX_PUBLISHERS), 0);
check('never negative', publisherSlotsLeft('broadcast', 99) === 0);
check('an ordinary call has no publisher limit', publisherSlotsLeft('sfu', 50) === Infinity);

// ── rendering: the device-side cost ────────────────────────────────────
console.log('\nrendered tiles (device cost, not server cost):');
eq('a 1:1 call renders one remote tile', tilesToRender('mesh', 2), 1);
eq('a 5-person mesh renders four', tilesToRender('mesh', 5), 4);
eq('a 64-person call does NOT render 63 tiles',
  tilesToRender('sfu', 64), MAX_RENDERED_TILES);
check('rendered tiles never exceed the cap at any size',
  [6, 20, 64, 500].every(n => tilesToRender('sfu', n) <= MAX_RENDERED_TILES));
eq('a broadcast renders only its publishers', tilesToRender('broadcast', 1000, 3), 3);
eq('and never more than the publisher cap',
  tilesToRender('broadcast', 1000, 99), BROADCAST_MAX_PUBLISHERS);

// ── simulcast: the thermal decision ────────────────────────────────────
console.log('\nsimulcast layers:');
eq('mesh publishes one layer — nothing to select from', simulcastLayers('mesh', false), 1);
eq('a capable device publishes three', simulcastLayers('sfu', false), 3);
eq('a low-end device publishes two, not three', simulcastLayers('sfu', true), 2);
check('a low-end device never publishes more than a capable one',
  simulcastLayers('sfu', true) < simulcastLayers('sfu', false));

// ── broadcast delivery tiers: the latency-for-scale trade ──────────────
//
// Millions cannot be served over WebRTC. The tier split is what makes an
// unlimited audience possible, and it costs seconds of delay for the tail —
// a trade no engineering removes, so it is asserted rather than assumed.
console.log('\nbroadcast tiers:');
eq('a host is always a publisher', broadcastTierFor('host', 0), 'publisher');
eq('a promoted speaker publishes even when the room is enormous',
  broadcastTierFor('speaker', 9_999_999), 'publisher');
eq('early audience gets the interactive (WebRTC) tier', broadcastTierFor('audience', 0), 'interactive');
eq('audience past the WebRTC tier spills to CDN viewing',
  broadcastTierFor('audience', BROADCAST_MAX), 'viewer');
eq('the boundary is exact', broadcastTierFor('audience', BROADCAST_MAX - 1), 'interactive');

eq('publishers ride WebRTC', transportFor('publisher'), 'webrtc');
eq('interactive rides WebRTC', transportFor('interactive'), 'webrtc');
eq('viewers ride HLS', transportFor('viewer'), 'hls');

check('a CDN viewer is measurably further behind than an interactive listener',
  expectedLatencyMs('viewer') > expectedLatencyMs('interactive'));
check('interactive stays inside the sub-second target',
  expectedLatencyMs('interactive') <= 500);

check('promoting a CDN viewer requires a transport switch',
  promotionNeedsTransportSwitch('viewer'));
check('promoting an interactive listener does not — the connection already exists',
  !promotionNeedsTransportSwitch('interactive'));

// ── who mints the media key ────────────────────────────────────────────
//
// EXACTLY ONE side may say yes. Two minters splits the room across two keys;
// zero minters means nobody joins, because the SFU path refuses to publish
// unencrypted. Both failures look identical on device — a call that connects
// and carries nothing — so the rule is pinned here.
console.log('\nmedia key minting:');
const oneToOne = (direction: 'outgoing' | 'incoming') =>
  mintsMediaKey({ oneToOne: true, direction, meId: 'zzz', others: ['aaa'] });
check('1:1 — the answering side mints', oneToOne('incoming'));
check('1:1 — the caller does NOT, however low its uid', !oneToOne('outgoing'));
check('1:1 — exactly one side of the same call mints',
  [oneToOne('incoming'), oneToOne('outgoing')].filter(Boolean).length === 1);
// The caller's uid is irrelevant on this path — that is the whole point.
check('1:1 — a high-uid callee still mints',
  mintsMediaKey({ oneToOne: true, direction: 'incoming', meId: 'zzz', others: ['aaa'] }));

const group = (meId: string) =>
  mintsMediaKey({ oneToOne: false, direction: 'outgoing', meId, others: ['a', 'b', 'c'].filter(u => u !== meId) });
check('group — the lowest uid mints', group('a'));
check('group — nobody else does', !group('b') && !group('c'));
check('group — exactly one of the room mints',
  ['a', 'b', 'c'].filter(u => mintsMediaKey({ oneToOne: false, direction: 'outgoing', meId: u, others: ['a', 'b', 'c'].filter(o => o !== u) })).length === 1);
check('group — direction is irrelevant, unlike 1:1',
  mintsMediaKey({ oneToOne: false, direction: 'incoming', meId: 'a', others: ['b'] })
  === mintsMediaKey({ oneToOne: false, direction: 'outgoing', meId: 'a', others: ['b'] }));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all topology checks passed\n');
process.exit(failures ? 1 : 0);
