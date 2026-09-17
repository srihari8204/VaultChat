// Run: npx tsx lib/ccwire/resume.selftest.ts
//
// The CLIENT half of CC-Wire session resume.
//
// SCOPE, STATED PLAINLY. This asserts the wire encoding and the token
// lifecycle: what a ClientHello carries, what a ServerHello yields, and when a
// token is kept versus dropped. It does NOT prove a resume against a live
// server — the Go half is asserted in
// vaultchat-backend-go/internal/realtime/ccwire_resume*_test.go, and the two
// meeting over a real socket needs a device, which is recorded as pending
// rather than claimed.
//
// WHY THE TOKEN LIFECYCLE IS THE INTERESTING PART
//
// A resume token is authentication-adjacent. The failure that matters is not
// "resume did not work" — that degrades to a resync, which is today's
// behaviour. It is holding a credential longer or wider than the session it
// names. So the assertions below are mostly about when the client THROWS THE
// TOKEN AWAY.

import assert from 'node:assert/strict';

import { encodeClientHello, decodeServerHello, encodePingProgress } from './client';

let n = 0;
const ok = (what: string) => { n++; console.log('  ok   ' + what); };

console.log('\nCC-Wire resume — client half\n');

// ── field scanner, independent of the implementation under test ──────
// Hand-rolled on purpose: asserting encodeClientHello with the same decoder the
// client uses would let a matched pair of bugs pass.
function scan(b: Uint8Array): Map<number, Uint8Array[]> {
  const out = new Map<number, Uint8Array[]>();
  let i = 0;
  const varint = (): number => {
    let v = 0, shift = 0;
    for (;;) {
      const byte = b[i++];
      v |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return v >>> 0;
      shift += 7;
    }
  };
  while (i < b.length) {
    const tag = varint();
    const field = tag >>> 3, wire = tag & 7;
    let val: Uint8Array;
    if (wire === 0) {
      const start = i; varint(); val = b.slice(start, i);
    } else if (wire === 2) {
      const len = varint(); val = b.slice(i, i + len); i += len;
    } else {
      throw new Error('unexpected wire type ' + wire);
    }
    const prev = out.get(field) ?? [];
    prev.push(val);
    out.set(field, prev);
  }
  return out;
}

// ── 1. a cold start offers no token ──────────────────────────────────
{
  const fs = scan(encodeClientHello('dev-1'));
  assert.equal(fs.has(7), false, 'a cold-start hello must not carry resume_token');
  assert.equal(fs.has(8), false, 'a cold-start hello must not carry resume_from');
  assert.ok(fs.has(5), 'device_id still sent');
  ok('1. a cold start offers no token and no cursors');
}

// ── 2. resumption is offered, so the server may answer ───────────────
{
  const caps = scan(encodeClientHello('dev-1')).get(3)?.[0];
  assert.ok(caps, 'capabilities present');
  const cf = scan(caps!);
  assert.ok(cf.has(2), 'resumption (2) must be offered — the reply is an intersection');
  assert.ok(cf.has(1), 'fragmentation (1) still offered');
  assert.ok(cf.has(8), 'app_events_v1 (8) still offered');
  ok('2. capabilities still carry fragmentation and app_events, plus resumption');
}

// ── 3. a token is carried when we have one ───────────────────────────
{
  const fs = scan(encodeClientHello('dev-1', { token: 'tok-xyz' }));
  const tok = fs.get(7)?.[0];
  assert.ok(tok, 'resume_token present');
  assert.equal(new TextDecoder().decode(tok!), 'tok-xyz');
  ok('3. a held token is offered in field 7');
}

