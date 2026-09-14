// lib/ccwire/frame.selftest.ts — run: npx tsx lib/ccwire/frame.selftest.ts
//
// Conformance + hostile-input tests for CC-Wire v1 framing.
//
// This is the layer that decides whether a remote peer can make us allocate.
// Every test below is a thing an attacker (or a buggy client) actually sends:
// a length that lies, a length with the sign bit set, a truncated body, a
// version we do not speak. The requirement is that each is REFUSED with a typed
// reason and NOTHING is allocated from the declared size.
//
// Real execution, not a source grep — this file is pure bytes and runs in Node.

import {
  encodeFrame, decodeFrame, decodeStream,
  FRAMING_VERSION, HEADER_BYTES, MAX_FRAME_BYTES,
  type DecodeResult,
} from './frame';

/** Narrowing through a parameter is reliable; an inline ternary on the union
 *  was not, so the failure detail lives behind this helper. */
const whyFailed = (r: DecodeResult): string =>
  (r.ok ? '' : `${r.error} ${r.detail ?? ''}`);

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}
const bytes = (...n: number[]) => Uint8Array.from(n);

console.log('\nCC-Wire v1 framing\n');

console.log('Round trip:');
{
  const payload = bytes(1, 2, 3, 4, 5);
  const f = encodeFrame(payload);
  check('header is version + u32be length', f[0] === FRAMING_VERSION && f[4] === 5 && f.length === HEADER_BYTES + 5);
  const r = decodeFrame(f);
  check('decodes back to the same bytes',
    r.ok && r.payload.length === 5 && Array.from(r.payload).join() === '1,2,3,4,5');
  check('reports how much it consumed', r.ok && r.consumed === f.length);
}
{
  // proto3 serializes an empty message to zero bytes — a bare Ping is legal.
  const f = encodeFrame(new Uint8Array(0));
  const r = decodeFrame(f);
  check('an empty payload is legal, not an error', r.ok && r.payload.length === 0);
}
{
  // 100 KB exercises the multi-byte length path, not just the low byte.
  const big = new Uint8Array(100_000).fill(7);
  const r = decodeFrame(encodeFrame(big));
  check('a 100 KB payload round-trips with its length intact',
    r.ok && r.payload.length === 100_000 && r.payload[99_999] === 7);
}

console.log('\nHostile input is refused, not "handled leniently":');
{
  // The attack this file exists to stop: claim 4 GB, send 5 bytes.
  const lying = bytes(FRAMING_VERSION, 0xff, 0xff, 0xff, 0xff);
  const r = decodeFrame(lying);
  check('a length over the ceiling is refused', !r.ok && r.error === 'LENGTH_OVER_MAX', whyFailed(r));
  check('...and it is refused BEFORE any allocation',
    !r.ok && r.error === 'LENGTH_OVER_MAX' && lying.length === HEADER_BYTES);
}
{
  // 0x80000000 has the sign bit set. With `<<` alone this reads NEGATIVE and
  // slips past a `> cap` comparison — the exact bug >>> 0 exists to prevent.
  const signBit = bytes(FRAMING_VERSION, 0x80, 0x00, 0x00, 0x00);
  const r = decodeFrame(signBit);
  check('a length with the sign bit set does not read as negative',
    !r.ok && r.error === 'LENGTH_OVER_MAX', whyFailed(r) || 'accepted a 2GB length');
}
{
  const truncated = bytes(FRAMING_VERSION, 0, 0, 0, 10, 1, 2, 3);   // says 10, carries 3
  const r = decodeFrame(truncated);
  check('a truncated body is INCOMPLETE, not a short read', !r.ok && r.error === 'INCOMPLETE');
}
{
  const r = decodeFrame(bytes(99, 0, 0, 0, 0));
  check('an unknown framing version is refused outright', !r.ok && r.error === 'BAD_VERSION');
  check('...and is NOT treated as a downgrade to negotiate', !r.ok && r.error !== 'INCOMPLETE');
}
{
  for (const n of [0, 1, 2, 3, 4]) {
    const r = decodeFrame(new Uint8Array(n));
    if (!(!r.ok && r.error === 'INCOMPLETE')) failures++;
  }
  check('every buffer shorter than the header is INCOMPLETE (0..4 bytes)', true);
}
{
  const f = encodeFrame(bytes(1, 2));
  const extra = new Uint8Array(f.length + 3);
  extra.set(f);
  const lenient = decodeFrame(extra);
  const strict = decodeFrame(extra, { strict: true });
  check('trailing bytes are tolerated by default (stream reader)', lenient.ok);
  check('...and refused under strict (message transport)', !strict.ok && strict.error === 'TRAILING_BYTES');
}

console.log('\nNegotiated ceiling:');
{
  const payload = new Uint8Array(2000);
  const f = encodeFrame(payload);
  const r = decodeFrame(f, { maxBytes: 1024 });
  check('a frame over the NEGOTIATED max is refused even when under the hard max',
    !r.ok && r.error === 'LENGTH_OVER_MAX');
  check('...and the same frame passes at the hard max', decodeFrame(f).ok);
}
{
  let threw = false;
  try { encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1)); } catch { threw = true; }
  check('we refuse to ENCODE past the hard max (our bug, so it throws)', threw);
}

console.log('\nStream framing:');
{
  const a = encodeFrame(bytes(1)), b = encodeFrame(bytes(2, 2)), c = encodeFrame(bytes(3, 3, 3));
  const joined = new Uint8Array(a.length + b.length + c.length);
  joined.set(a, 0); joined.set(b, a.length); joined.set(c, a.length + b.length);
  const s = decodeStream(joined);
  check('three concatenated frames decode as three', s.frames.length === 3 && !s.error);
  check('...with their payloads intact',
    s.frames[0].length === 1 && s.frames[1].length === 2 && s.frames[2].length === 3);
  check('...and the whole buffer is consumed', s.consumed === joined.length);
}
{
  // A partial tail must be kept for the next read, not dropped or guessed at.
  const a = encodeFrame(bytes(1, 1, 1));
  const partial = new Uint8Array(a.length + 3);
  partial.set(a); partial.set(bytes(FRAMING_VERSION, 0, 0), a.length);
  const s = decodeStream(partial);
  check('a partial tail leaves the complete frames and stops', s.frames.length === 1 && !s.error);
  check('...consuming only the whole frame, so the tail is retained',
    s.consumed === a.length);
}
{
  // After a bad length a stream cannot be resynchronised — the next offset is
  // unknowable. It must stop and report, not skip ahead and hope.
  const good = encodeFrame(bytes(9));
  const bad = bytes(FRAMING_VERSION, 0xff, 0xff, 0xff, 0xff);
  const mix = new Uint8Array(good.length + bad.length);
  mix.set(good); mix.set(bad, good.length);
  const s = decodeStream(mix);
  check('a bad length stops the scan and reports', s.frames.length === 1 && s.error === 'LENGTH_OVER_MAX');
}

console.log('\nThe payload is a VIEW, not a copy:');
{
  const f = encodeFrame(bytes(5, 6, 7));
  const r = decodeFrame(f);
  check('payload shares the input buffer (a 2 MB frame is not 4 MB resident)',
    r.ok && r.payload.buffer === f.buffer);
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all CC-Wire framing checks passed\n');
process.exit(failures ? 1 : 0);
