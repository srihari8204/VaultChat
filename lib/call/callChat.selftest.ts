// lib/call/callChat.selftest.ts — in-call chat reaches the group, and stays E2EE.
//
//   npx tsx lib/call/callChat.selftest.ts
//
// SCOPE, STATED PLAINLY: PART BEHAVIOURAL, PART STRUCTURAL. chatRecipients is a
// pure function and is really executed. The encryption and fan-out claims are
// read out of the source, because sealing needs the native E2EE session and a
// socket — so this proves the WIRING is right, never that a device encrypts.
// Device verification remains separate.
//
// WHY IT EXISTS
//
// In-call chat and reactions were INERT in every group call, and invisibly so:
// `sendChat` opened with `if (!s || s.disposed || !body || !s.peerUid) return`,
// and a group session's peerUid is empty BY CONSTRUCTION. The UI accepted a
// message, echoed it locally so the sender saw it appear, and sent it nowhere.
// Nothing failed. Nothing logged. The only symptom was other people not
// replying, which reads as other people not replying.
//
// The second half is the guarantee. Group MEDIA gave up end-to-end encryption
// (owner decision 2026-08-16); text did not, and must not be quietly folded
// into that decision because it travels alongside it. The cheap implementation
// — one plaintext emit the server fans out — is the one this file exists to
// refuse.

import { readFileSync } from 'fs';
import { join } from 'path';
// From ./mode, not ./engine: engine.ts imports react-native and cannot be
// loaded by tsx at all. That is exactly why the rule was moved into the pure
// module — a rule nothing can execute is a rule nothing can check.
import { chatRecipients } from './mode';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const ENGINE = strip(readFileSync(join(ROOT, 'lib/call/engine.ts'), 'utf8'));

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}



console.log('\nIn-call chat — group delivery and E2EE\n');

// ── 1. recipients ─────────────────────────────────────────────────────
{
  const roster = { me: {}, alice: {}, bob: {}, carol: {} };

  const ids = Object.keys(roster);

  A(JSON.stringify(chatRecipients('alice', 'me', ids)) === '["alice"]',
    '1. 1:1 seals for the peer, and only the peer');

  const group = chatRecipients('', 'me', ids);
  A(group.length === 3 && !group.includes('me'),
    '1a. a GROUP seals for everyone on the call except me');
  // THE REGRESSION THIS FILE EXISTS FOR.
  A(chatRecipients('', 'me', ids).length > 0,
    '1b. a group call has recipients AT ALL — an empty list here is the bug '
    + 'that made group chat inert, and it failed silently');

  A(chatRecipients('', 'me', ['me']).length === 0,
    '1c. alone in a call, nobody is sealed for (no self-send)');
  A(chatRecipients('', 'me', []).length === 0, '1d. an empty roster is not a crash');
}

// ── 2. the send path is not gated on peerUid ──────────────────────────
{
  const send = ENGINE.slice(ENGINE.indexOf('export function sendChat'));
  const chatFn = send.slice(0, send.indexOf('export function sendReaction'));
  A(!/!s\.peerUid/.test(chatFn),
    '2. sendChat does NOT early-return on an empty peerUid — that guard is what '
    + 'made every group message vanish');
  const react = ENGINE.slice(ENGINE.indexOf('export function sendReaction'));
  A(!/!s\.peerUid/.test(react.slice(0, react.indexOf('export function markChatRead'))),
    '2a. nor does sendReaction');
  A(/sealAndFanOut\(s, body/.test(chatFn), '2b. sendChat goes through the fan-out');
}

// ── 3. the guarantee: sealed per recipient, never broadcast plaintext ─
{
  A(/async function sealAndFanOut/.test(ENGINE), '3. a per-recipient fan-out exists');
  const fan = ENGINE.slice(ENGINE.indexOf('async function sealAndFanOut'));
  const body = fan.slice(0, fan.indexOf('export function sendChat'));
  A(/sealForPeer\(to, body\)/.test(body),
    '3a. every recipient gets its OWN seal — the pairwise ratchet, per peer');
  A(/allSettled/.test(body),
    '3b. allSettled, so one peer with no session cannot silence the message for '
    + 'everyone else');
  // If a future change ever routes call text through a server fan-out, the
  // ciphertext-only property is gone and this is where it gets caught.
  A(!/sendCallChat\(\s*['"]/.test(ENGINE) && !/callId:.*chat/i.test(body),
    '3c. text is addressed PER PEER, not handed to a server fan-out');
}

// ── 4. only people IN the call may speak into it ──────────────────────
{
  A(/accept: \(from\) => \(s\.peerUid \? from === s\.peerUid : !!getSnapshot\(\)\.participants\[from\]\)/.test(ENGINE),
    '4. a group accepts messages only from live participants, not from any '
    + 'account that knows the chat');
}

console.log(failed === 0 ? '\ncallChat: all checks passed' : `\ncallChat: ${failed} FAILED`);
if (failed > 0) process.exit(1);
