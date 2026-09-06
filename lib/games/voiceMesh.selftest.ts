// lib/games/voiceMesh.selftest.ts — run: npx tsx lib/games/voiceMesh.selftest.ts
//
// Table voice is the hardest thing here to test by hand: it needs two real
// devices, two accounts, a table, and a fault that may only show on one
// network. These are the decisions that make the difference between "audio
// flows" and "one side sits in have-local-offer forever", so they are checked
// where a laptop can check them.

import {
  shouldInitiate, rosterFrom, diffRoster, IceQueue, audioLevelFrom, SPEAKING_LEVEL,
} from './voiceMesh';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nVoice mesh — who dials\n');

// The whole point: exactly ONE side of any pair dials. Both dialling is glare;
// neither dialling is silence. Either way there is no audio.
{
  const ids = ['v001', 'vabc', 'vZZZ', 'v337da54a1d30', 'vb2770fa1e774', 'A', 'a'];
  let bothOrNeither = '';
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const dials = Number(shouldInitiate(a, b)) + Number(shouldInitiate(b, a));
      if (dials !== 1) bothOrNeither = `${a} / ${b} → ${dials} callers`;
    }
  }
  check('exactly one side of every pair dials', !bothOrNeither, bothOrNeither);
  check('nobody dials themselves', !shouldInitiate('v1', 'v1'));
}

console.log('\nRoster\n');
{
  const you = 'me';

  check('rummy sends `peers`',
    JSON.stringify(rosterFrom({ t: 'peers', peers: [{ vaultId: 'a', name: 'Ana' }, { vaultId: 'me', name: 'Me' }] }, you))
      === JSON.stringify({ a: 'Ana' }));

  check('most games send lobby.members',
    JSON.stringify(rosterFrom({ t: 'state', lobby: { members: [{ vaultId: 'b', name: 'Bo' }] } }, you))
      === JSON.stringify({ b: 'Bo' }));

  check('and game.players is the fallback',
    JSON.stringify(rosterFrom({ t: 'state', game: { players: [{ id: 'c', name: 'Cy' }] } }, you))
      === JSON.stringify({ c: 'Cy' }));

  check('`peers` wins when a frame carries more than one',
    JSON.stringify(rosterFrom({ peers: [{ vaultId: 'a', name: 'Ana' }], lobby: { members: [{ vaultId: 'b', name: 'Bo' }] } }, you))
      === JSON.stringify({ a: 'Ana' }));

  check('bots are never dialled',
    JSON.stringify(rosterFrom({ peers: [{ vaultId: 'bot1', name: 'Botty', isBot: true }, { vaultId: 'a', name: 'Ana' }] }, you))
      === JSON.stringify({ a: 'Ana' }),
    'a bot has no microphone; offering to one is a connection that never completes');

  check('you are never in your own roster',
    rosterFrom({ peers: [{ vaultId: you, name: 'Me' }] }, you) !== null
      && Object.keys(rosterFrom({ peers: [{ vaultId: you, name: 'Me' }] }, you)!).length === 0);

  check('a nameless player falls back to their id',
    rosterFrom({ peers: [{ vaultId: 'a' }] }, you)?.a === 'a');

  check('a frame with no roster at all is ignored, not treated as an empty table',
    rosterFrom({ t: 'event', msg: 'hi' }, you) === null,
    'returning {} here would tear down every peer connection on every toast');

  const prev = { a: 'Ana', b: 'Bo' };
  const next = { b: 'Bo', c: 'Cy' };
  const d = diffRoster(prev, next);
  check('leavers and joiners are both spotted', d.gone.join() === 'a' && d.added.join() === 'c');
  check('an unchanged roster changes nothing',
    diffRoster(prev, { ...prev }).added.length === 0 && diffRoster(prev, { ...prev }).gone.length === 0);
}

console.log('\nICE buffering\n');
{
  const q = new IceQueue();
  check('a candidate before the answer is held, not applied', q.accept({ c: 1 }) === false);
  check('...and so is the next one', q.accept({ c: 2 }) === false);
  check('nothing is ready yet', q.ready === false);

  const flushed = q.flush();
  check('the remote description releases them all', flushed.length === 2);
  check('...in arrival order', (flushed[0] as any).c === 1 && (flushed[1] as any).c === 2,
    'out-of-order candidates make ICE pair checks fail in ways that only show on some networks');
  check('now ready', q.ready === true);
  check('later candidates go straight through', q.accept({ c: 3 }) === true);
  check('a second flush releases nothing twice', q.flush().length === 0);

  q.reset();
  check('reset closes it again so a dead peer cannot be fed', q.ready === false && q.accept({ c: 4 }) === false);
}

