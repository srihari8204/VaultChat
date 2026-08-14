// lib/family/visibility.selftest.ts — the N-member Family visibility matrix.
//
// WHAT THIS PROVES, DETERMINISTICALLY, FOR N = 2..10:
//   - every member's device, folding the same relayed presence events, ends up
//     seeing every OTHER member (N-1 of them) plus itself — all N(N-1)
//     directed viewer→subject relationships, 90 of them at N=10;
//   - the store is keyed by member id: shuffled event order, joins and leaves
//     never swap one member's coordinates onto another;
//   - one member's update touches ONLY that member's entry (marker
//     independence, spec §11/§13);
//   - removal deletes exactly the removed member everywhere (spec §8);
//   - the FAMILY NOW board derives its counts from the same store and always
//     agrees with it (spec §5/§15).
//
// WHAT THIS DELIBERATELY DOES NOT PROVE: transport. Whether a real relay
// delivers a real sealed ping to a real second phone is a physical two-device
// test, and no simulation here may claim it. This file proves the LOGIC every
// device runs on what it receives.
//
//   npx tsx lib/family/visibility.selftest.ts

import { foldPresence, markSharingOff, statusBoard, freshnessOf } from './status';
import { type MemberPresence } from './types';

const fail = (m: string) => { throw new Error(`visibility: ${m}`); };
const NOW = 1_700_000_000_000;

/** Distinct, stable, deliberately non-sequential ids — nothing may assume order. */
const idOf = (i: number) => `member-${String.fromCharCode(74 - i)}-${(i * 7919) % 997}`;

/** A member's presence, with coordinates unique to that member. */
const presenceOf = (i: number, ts = NOW): MemberPresence => ({
  userId: idOf(i),
  pos: { lat: 10 + i, lng: 70 + i },
  ts,
  battery: 50 + i,
});

let totalDirected = 0;

for (let n = 2; n <= 10; n++) {
  const ids = Array.from({ length: n }, (_, i) => idOf(i));

  // Every device folds the same relayed events. Shuffle the delivery order
  // differently per viewer — real sockets guarantee no order.
  for (let viewer = 0; viewer < n; viewer++) {
    const order = ids.map((_, i) => i).sort((a, b) => ((a * 31 + viewer * 17) % 13) - ((b * 31 + viewer * 17) % 13));
    let store: Record<string, MemberPresence> = {};
    for (const i of order) store = foldPresence(store, idOf(i), presenceOf(i));

    // The viewer sees SELF + the other n-1 members.
    if (Object.keys(store).length !== n) fail(`N=${n} viewer ${viewer}: expected ${n} entries, got ${Object.keys(store).length}`);
    for (let subject = 0; subject < n; subject++) {
      if (subject === viewer) continue;
      const p = store[idOf(subject)];
      if (!p) fail(`N=${n}: ${idOf(viewer)} cannot see ${idOf(subject)}`);
      // The coordinate must be the SUBJECT's own — a swapped marker is the
      // exact bug stable keying exists to prevent.
      if (p.pos.lat !== 10 + subject || p.pos.lng !== 70 + subject) {
        fail(`N=${n}: ${idOf(viewer)} sees wrong coordinates for ${idOf(subject)}`);
      }
      if (p.userId !== idOf(subject)) fail(`N=${n}: identity mismatch for ${idOf(subject)}`);
      totalDirected++;
    }
    if (!store[idOf(viewer)]) fail(`N=${n}: viewer ${idOf(viewer)} lost their own SELF entry`);
  }

  // Dynamic addition (spec §7): grow 2 → n one member at a time; every
  // intermediate size must be complete without any special-casing.
  let grow: Record<string, MemberPresence> = {};
  for (let i = 0; i < n; i++) {
    grow = foldPresence(grow, idOf(i), presenceOf(i));
    if (Object.keys(grow).length !== i + 1) fail(`N=${n}: growth to ${i + 1} members incomplete`);
  }

  // Independence (spec §11/§13): move ONE member; nobody else's entry changes.
  const mover = Math.min(2, n - 1);
  const before = grow;
  const after = foldPresence(before, idOf(mover), { ...presenceOf(mover, NOW + 5_000), pos: { lat: 55, lng: 55 } });
  for (let i = 0; i < n; i++) {
    if (i === mover) {
      if (after[idOf(i)].pos.lat !== 55) fail(`N=${n}: mover's update did not land`);
      if (after[idOf(i)].ts !== NOW + 5_000) fail(`N=${n}: mover's timestamp did not advance`);
    } else if (after[idOf(i)] !== before[idOf(i)]) {
      fail(`N=${n}: moving ${idOf(mover)} disturbed ${idOf(i)}'s entry`);
    }
  }

  // Removal (spec §8): removing one member deletes exactly that entry.
  const removed = foldPresence(after, idOf(0), null);
  if (removed[idOf(0)]) fail(`N=${n}: removed member still visible`);
  if (Object.keys(removed).length !== n - 1) fail(`N=${n}: removal disturbed other members`);

  // The board derives from the same store and must agree (spec §5/§15).
  const board = statusBoard(ids, grow, [], NOW);
  if (board.total !== n) fail(`N=${n}: board total wrong`);
  if (board.live !== n) fail(`N=${n}: all fixes are fresh — board.live should be ${n}, got ${board.live}`);
  if (board.unavailable !== 0) fail(`N=${n}: nothing is unavailable yet`);
}

