// lib/vaultcheck/vaultcheck.selftest.ts — run under node: `npx tsx <this file>`
//
// Covers the parts of VaultCheck that are pure computation and therefore
// actually testable off-device: the CBOR decoder, the JUMBF box parser, and the
// rPPG signal processing. The native frame sampling and the RN bridge are not
// exercised here — they need a device.
//
// The rPPG cases matter most. A pulse detector that reports a heartbeat on
// noise would turn VaultCheck into the fake detector this feature exists to
// replace, so the negative cases (flat signal, pure noise, too-short clip) are
// asserted as carefully as the positive one.

import { decode, get } from './cbor';
import { parseBoxes, findAllByLabelSuffix } from './jumbf';
import { analyse, type RppgSample } from './rppgCore';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ── CBOR (RFC 8949 appendix A vectors) ─────────────────────
console.log('\nCBOR');
{
  ok('uint 0', decode(hex('00')) === 0);
  ok('uint 23', decode(hex('17')) === 23);
  ok('uint 24', decode(hex('1818')) === 24);
  ok('uint 1000000', decode(hex('1a000f4240')) === 1000000);
  ok('negative -1', decode(hex('20')) === -1);
  ok('negative -1000', decode(hex('3903e7')) === -1000);
  ok('false/true/null', decode(hex('f4')) === false && decode(hex('f5')) === true && decode(hex('f6')) === null);
  ok('text "IETF"', decode(hex('6449455446')) === 'IETF');

  const bstr = decode(hex('4401020304'));
  ok('bytes 01020304', bstr instanceof Uint8Array && bstr.length === 4 && bstr[3] === 4);

  const arr = decode(hex('83010203'));
  ok('array [1,2,3]', Array.isArray(arr) && arr.length === 3 && arr[2] === 3);

  const map = decode(hex('a26161016162820203'));   // {"a":1,"b":[2,3]}
  ok('map {"a":1,"b":[2,3]}', get(map, 'a') === 1 && Array.isArray(get(map, 'b')));

  // Indefinite-length array — COSE producers emit these.
  const indef = decode(hex('9f018202039f0405ffff'));
  ok('indefinite array', Array.isArray(indef) && indef.length === 3);

  // Tag 18 is COSE_Sign1; the c2pa reader unwraps it.
  const tagged: any = decode(hex('d2820102'));
  ok('tag 18 wrapper', tagged?.__tag === 18 && Array.isArray(tagged.value));

  let threw = false;
  try { decode(hex('1f')) } catch { threw = true; }
  ok('rejects reserved additional-info', threw);
}

// ── JUMBF ──────────────────────────────────────────────────
console.log('\nJUMBF');
{
  // Hand-build: jumb superbox { jumd(uuid, label="c2pa.claim"), cbor payload }
  const label = 'c2pa.claim\0';
  const labelBytes = new TextEncoder().encode(label);
  const jumdLen = 8 + 16 + 1 + labelBytes.length;
  const payload = hex('a16474657374f5');            // {"test": true}
  const cborLen = 8 + payload.length;
  const total = 8 + jumdLen + cborLen;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let o = 0;
  dv.setUint32(o, total); o += 4;
  buf.set(new TextEncoder().encode('jumb'), o); o += 4;
  dv.setUint32(o, jumdLen); o += 4;
  buf.set(new TextEncoder().encode('jumd'), o); o += 4;
  o += 16;                                          // uuid (zeros)
  buf[o] = 0x03; o += 1;                            // toggles: label present
  buf.set(labelBytes, o); o += labelBytes.length;
  dv.setUint32(o, cborLen); o += 4;
  buf.set(new TextEncoder().encode('cbor'), o); o += 4;
  buf.set(payload, o);

  const boxes = parseBoxes(buf);
  ok('parses one superbox', boxes.length === 1 && boxes[0].type === 'jumb');
  ok('reads label from jumd', boxes[0].label === 'c2pa.claim', `got ${boxes[0].label}`);
  const found = findAllByLabelSuffix(boxes, 'c2pa.claim');
  ok('findAllByLabelSuffix locates it', found.length === 1);
  const leaf = found[0]?.children.find(c => c.type === 'cbor');
  ok('carries the cbor leaf', !!leaf && get(decode(leaf!.payload), 'test') === true);

  ok('truncated input does not throw', parseBoxes(buf.subarray(0, 6)).length === 0);
}

