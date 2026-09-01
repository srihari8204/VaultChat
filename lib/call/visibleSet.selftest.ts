// lib/call/visibleSet.selftest.ts — run: npx tsx lib/call/visibleSet.selftest.ts
//
// The one runnable check behind the change that makes 64-participant calls
// possible. What it exists to catch, in order of how much it would cost:
//
//   1. A SMALL CALL BEHAVING DIFFERENTLY. Every 1:1 and 3-person call in
//      production goes through this code now. If the default state ever stops
//      meaning "want everything", the regression is one-way video on the calls
//      people actually make, found on a device days later. Check 1 is the whole
//      reason this file exists.
//   2. Audio or a screen share being dropped by a grid decision. Both are
//      unconditional, and both are the kind of rule that gets "tidied" into the
//      video path by someone who did not know why it was separate.
//   3. The grid thrashing on cross-talk — every flicker is a subscribe /
//      unsubscribe pair.
//
// No framework, no fs: this file is imported by nothing, and app code that
// require()s fs breaks assembleRelease.

import {
  newVisibleState, setVisible, wantsTrack, wantsVideo, visibleOrder,
  SPEAKER_DWELL_MS, VISIBLE_LINGER_MS, type SpeakerTimes,
} from './visibleSet';

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

const CAM = { kind: 'video' as const, screenShare: false };
const MIC = { kind: 'audio' as const, screenShare: false };
const SCREEN = { kind: 'video' as const, screenShare: true };

console.log('visibleSet');

// ── 1. the default is "everyone", and that is what small calls rely on ──
{
  const st = newVisibleState();
  const t = 1_000_000;
  A(st.visible === null, '1. a fresh state declares no visible set');
  A(['a', 'b', 'c', 'zzz'].every(uid => wantsTrack(st, uid, CAM, t)),
    '1a. with no set declared, EVERY camera is wanted — a 1:1 call is unchanged');
  A(['a', 'b', 'c'].every(uid => wantsTrack(st, uid, MIC, t)),
    '1b. and every microphone');
  // The property that matters: nothing about call size is consulted anywhere.
  // There is no threshold to get wrong, because there is no threshold.
  A(wantsTrack(st, 'someone-who-joined-late', CAM, t + 10 * 60_000),
    '1c. and it does not decay with time or count');
}

// ── 2. audio and screen share are never subject to the set ────────────
{
  const st = newVisibleState();
  const t = 2_000_000;
  setVisible(st, ['on-screen'], t);
  A(!wantsTrack(st, 'off-screen', CAM, t + VISIBLE_LINGER_MS + 1),
    '2. an off-screen camera is dropped');
  A(wantsTrack(st, 'off-screen', MIC, t + VISIBLE_LINGER_MS + 1),
    '2a. an off-screen MICROPHONE is still wanted — nobody is muted by scale');
  A(wantsTrack(st, 'off-screen', SCREEN, t + VISIBLE_LINGER_MS + 1),
    '2b. an off-screen SCREEN SHARE is still wanted — it is what they chose to show');
}

// ── 3. the linger window ──────────────────────────────────────────────
{
  const st = newVisibleState();
  const t = 3_000_000;
  setVisible(st, ['a', 'b'], t);
  setVisible(st, ['b', 'c'], t + 100);
  A(wantsVideo(st, 'a', t + 100), '3. someone just dropped keeps their camera briefly');
  A(!wantsVideo(st, 'a', t + 100 + VISIBLE_LINGER_MS + 1),
    '3a. and loses it once the window lapses');
  A(wantsVideo(st, 'c', t + 100), '3b. someone just added is wanted at once');

  // Re-entering must clear the linger, or a tile that leaves and returns
  // inherits an expiry from its previous departure and vanishes mid-call.
  setVisible(st, ['b'], t + 200);          // c out, lingering
  setVisible(st, ['b', 'c'], t + 300);     // c back in
  A(wantsVideo(st, 'c', t + 300 + VISIBLE_LINGER_MS + 5_000),
    '3c. re-entering the set clears the linger it was holding');
}

// ── 4. going back to "everyone" ───────────────────────────────────────
{
  const st = newVisibleState();
  const t = 4_000_000;
  setVisible(st, ['a'], t);
  setVisible(st, null, t + 10);
  A(wantsTrack(st, 'anyone-at-all', CAM, t + 10), '4. null restores "everyone"');
}

// ── 5. ordering: speakers first, roster as the stable tiebreak ────────
{
  const roster = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const t = 5_000_000;
  const quiet: SpeakerTimes = new Map();
  A(JSON.stringify(visibleOrder(roster, quiet, 3, t)) === JSON.stringify(['u1', 'u2', 'u3']),
    '5. with nobody speaking the order is the roster — same faces on every device');

  const spoke: SpeakerTimes = new Map([['u6', t - 100]]);
  const page = visibleOrder(roster, spoke, 3, t);
  A(page[0] === 'u6', '5a. an off-screen speaker is promoted to the front');
  A(page.length === 3, '5b. the page stays the size it was asked for');

  const stale: SpeakerTimes = new Map([['u6', t - SPEAKER_DWELL_MS - 1]]);
  A(!visibleOrder(roster, stale, 3, t).includes('u6'),
    '5c. speech older than the dwell window stops promoting — the first person to '
    + 'talk does not own a tile for the whole call');

  A(JSON.stringify(visibleOrder(roster, quiet, 10, t)) === JSON.stringify(roster),
    '5d. a call smaller than the page shows everyone, in roster order');
  A(visibleOrder([], quiet, 9, t).length === 0, '5e. an empty roster is not a crash');
}

// ── 6. cross-talk does not thrash the page ────────────────────────────
{
  const roster = ['u1', 'u2', 'u3', 'u4'];
  const t = 6_000_000;
  // u4 speaks, then u3 answers 200ms later. Both are inside their dwell window,
  // so both hold tiles and the page is stable rather than swapping u4 out.
  const spoke: SpeakerTimes = new Map([['u4', t], ['u3', t + 200]]);
  const page = visibleOrder(roster, spoke, 2, t + 200);
  A(page.includes('u3') && page.includes('u4'),
    '6. two people talking over each other both hold tiles');
  const later = visibleOrder(roster, spoke, 2, t + 250);
  A(JSON.stringify(page) === JSON.stringify(later),
    '6a. and the page does not reshuffle 50ms later');
}

console.log(failed === 0 ? '\nvisibleSet: all checks passed' : `\nvisibleSet: ${failed} FAILED`);
if (failed > 0) process.exit(1);
