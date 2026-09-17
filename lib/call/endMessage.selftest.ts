// lib/call/endMessage.selftest.ts — run: npx tsx lib/call/endMessage.selftest.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { endMessage } from './endMessage';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

// SILENCE IS THE POINT for endings the user asked for. If these ever start
// returning text, every normal hang-up pops a dialog and people learn to
// dismiss the one that matters without reading it.
ok('ending the call yourself says nothing', endMessage('local_hangup', null) === null);
ok('the other side hanging up says nothing', endMessage('remote_hangup', null) === null);
ok('a replaced call says nothing, the new one is on screen', endMessage('replaced', null) === null);
ok('no reason at all says nothing', endMessage(null, null) === null);

// The endings the user did not ask for have to explain themselves.
ok('a rang-out call says so', endMessage('no_answer', null) === 'No answer.');
ok('a dropped call blames the connection', (endMessage('failed', null) ?? '').includes('connection'));
ok('setup failure prefers the engine text', endMessage('setup_error', 'Microphone permission denied') === 'Microphone permission denied');
ok('setup failure falls back when there is no text', endMessage('setup_error', null) === 'The call could not be started.');
ok('blank engine text does not surface as an empty dialog', endMessage('setup_error', '   ') === 'The call could not be started.');

// Every abnormal reason must produce something; an unexplained failure is the
// bug this exists to close.
for (const r of ['no_answer', 'failed', 'setup_error'] as const) {
  ok(`${r} is never silent`, (endMessage(r, null) ?? '').length > 0);
}

// ...and the screens must actually call it. A pure helper nothing invokes is
// exactly the state endReason was already in.
for (const f of ['app/videocall.tsx', 'app/voicecall.tsx', 'app/group-call-active.tsx']) {
  const src = fs.readFileSync(f, 'utf8');
  ok(`${f} imports endMessage`, src.includes("call/endMessage'"));
  ok(`${f} shows it when the call ends`, /const why = endMessage\(/.test(src) && /if \(why\) Alert\.alert\(/.test(src));
}

console.log(`\nendMessage.selftest: ${n} assertions passed`);
