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

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all voice-mesh checks passed\n');
process.exit(failures ? 1 : 0);
