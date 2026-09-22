// lib/textWindow.selftest.ts — run: npx tsx lib/textWindow.selftest.ts
//
// This module's whole job is that a character cut in half by a byte window
// survives it. A boundary bug survives any hand-picked split — it only shows up
// at the ONE offset nobody thought to try. So the main check below is
// exhaustive: every split offset, in two windows and in three, must rebuild the
// original string byte for byte.

import { decodeWindow, WINDOW_BYTES } from './textWindow';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nWindowed text decoding self-test\n');

const enc = new TextEncoder();

// ASCII (1 byte), Telugu (3 bytes), emoji (4 bytes / surrogate pair in JS),
// é (2 bytes) — every UTF-8 sequence length appears, and they interleave.
const SAMPLE = 'Hi నమస్కారం 🙏 café, log line 42.\nనేను బాగున్నాను 😀 end';
const BYTES = enc.encode(SAMPLE);

check('the sample really does mix 1/2/3/4-byte characters',
  BYTES.length > SAMPLE.length + 40, `${BYTES.length} bytes for ${SAMPLE.length} chars`);

/** Feed a byte array through the module as the given windows, in order. */
function decodeAs(windows: Uint8Array[]): string {
  let out = '';
  let carry: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < windows.length; i++) {
    const r = decodeWindow(windows[i], carry, i === windows.length - 1);
    out += r.text;
    carry = r.carry;
  }
  return out;
}

// ── THE invariant: every split, two windows ────────────────────────────
let bad2: number[] = [];
for (let i = 0; i <= BYTES.length; i++) {
  if (decodeAs([BYTES.subarray(0, i), BYTES.subarray(i)]) !== SAMPLE) bad2.push(i);
}
eq(`all ${BYTES.length + 1} two-window splits round-trip`, bad2, []);

// ── and every pair of splits, three windows ────────────────────────────
let bad3: string[] = [];
for (let i = 0; i <= BYTES.length; i++) {
  for (let j = i; j <= BYTES.length; j++) {
    if (decodeAs([BYTES.subarray(0, i), BYTES.subarray(i, j), BYTES.subarray(j)]) !== SAMPLE) {
      bad3.push(`${i},${j}`);
    }
  }
}
eq('all three-window splits round-trip', bad3.slice(0, 8), []);

// A window smaller than one character is all carry and no text — the pathological
// case of three windows above, asserted directly so the failure is readable.
const om = enc.encode('ఓ');                       // one 3-byte character
const w1 = decodeWindow(om.subarray(0, 1));
const w2 = decodeWindow(om.subarray(1, 2), w1.carry);
const w3 = decodeWindow(om.subarray(2), w2.carry, true);
eq('a window that is entirely carry emits no text', [w1.text, w2.text], ['', '']);
eq('carry grows byte by byte', [w1.carry.length, w2.carry.length], [1, 2]);
eq('the character appears once the last byte arrives', w3.text, 'ఓ');

// ── degenerate input ───────────────────────────────────────────────────
eq('empty input', decodeWindow(new Uint8Array(0)), { text: '', carry: new Uint8Array(0) });
eq('empty final input', decodeWindow(new Uint8Array(0), new Uint8Array(0), true).text, '');
eq('pure ASCII never carries', decodeWindow(enc.encode('plain log line')).carry.length, 0);

// ── malformed bytes ────────────────────────────────────────────────────
// Truncated at TRUE end of file: the bytes are real data loss, not a boundary.
// They must surface as U+FFFD, never silently vanish with the carry.
const truncated = BYTES.subarray(0, 4);            // cuts the first Telugu character
const t1 = decodeWindow(truncated);
check('a cut sequence is held as carry mid-file', t1.carry.length > 0, `${t1.carry.length} bytes`);
const flushed = decodeWindow(new Uint8Array(0), t1.carry, true);
check('flushing at EOF yields U+FFFD, not nothing', flushed.text.includes('�'), JSON.stringify(flushed.text));
eq('nothing is left to flush afterwards', flushed.carry.length, 0);
eq('the flush is reachable in one call too',
  decodeWindow(truncated, new Uint8Array(0), true).text.includes('�'), true);

// A stray continuation byte is invalid ANYWHERE — it starts nothing, so it must
// not be mistaken for the start of a cut character and carried forever.
eq('a stray 0x80 is not carried', decodeWindow(new Uint8Array([0x80])).carry.length, 0);
eq('a stray 0x80 decodes to U+FFFD', decodeWindow(new Uint8Array([0x80])).text, '�');
eq('0x80 after valid text does not eat the text',
  decodeWindow(new Uint8Array([0x41, 0x80])).text, 'A�');
// 0xFF is not a lead byte under any UTF-8 rule.
eq('0xFF is not carried', decodeWindow(new Uint8Array([0xff])).carry.length, 0);
// Four continuation bytes in a row exceed any real sequence — not a boundary.
eq('a run of continuations is not carried',
  decodeWindow(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])).carry.length, 0);

// ── the constant ───────────────────────────────────────────────────────
check('the window is 256 KB', WINDOW_BYTES === 256 * 1024, String(WINDOW_BYTES));
// Every window must be able to hold at least one character of any length, or a
// file could make no forward progress at all.
check('a window dwarfs the longest UTF-8 sequence', WINDOW_BYTES > 4);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all textWindow checks passed\n');
process.exit(failures ? 1 : 0);