if (totalDirected !== [...Array(9)].reduce((a, _, k) => a + (k + 2) * (k + 1), 0)) {
  fail(`directed relationship count wrong: ${totalDirected}`);
}

// ── the spec's mixed-state 10-member example (§2/§5) ──────────────────
// A LIVE, B LIVE, C sharing-off (silence), D silence, E RECENT, F STALE,
// G LIVE, H silence, I LIVE, J beyond-stale silence-equivalent (no entry).
{
  const ids = Array.from({ length: 10 }, (_, i) => idOf(i));
  let store: Record<string, MemberPresence> = {};
  const put = (i: number, ts: number) => { store = foldPresence(store, idOf(i), presenceOf(i, ts)); };
  put(0, NOW); put(1, NOW);                       // A, B LIVE
  /* C, D, H, J: silence — never folded */
  put(4, NOW - 5 * 60_000);                       // E RECENT
  put(5, NOW - 20 * 60_000);                      // F STALE (last known)
  put(6, NOW); put(8, NOW);                       // G, I LIVE
  const b = statusBoard(ids, store, [], NOW);
  if (b.total !== 10) fail('example: total');
  if (b.live !== 4) fail(`example: live should be 4, got ${b.live}`);
  if (b.recent !== 1) fail(`example: recent should be 1, got ${b.recent}`);
  if (b.stale !== 1) fail(`example: stale should be 1, got ${b.stale}`);
  // unavailable = 4 silent + 1 stale — a last-known dot is not a usable fix
  if (b.unavailable !== 5) fail(`example: unavailable should be 5, got ${b.unavailable}`);
  if (b.sharing !== 5) fail(`example: sharing (live+recent) should be 5, got ${b.sharing}`);
  // membership never shrinks because location is missing (spec §2)
  if (ids.length !== 10) fail('example: membership must stay 10');
  // and the per-member tier the rows would render agrees with the tallies
  const tiers = ids.map((id) => freshnessOf(store[id]?.ts, NOW));
  if (tiers.filter((t) => t === 'live').length !== b.live) fail('example: row tiers disagree with board');
}

