// lib/call/callControls.selftest.ts — the in-call controls that were inert.
//
//   npx tsx lib/call/callControls.selftest.ts
//
// SCOPE: STRUCTURAL. Reads source and asserts the wiring. It renders nothing
// and starts no call, so it proves the code is there, not that it looks right.
// Device verification stays separate.
//
// Four reported defects, four different silent-failure shapes.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const uncomment = (src: string) =>
  src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROOM   = uncomment(readFileSync(join(ROOT, 'lib/call/room.ts'), 'utf8'));
const ENGINE = uncomment(readFileSync(join(ROOT, 'lib/call/engine.ts'), 'utf8'));
const MACH   = uncomment(readFileSync(join(ROOT, 'lib/call/machine.ts'), 'utf8'));
const SHEET  = uncomment(readFileSync(join(ROOT, 'components/call/CallChatSheet.tsx'), 'utf8'));
const VIDEO  = uncomment(readFileSync(join(ROOT, 'app/videocall.tsx'), 'utf8'));
const VOICE  = uncomment(readFileSync(join(ROOT, 'app/voicecall.tsx'), 'utf8'));

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nIn-call controls\n');

// ── 1. FLIP CAMERA ────────────────────────────────────────────────────
//
// _switchCamera() picks its direction from its OWN state:
//   constraints.facingMode = this._settings.facingMode === 'user' ? ... : 'user'
// LiveKit creates the camera track with no explicit facingMode, so
// _settings.facingMode is undefined, `undefined === 'user'` is false, and every
// press asked for 'user' — the front camera, forever. It is @deprecated too.
{
  A(!/_switchCamera/.test(ROOM),
    '1. flipCamera no longer calls the deprecated _switchCamera — it derived '
    + 'direction from an undefined facingMode and never actually flipped');
  A(/let facing: 'user' \| 'environment'/.test(ROOM),
    '1a. the room tracks facing itself, so a press is an explicit request');
  A(/facing === 'user' \? 'environment' : 'user'/.test(ROOM),
    '1b. and each press asks for the OTHER direction');
  A(/if \(switched\) facing = next;/.test(ROOM),
    '1c. facing advances only when a switch actually happened — otherwise the '
    + 'next press would ask for the direction we are already pointing');
  A(/delete c\.deviceId/.test(ROOM),
    '1d. deviceId is dropped from the constraints — it pins the OLD camera and '
    + 'would override facingMode');
}

// ── 2. IN-CALL CHAT KEYBOARD ──────────────────────────────────────────
//
// behavior={Platform.OS === 'ios' ? 'padding' : undefined} makes
// KeyboardAvoidingView a plain View on Android. windowSoftInputMode=adjustResize
// does not rescue it: that resizes the ACTIVITY, and a RN <Modal> is its own
// window. The sheet is pinned bottom:0, so the keyboard covered the composer.
{
  A(!/KeyboardAvoidingView/.test(SHEET),
    '2. the chat sheet no longer relies on KeyboardAvoidingView — with an '
    + 'undefined Android behavior it did nothing at all');
  A(/Keyboard\.addListener/.test(SHEET),
    '2a. it measures the keyboard instead');
  A(/\{ bottom: kb \}/.test(SHEET),
    '2b. and lifts the sheet by that height, which needs no window flag');
  A(/keyboardWillShow/.test(SHEET) && /keyboardDidShow/.test(SHEET),
    '2c. Will events on iOS (moves with the animation), Did on Android '
    + '(the only ones it emits)');
  A(/if \(!visible\) setKb\(0\)/.test(SHEET),
    '2d. closing resets the offset, so it cannot reopen still lifted');
  A(/show\.remove\(\)/.test(SHEET), '2e. listeners are removed on unmount');
}

