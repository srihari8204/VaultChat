// lib/call/turnWiring.selftest.ts — a call must be able to use the relay.
//
//   npx tsx lib/call/turnWiring.selftest.ts
//
// SCOPE: STRUCTURAL. It reads source and asserts the wiring exists. It opens no
// connection and gathers no candidates, so it proves the line is there, not that
// a relay works. Device verification stays separate.
//
// WHAT WENT WRONG, MEASURED ON DEVICE
//
// lib/call/room.ts called `room.connect(url, token, { autoSubscribe: true })`
// with no rtcConfig. livekit-client then used only the ICE servers the LiveKit
// SERVER advertises — and livekit/livekit.yaml sets `turn: enabled: false`,
// deliberately, so the host's coturn could be reused instead of LiveKit's
// embedded relay. Nothing ever told the SFU client about that coturn.
//
// The result, counted from a real device log:
//
//     typ host   42
//     typ srflx  19
//     typ relay   0      <-- no relay path at all
//
// It worked anyway, because on that network server-reflexive candidates were
// enough. That is exactly what made it dangerous: the hole is invisible until
// someone is behind a symmetric NAT — carrier-grade NAT, some corporate wifi —
// where relay is the ONLY thing that connects. For them the call would never
// come up, and every other user would report it working fine.
//
// lib/golive/room.ts has passed rtcConfig since it was written, and has its own
// turnWiring selftest. The calling path simply never got the same line. This
// file is the calling half of that guard.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const ROOM = strip(readFileSync(join(ROOT, 'lib/call/room.ts'), 'utf8'));
const GOLIVE = strip(readFileSync(join(ROOT, 'lib/golive/room.ts'), 'utf8'));

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nCall TURN wiring\n');

// ── 1. the call path asks for ice servers ─────────────────────────────
A(/getIceServers/.test(ROOM), '1. room.ts imports and calls getIceServers');

// ── 2. and actually hands them to connect ─────────────────────────────
{
  const m = ROOM.match(/room\.connect\([^)]*\)/s);
  A(!!m, '2. room.connect() is called');
  const call = m ? m[0] : '';
  A(/rtcConfig/.test(call),
    '2a. connect() receives rtcConfig — WITHOUT this the SDK uses only the ICE '
    + 'servers the LiveKit server advertises, and livekit.yaml has turn disabled');
  A(/iceServers/.test(call), '2b. and rtcConfig carries iceServers');
}

// ── 3. exactly one connect, so the wired one is the one that runs ─────
A((ROOM.match(/room\.connect\(/g) || []).length === 1,
  '3. exactly one room.connect() — a second, unwired one would silently win');

// ── 4. fetched BEFORE the Room is built, so the round trip overlaps ───
{
  const fetchAt = ROOM.indexOf('getIceServers()');
  const roomAt  = ROOM.indexOf('new Room(');
  A(fetchAt >= 0 && roomAt >= 0 && fetchAt < roomAt,
    '4. the fetch starts before new Room() — it overlaps setup instead of '
    + 'adding a round trip to how long answering takes');
}

// ── 5. the awaited value is the promise started earlier ───────────────
A(/const iceServers = await iceServersPromise;/.test(ROOM),
  '5. connect awaits the pre-started promise, not a fresh call');

// ── 6. go live still has its copy (both paths, or neither is safe) ────
A(/rtcConfig/.test(GOLIVE), '6. lib/golive/room.ts still passes rtcConfig too');

console.log(failed === 0 ? '\nturnWiring: all checks passed' : `\nturnWiring: ${failed} FAILED`);
if (failed > 0) process.exit(1);