console.log('\nSpeaking levels\n');
{
  const stats = [
    { type: 'inbound-rtp', kind: 'audio', audioLevel: 0.31 },
    { type: 'inbound-rtp', kind: 'video' },
    { type: 'media-source', audioLevel: 0.07 },
  ];
  check('an inbound audio level is found', audioLevelFrom(stats, 'inbound-rtp') === 0.31);
  check('our own microphone level is found', audioLevelFrom(stats, 'media-source') === 0.07);
  check('a platform that reports no levels returns null, not zero',
    audioLevelFrom([{ type: 'inbound-rtp', kind: 'audio' }], 'inbound-rtp') === null,
    'zero would read as "definitely silent"; null means "show no rings at all"');
  check('empty stats are null', audioLevelFrom([], 'inbound-rtp') === null);
  check('a silent open mic is below the speaking threshold', 0.004 < SPEAKING_LEVEL);
  check('normal speech is above it', 0.2 > SPEAKING_LEVEL);
}

// A FULL TABLE, NOT JUST A PAIR.
//
// Rummy seats 6 and ludo seats 4, and the mesh is full — so a rummy table is 5
// peer connections per phone and 15 across the table. Everything below is
// already true of `shouldInitiate` (it is a total order on the ids, so every
// pair has exactly one initiator at any size); what was missing was the
// assertion. Voice for a full table was asked about directly, and "it should
// scale" is not an answer anyone can check.
console.log('\nA full table meshes every seat\n');
{
  /** Every unordered pair gets exactly one initiator, and nobody dials themselves. */
  const meshes = (ids: string[]) => {
    let dialled = 0;
    for (const a of ids) {
      if (shouldInitiate(a, a)) return { ok: false, why: `${a} dials itself` };
      for (const b of ids) {
        if (a >= b) continue;                       // consider each pair once
        const one = shouldInitiate(a, b);
        const other = shouldInitiate(b, a);
        if (one === other) return { ok: false, why: `${a}/${b} both ${one ? 'dial' : 'wait'}` };
        dialled++;
      }
    }
    return { ok: true, dialled };
  };

  // Deliberately unsorted and mixed-case: seat order is arrival order, and the
  // ids are server-issued, so a rule that only works on tidy input is no rule.
  const rummy6 = ['v9', 'v2', 'aa', 'Zz', 'v10', 'b7'];
  const r = meshes(rummy6);
  check('rummy: 6 seats, every pair has exactly one initiator', r.ok, (r as any).why);
  check('rummy: that is 15 connections across the table', (r as any).dialled === 15,
    `${(r as any).dialled}`);
  check('rummy: each player holds 5 of them',
    rummy6.every(me => rummy6.filter(o => o !== me).length === 5));

  const ludo4 = ['p3', 'p1', 'p4', 'p2'];
  const l = meshes(ludo4);
  check('ludo: 4 seats, every pair has exactly one initiator', l.ok, (l as any).why);
  check('ludo: that is 6 connections across the table', (l as any).dialled === 6,
    `${(l as any).dialled}`);

  // Nobody may be left out: every seat is either dialling or being dialled by
  // each other seat. A player with no leg at all is silent to everyone and the
  // symmetry check above would not notice on its own.
  check('no seat is left undialled at 6',
    rummy6.every(me => rummy6.filter(o => o !== me)
      .every(o => shouldInitiate(me, o) || shouldInitiate(o, me))));

  // Bots have no microphone, and offering to yourself never completes.
  const table = {
    lobby: { members: [
      { vaultId: 'v1', name: 'You' },
      { vaultId: 'v2', name: 'Asha' },
      { vaultId: 'b1', name: 'Robo 1', isBot: true },
      { vaultId: 'v3', name: 'Ravi' },
      { vaultId: 'b2', name: 'Robo 2', isBot: true },
      { vaultId: 'v4', name: 'Meera' },
    ] },
  };
  const seats = rosterFrom(table, 'v1');
  check('a mixed 6-seat table meshes only the humans', !!seats && Object.keys(seats!).length === 3,
    `${seats ? Object.keys(seats!).join(',') : 'null'}`);
  check('...and never the bots', !!seats && !('b1' in seats!) && !('b2' in seats!));
  check('...and never yourself', !!seats && !('v1' in seats!));
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all voice-mesh checks passed\n');
process.exit(failures ? 1 : 0);
