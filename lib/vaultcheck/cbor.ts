// lib/vaultcheck/cbor.ts — minimal CBOR decoder (RFC 8949).
//
// Only what C2PA manifests and COSE_Sign1 structures actually use: unsigned and
// negative integers, byte strings, text strings, arrays, maps, tags, and the
// simple values false/true/null/undefined. Indefinite-length items are
// supported because COSE producers do emit them.
//
// Deliberately NOT a general CBOR library: no floats beyond the three IEEE
// widths, no bignum tag handling, no canonical-form enforcement. It exists so
// VaultCheck can read provenance without adding a native dependency, and it
// refuses (throws) rather than guessing on anything outside that subset.

export type CborValue =
  | number | bigint | string | Uint8Array | boolean | null | undefined
  | CborValue[] | CborMap | CborTag;

export interface CborTag { __tag: number; value: CborValue }
export type CborMap = Map<CborValue, CborValue>;

export function isTag(v: CborValue): v is CborTag {
  return !!v && typeof v === 'object' && '__tag' in (v as any);
}

class Reader {
  constructor(public buf: Uint8Array, public pos = 0) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('cbor: truncated');
  }

  u8(): number { this.need(1); return this.buf[this.pos++]; }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uint(n: number): number | bigint {
    if (n === 0) return 0;
    const b = this.bytes(n);
    if (n <= 4) {
      let v = 0;
      for (const x of b) v = v * 256 + x;
      return v;
    }
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    // Stay in `number` when it is exactly representable — callers index arrays
    // and compare lengths with these.
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
}

function argument(r: Reader, ai: number): number | bigint | null {
  if (ai < 24) return ai;
  if (ai === 24) return r.uint(1);
  if (ai === 25) return r.uint(2);
  if (ai === 26) return r.uint(4);
  if (ai === 27) return r.uint(8);
  if (ai === 31) return null;             // indefinite length
  throw new Error(`cbor: reserved additional info ${ai}`);
}

function decodeItem(r: Reader): CborValue {
  const ib = r.u8();
  const major = ib >> 5;
  const ai = ib & 0x1f;

  switch (major) {
    case 0: {                              // unsigned int
      const n = argument(r, ai);
      if (n === null) throw new Error('cbor: indefinite uint');
      return n;
    }
    case 1: {                              // negative int
      const n = argument(r, ai);
      if (n === null) throw new Error('cbor: indefinite negative int');
      return typeof n === 'bigint' ? -1n - n : -1 - n;
    }
    case 2: {                              // byte string
      const n = argument(r, ai);
      if (n === null) {                    // indefinite: concat chunks
        const chunks: Uint8Array[] = [];
        for (;;) {
          if (r.buf[r.pos] === 0xff) { r.pos++; break; }
          const c = decodeItem(r);
          if (!(c instanceof Uint8Array)) throw new Error('cbor: bad bstr chunk');
          chunks.push(c);
        }
        const total = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      }
      return r.bytes(Number(n));
    }
    case 3: {                              // text string
      const n = argument(r, ai);
      if (n === null) {
        let s = '';
        for (;;) {
          if (r.buf[r.pos] === 0xff) { r.pos++; break; }
          const c = decodeItem(r);
          if (typeof c !== 'string') throw new Error('cbor: bad tstr chunk');
          s += c;
        }
        return s;
      }
      return new TextDecoder().decode(r.bytes(Number(n)));
    }
    case 4: {                              // array
      const n = argument(r, ai);
      const out: CborValue[] = [];
      if (n === null) {
        for (;;) {
          if (r.buf[r.pos] === 0xff) { r.pos++; break; }
          out.push(decodeItem(r));
        }
        return out;
      }
      for (let i = 0; i < Number(n); i++) out.push(decodeItem(r));
      return out;
    }
    case 5: {                              // map
      const n = argument(r, ai);
      const out: CborMap = new Map();
      if (n === null) {
        for (;;) {
          if (r.buf[r.pos] === 0xff) { r.pos++; break; }
          const k = decodeItem(r);
          out.set(k, decodeItem(r));
        }
        return out;
      }
      for (let i = 0; i < Number(n); i++) {
        const k = decodeItem(r);
        out.set(k, decodeItem(r));
      }
      return out;
    }
    case 6: {                              // tag
      const t = argument(r, ai);
      if (t === null) throw new Error('cbor: indefinite tag');
      return { __tag: Number(t), value: decodeItem(r) };
    }
    case 7: {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      if (ai === 25) { r.bytes(2); return NaN; }   // half float — unused by C2PA
      if (ai === 26) {
        const b = r.bytes(4);
        return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0);
      }
      if (ai === 27) {
        const b = r.bytes(8);
        return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0);
      }
      throw new Error(`cbor: unsupported simple value ${ai}`);
    }
    default:
      throw new Error(`cbor: bad major type ${major}`);
  }
}

/** Decode one CBOR item. Throws on anything outside the supported subset. */
export function decode(buf: Uint8Array): CborValue {
  return decodeItem(new Reader(buf));
}

/** Convenience: read a string-keyed map entry. */
export function get(m: CborValue, key: string): CborValue {
  if (!(m instanceof Map)) return undefined;
  return m.get(key);
}

export default {};
