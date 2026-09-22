// lib/textWindow.ts — read a plain-text file in BYTE windows without breaking
// the characters that straddle them.
//
// Why this exists: app/file-viewer.tsx reads a text file with
// FileSystem.readAsStringAsync(uri), which materialises the whole file as one JS
// string and therefore refuses anything over 5 MB. Expo only accepts `position`
// and `length` when `encoding: 'base64'` (node_modules/expo-file-system/build/
// legacy/FileSystem.types.d.ts:232), so a window arrives as base64 -> bytes, and
// a BYTE window can cut a multi-byte UTF-8 character in half. Telugu and Hindi
// are 3 bytes per character, emoji are 4. Decoding each window on its own
// corrupts one character at every single boundary.
//
// This module does the byte->text bookkeeping ONLY. The caller does the file
// I/O and the base64->bytes step (it already has Buffer); this takes Uint8Array
// in, so it has no react-native / expo imports and runs under plain tsx in Node
// — same model as lib/docText.ts and lib/reader.ts. See textWindow.selftest.ts.
//
// Decoding uses the platform TextDecoder. That is not an assumption: this app
// already constructs one at MODULE SCOPE on shipped Hermes paths with no
// polyfill installed anywhere (lib/waImport.ts:333, lib/vaultCrypto.ts:15,67,
// lib/vaultBeam/lanSeal.ts:32, lib/vaultcheck/cbor.ts:112, lib/syncEngine.ts:206),
// and eslint.config.js:83-84 declares both as globals. If Hermes lacked it the
// vault would fail to open. Only the ~10 lines of "how long is the sequence this
// lead byte starts" are written by hand below, because TextDecoder cannot answer
// that without holding stream state, and stream state is exactly what a pure
// {text, carry} contract is avoiding.

/**
 * Bytes per window. 256 KB is roughly 100-250 KB of text — several screens
 * even at large font scale — and decodes in a few milliseconds, so the first
 * window lands well inside one frame budget and the rest arrive on scroll.
 */
export const WINDOW_BYTES = 256 * 1024;

const UTF8 = new TextDecoder('utf-8');   // non-fatal: bad bytes become U+FFFD

/** Bytes in the UTF-8 sequence this lead byte starts, or 0 if it is not a lead. */
function seqLen(b: number): number {
  if (b < 0x80) return 1;               // 0xxxxxxx
  if (b < 0xc0) return 0;               // 10xxxxxx — a continuation, not a lead
  if (b < 0xe0) return 2;               // 110xxxxx
  if (b < 0xf0) return 3;               // 1110xxxx
  if (b < 0xf8) return 4;               // 11110xxx
  return 0;                             // 0xf8..0xff — never valid UTF-8
}

export interface WindowText {
  /** Everything that decoded to complete characters. */
  text: string;
  /**
   * The trailing 1-3 bytes of a sequence this window cut short. Pass it back in
   * as `carry` on the next window. Empty when the window ended cleanly.
   */
  carry: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Decode one window.
 *
 * @param bytes  the window, exactly as read from the file
 * @param carry  what the previous window returned (omit for the first window)
 * @param final  true for the LAST window of the file. A truncated sequence is a
 *               boundary mid-file but genuinely malformed data at EOF, so `final`
 *               decodes the leftover instead of carrying it — the caller gets
 *               U+FFFD rather than silently losing the bytes, and `carry` comes
 *               back empty so there is nothing left to flush.
 */
export function decodeWindow(bytes: Uint8Array, carry: Uint8Array = EMPTY, final = false): WindowText {
  let buf = bytes;
  if (carry.length) {
    buf = new Uint8Array(carry.length + bytes.length);
    buf.set(carry, 0);
    buf.set(bytes, carry.length);
  }
  if (final) return { text: UTF8.decode(buf), carry: EMPTY };

  // Walk back over at most one sequence looking for its lead byte. Anything
  // longer than 4 bytes of continuations is invalid data, not a cut character,
  // so it is left for TextDecoder to mark with U+FFFD rather than carried.
  let cut = buf.length;
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i--) {
    const n = seqLen(buf[i]);
    if (n === 0) continue;                       // continuation byte, keep walking
    if (i + n > buf.length) cut = i;             // the sequence runs past the window
    break;
  }
  return { text: UTF8.decode(buf.subarray(0, cut)), carry: buf.slice(cut) };
}

export default {};