// ── 3. SENDER NAMES IN IN-CALL CHAT ───────────────────────────────────
//
// The join response carries a name per participant; the join loop dispatched
// role and hand only. participants[uid].name stayed '' and peerNameOf fell
// through to the literal 'Participant' for everyone in a group.
{
  A(/\| \{ type: 'peer_name'; uid: string; name: string \}/.test(MACH),
    '3. a peer_name action exists');
  A(/case 'peer_name'/.test(MACH), '3a. and the reducer handles it');
  A(/withParticipant\(s, e\.uid, \{ name: e\.name \}\)/.test(MACH),
    '3b. writing the name onto the participant record');
  A(/type: 'peer_name', uid: p\.userId/.test(ENGINE),
    '3c. the JOIN loop dispatches it — everyone already on the call');
  A(/type: 'peer_name', uid: joined\.identity/.test(ENGINE),
    '3d. and so does the joined handler — a LATE joiner is not in the join '
    + 'response, and would otherwise chat as "Participant"');
}

// ── 4. THE CONTROLS THEMSELVES ────────────────────────────────────────
{
  A(!/icon="sparkles"[^\n]*onPress=\{toggleFilters\}/.test(
    VIDEO.slice(VIDEO.indexOf('function VideoCallEngine'), VIDEO.indexOf('VideoCallLegacy'))),
  '4. Beauty is gone from the video call control strip (requested)');

  for (const [name, src] of [['videocall', VIDEO], ['voicecall', VOICE]] as const) {
    A(/style=\{\[S\.addTopBtn, \{ top: insets\.top \+ 8 \}\]\}/.test(src),
      `4a. ${name} mounts the Add button top-left`);
    A(/addTopBtn:\s*\{ position: 'absolute', left: 16/.test(src),
      `4b. ${name} anchors it to the LEFT edge`);
    A(/onPress=\{addPerson\}/.test(src), `4c. ${name} wires it to addPerson`);
  }

  // topBar is pointerEvents="none" so the name/timer never eat a tap — which
  // also means a button placed inside it could never BE tapped.
  const bar = VIDEO.indexOf('S.topBar');
  const btn = VIDEO.indexOf('S.addTopBtn');
  A(bar >= 0 && btn > bar,
    '4d. videocall mounts Add OUTSIDE topBar — topBar is pointerEvents="none", '
    + 'so a child of it would be untappable');
}

// ── 5. GROUP SCREEN SHARE HAD NO INDICATION ──────────────────────────
//
// The share always arrived — the tile URL prefers screens.get(uid) over the
// camera — but the group grid gave no sign it had happened, so a working share
// read as "screen share is not working". The 1:1 flag cannot serve a group:
// peerSharing is dispatched only when s.peerUid === uid, so it is permanently
// false there. Participants carry their own `sharing` instead.
{
  const GROUP = uncomment(readFileSync(join(ROOT, 'app/group-call-active.tsx'), 'utf8'));
  const HOOKS = uncomment(readFileSync(join(ROOT, 'hooks/useCall.ts'), 'utf8'));
  const TYPES = uncomment(readFileSync(join(ROOT, 'lib/call/types.ts'), 'utf8'));

  A(/sharing: boolean;/.test(TYPES), '5. Participant carries a per-uid sharing flag');
  A(/\| \{ type: 'peer_sharing'; uid: string; sharing: boolean \}/.test(MACH),
    '5a. a peer_sharing action exists');
  A(/case 'peer_sharing'/.test(MACH), '5b. and the reducer handles it');
  A(/prev\.sharing === next\.sharing/.test(MACH),
    '5c. the no-op comparison includes sharing — without it the reducer returns '
    + 'the OLD participants reference and the banner never appears');
  A(/type: 'peer_sharing', uid, sharing: screens\.has\(uid\)/.test(ENGINE),
    '5d. dispatched for EVERY uid, not just the 1:1 peer');
  A(/key: 'peerSharing', value: screens\.has\(uid\)/.test(ENGINE),
    '5e. and the 1:1 peerSharing flag is UNCHANGED — the video screen keeps '
    + 'its existing banner behaviour');
  A(/export function useSharingPeer/.test(HOOKS), '5f. useSharingPeer exists');
  A(/key\.indexOf\('\|'\)/.test(HOOKS),
    '5g. it splits on the FIRST separator — a display name may contain "|"');
  A(/useSharingPeer\(\)/.test(GROUP) && /is sharing their screen/.test(GROUP),
    '5h. the group screen renders a banner naming the sharer');
}

console.log(failed === 0
  ? '\ncallControls: all checks passed'
  : `\ncallControls: ${failed} FAILED`);
if (failed > 0) process.exit(1);