// ── rPPG ───────────────────────────────────────────────────
console.log('\nrPPG');

/** Synthetic face-region series: a pulse at `bpm` plus optional noise. */
function synth(opts: {
  bpm?: number; seconds: number; fps: number; amp?: number; noise?: number; seed?: number;
}): RppgSample[] {
  const { bpm = 0, seconds, fps, amp = 0, noise = 0 } = opts;
  let seed = opts.seed ?? 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const n = Math.round(seconds * fps);
  const out: RppgSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    // Blood volume shows up unequally across channels — that asymmetry is what
    // CHROM keys on, so a realistic synthetic has to include it.
    const pulse = amp * Math.sin(2 * Math.PI * (bpm / 60) * t);
    out.push({
      tMs: t * 1000,
      r: 150 + pulse * 0.3 + noise * rand(),
      g: 120 + pulse * 1.0 + noise * rand(),
      b: 110 + pulse * 0.2 + noise * rand(),
    });
  }
  return out;
}

{
  const clean = analyse(synth({ bpm: 72, seconds: 10, fps: 20, amp: 2.0 }));
  ok('detects a 72 BPM pulse', clean.verdict === 'pulse', `verdict=${clean.verdict} reason=${clean.reason}`);
  ok('rate within ±6 BPM', !!clean.bpm && Math.abs(clean.bpm - 72) <= 6, `bpm=${clean.bpm}`);

  const fast = analyse(synth({ bpm: 120, seconds: 10, fps: 20, amp: 2.0 }));
  ok('detects a 120 BPM pulse', fast.verdict === 'pulse' && Math.abs((fast.bpm ?? 0) - 120) <= 8, `bpm=${fast.bpm}`);

  const noisy = analyse(synth({ bpm: 66, seconds: 12, fps: 20, amp: 1.5, noise: 1.0 }));
  ok('survives moderate noise', noisy.verdict === 'pulse' && Math.abs((noisy.bpm ?? 0) - 66) <= 8, `bpm=${noisy.bpm} snr=${noisy.snr?.toFixed(1)}`);

  // The cases that must NOT claim a pulse.
  const flat = analyse(synth({ seconds: 10, fps: 20, amp: 0, noise: 0 }));
  ok('flat signal is not a pulse', flat.verdict !== 'pulse', `verdict=${flat.verdict}`);

  // Multiple seeds: a single-seed pass here would be luck, and this is the
  // assertion that stops VaultCheck reporting heartbeats on noise.
  const noiseSeeds = [1, 7, 42, 99, 555, 1234, 8888, 31337];
  const noiseVerdicts = noiseSeeds.map(seed =>
    analyse(synth({ seconds: 12, fps: 20, amp: 0, noise: 3.0, seed })));
  const falsePositives = noiseVerdicts.filter(v => v.verdict === 'pulse');
  ok('pure noise is never a pulse (8 seeds)', falsePositives.length === 0,
    `${falsePositives.length} false positives, snrs=${noiseVerdicts.map(v => v.snr?.toFixed(1)).join(',')}`);

  // Longer clips have finer frequency resolution and so a higher expected noise
  // peak — the case a fixed threshold got wrong.
  const longNoise = [11, 77, 404].map(seed =>
    analyse(synth({ seconds: 25, fps: 20, amp: 0, noise: 3.0, seed })));
  ok('long noisy clip is never a pulse', longNoise.every(v => v.verdict !== 'pulse'),
    `snrs=${longNoise.map(v => v.snr?.toFixed(1)).join(',')}`);

  const short = analyse(synth({ bpm: 72, seconds: 2, fps: 20, amp: 2.0 }));
  ok('short clip is inconclusive, not no-pulse', short.verdict === 'inconclusive', `verdict=${short.verdict}`);

  const sparse = analyse(synth({ bpm: 72, seconds: 12, fps: 4, amp: 2.0 }));
  ok('sub-Nyquist sampling is inconclusive', sparse.verdict === 'inconclusive', `verdict=${sparse.verdict} reason=${sparse.reason}`);

  const empty = analyse([]);
  ok('empty input is inconclusive', empty.verdict === 'inconclusive');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