// ── mixed sharing matrix (spec §22/§34): expected counts computed, never
// hardcoded. Sharing OFF = explicit stop → last-known retained, never LIVE;
// a member who never published is simply absent. Two invariants per pattern:
//   live-pairs among sharers          = k × (k−1)
//   §8 visibility (everyone sees all sharers except self) = k × (N−1)
{
  const N = 10;
  const ids = Array.from({ length: N }, (_, i) => idOf(i));
  let lcg = 1234567; // deterministic pseudo-random (Math.random is banned here)
  const nextBit = () => { lcg = (lcg * 48271) % 2147483647; return lcg % 2 === 0; };

  const patterns: boolean[][] = [
    Array(N).fill(true),                                   // all ON
    ids.map((_, i) => i < 5),                              // 5 ON / 5 OFF
    ids.map((_, i) => i < 2),                              // 2 ON
    Array(N).fill(false),                                  // all OFF
    ids.map(() => nextBit()),                              // random pattern
  ];

  for (const [pi, on] of patterns.entries()) {
    // Every member published once; the OFF ones then explicitly stopped.
    let store: Record<string, MemberPresence> = {};
    for (let i = 0; i < N; i++) store = foldPresence(store, idOf(i), presenceOf(i));
    for (let i = 0; i < N; i++) if (!on[i]) store = markSharingOff(store, idOf(i));

    const k = on.filter(Boolean).length;
    const isLive = (uid: string) => !!store[uid] && !store[uid].sharingOff && freshnessOf(store[uid].ts, NOW) === 'live';

    let livePairsAmongSharers = 0;
    let visibilityRelations = 0;
    for (let viewer = 0; viewer < N; viewer++) {
      for (let target = 0; target < N; target++) {
        if (viewer === target) continue;
        if (isLive(idOf(target))) {
          visibilityRelations++;                       // §8: EVERY member sees every sharer
          if (on[viewer]) livePairsAmongSharers++;     // §34 arithmetic: among sharers
        }
      }
    }
    if (livePairsAmongSharers !== k * (k - 1)) {
      fail(`pattern ${pi}: live pairs among sharers = ${livePairsAmongSharers}, expected ${k}×${k - 1}`);
    }
    if (visibilityRelations !== k * (N - 1)) {
      fail(`pattern ${pi}: §8 visibility relations = ${visibilityRelations}, expected ${k}×${N - 1}`);
    }
    // OFF members keep their profile-side last-known (they published earlier):
    for (let i = 0; i < N; i++) {
      if (on[i]) continue;
      const e = store[idOf(i)];
      if (!e) fail(`pattern ${pi}: OFF member ${i} lost their last-known entry`);
      if (!e.sharingOff) fail(`pattern ${pi}: OFF member ${i} not flagged`);
      if (e.pos.lat !== 10 + i) fail(`pattern ${pi}: OFF member ${i} last-known coordinates corrupted`);
      if (isLive(idOf(i))) fail(`pattern ${pi}: OFF member ${i} counted as LIVE`);
    }
    // The board agrees with the same store.
    const b = statusBoard(ids, store, [], NOW);
    if (b.sharingOff !== N - k) fail(`pattern ${pi}: board sharingOff=${b.sharingOff}, expected ${N - k}`);
    if (b.live !== k) fail(`pattern ${pi}: board live=${b.live}, expected ${k}`);
  }

  // re-enable: only a FRESH fix returns a member to LIVE (spec §12/§21)
  let s2: Record<string, MemberPresence> = foldPresence({}, idOf(0), presenceOf(0, NOW - 30_000));
  s2 = markSharingOff(s2, idOf(0));
  if (statusBoard([idOf(0)], s2, [], NOW).live !== 0) fail('re-enable: stopped member must not be live');
  s2 = foldPresence(s2, idOf(0), presenceOf(0, NOW));   // the fresh fix after re-enable
  if (statusBoard([idOf(0)], s2, [], NOW).live !== 1) fail('re-enable: fresh fix must restore LIVE');
  if (s2[idOf(0)].sharingOff) fail('re-enable: fresh fix must clear the flag');
}

console.log(`family/visibility matrix OK — N=2..10, ${totalDirected} directed relationships verified (90 at N=10), independence, removal, board agreement, mixed-sharing patterns (dynamic expectations), re-enable`);