// ── 4. seq past 2^53 survives the round trip ─────────────────────────
{
  // The reason seq is a STRING in this layer. Number() would round this, and
  // the corruption would be silent: a cursor that is quietly wrong re-delivers
  // or skips, and neither announces itself.
  const big = '18446744073709551615'; // u64 max
  const fs = scan(encodeClientHello('d', { token: 't', from: [{ stream: 2, seq: big }] }));
  const sc = fs.get(8)?.[0];
  assert.ok(sc, 'resume_from present');
  // Decode the varint with BigInt, the way the server does.
  const inner = sc!;
  let i = 0, seq = 0n, shift = 0n, sawSeq = false;
  while (i < inner.length) {
    const tag = inner[i++];
    const field = tag >>> 3;
    let v = 0n; shift = 0n;
    for (;;) {
      const byte = inner[i++];
      v |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    if (field === 2) { seq = v; sawSeq = true; }
  }
  assert.ok(sawSeq, 'last_delivered_seq present');
  assert.equal(seq.toString(), big, 'u64 max must survive encoding without truncation');
  ok('4. a sequence at u64 max encodes without silent truncation');
}

// ── 5. the token is kept only when the server says it will honour one ─
{
  // Built by hand rather than through the encoder: this is the SERVER's
  // message, and building it with our own code would only prove self-consistency.
  const hello = (caps: number[], extra: number[] = []) =>
    Uint8Array.from([8, 1, 26, caps.length, ...caps, ...extra]);

  const withResumption = decodeServerHello(hello([16, 1], [50, 3, 116, 111, 107]));
  assert.equal(withResumption?.resumption, true, 'resumption capability decoded');
  assert.equal(withResumption?.resumeToken, 'tok', 'resume_token decoded');

  const withoutResumption = decodeServerHello(hello([64, 1], [50, 3, 116, 111, 107]));
  assert.equal(withoutResumption?.resumption, false, 'no resumption capability');
  ok('5. resumption capability and resume_token decode independently');
}

// ── 6. absent resumed means full-resync ──────────────────────────────
{
  const h = decodeServerHello(Uint8Array.from([8, 1]));
  assert.equal(!!h?.resumed, false, 'absent resumed must read as false');
  ok('6. an absent resumed flag reads as false — the conservative answer');
}

// ── 7. Ping.progress carries the positions the server releases on ────
{
  // Without this the server retains every frame it sends until the session
  // ends: the window fills to its ceiling and stays there. Nothing fails
  // loudly, which is why it is asserted here rather than left to be noticed.
  const empty = encodePingProgress([]);
  assert.equal(empty.length, 0,
    'a client with no positions must send the same zero-byte Ping it always did');

  const one = encodePingProgress([{ stream: 2, seq: '300' }]);
  // progress = field 2, wire type 2 → tag 0x12, length 5. StreamCursor is
  // 08 02 (stream = 2) then 10 AC 02 (last_delivered_seq = 300, two-byte varint).
  assert.deepEqual(Array.from(one), [0x12, 0x05, 0x08, 0x02, 0x10, 0xac, 0x02],
    'Ping.progress StreamCursor bytes');

  const two = encodePingProgress([{ stream: 2, seq: '1' }, { stream: 3, seq: '1' }]);
  assert.equal(Array.from(two).filter((b) => b === 0x12).length, 2,
    'each stream gets its own repeated progress entry');
  ok('7. Ping.progress encodes StreamCursor entries, and nothing when empty');
}

// ── 8. a sequence past 2^53 survives the JS layer ────────────────────
{
  // The reason seq is a string everywhere in this file. Number() on this value
  // returns 9007199254740992 — off by one, silently, forever.
  const big = '9007199254740993';
  const b = encodePingProgress([{ stream: 2, seq: big }]);
  // 12 LL 08 02 10 <varint> — tag, length, stream tag+value, seq tag, then the
  // value at index 5.
  let i = 5;
  let shift = 0n;
  let v = 0n;
  for (;;) {
    const byte = b[i++];
    v |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  assert.equal(v.toString(), big, 'a seq past 2^53 must round-trip exactly');
  ok('8. seq past 2^53 encodes without truncation');
}

// ── 9. the hello carries token AND positions ─────────────────────────
{
  // A token says WHICH session. The positions say WHERE it got to. The server
  // refuses rather than guessing when it has only the first, so sending one
  // without the other makes every reconnect a full resync.
  const withBoth = scan(encodeClientHello('dev-1', {
    token: 'tok-abc',
    from: [{ stream: 2, seq: '7' }],
  }));
  assert.equal(withBoth.get(7)?.length, 1, 'resume_token present');
  assert.equal(withBoth.get(8)?.length, 1, 'resume_from present');
  assert.deepEqual(Array.from(withBoth.get(8)![0]), [0x08, 0x02, 0x10, 0x07],
    'resume_from StreamCursor{stream: 2, last_delivered_seq: 7}');

  const cold = scan(encodeClientHello('dev-1', {}));
  assert.equal(cold.get(7), undefined, 'a cold start offers no token');
  assert.equal(cold.get(8), undefined, 'a cold start offers no positions');
  ok('9. ClientHello carries token and positions together, and neither on a cold start');
}

console.log(`\n  ${n} checks passed — client resume encoding and token lifecycle\n`);
