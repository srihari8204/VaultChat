// lib/vaultcheck/jumbf.ts — pull the C2PA manifest store out of a media file.
//
// C2PA ships its manifest inside a JUMBF (JPEG Universal Metadata Box Format)
// superbox, embedded differently per container:
//
//   JPEG — split across APP11 marker segments. Each segment payload is:
//            'JP' (2) | box instance (2) | packet sequence (4) | fragment
//          Fragments with the same box instance are concatenated in packet
//          order to rebuild one JUMBF box. Segments are capped at 64 KB, so a
//          real manifest is always split; reassembly is mandatory, not an edge
//          case.
//
//   PNG  — a single 'caBX' ancillary chunk carrying the whole JUMBF box.
//
// The parser returns the raw manifest-store bytes plus the byte ranges the
// manifest itself occupies in the file. Those ranges matter: C2PA's hard
// binding hashes the asset with the manifest EXCLUDED, so verifying the binding
// is impossible without knowing exactly where it sat.

export interface JumbfBox {
  type: string;             // 4-char box type, e.g. 'jumb', 'jumd', 'cbor'
  label?: string;           // from the description box, when present
  uuid?: Uint8Array;        // content-type uuid from the description box
  payload: Uint8Array;      // content bytes (for leaf boxes)
  children: JumbfBox[];
}

export interface ExtractResult {
  /** Raw JUMBF superbox bytes (the manifest store). */
  box: Uint8Array;
  /** Byte ranges in the ORIGINAL file occupied by the embedded manifest. */
  ranges: { start: number; length: number }[];
  container: 'jpeg' | 'png';
}

const be32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const be16 = (b: Uint8Array, o: number) => (b[o] << 8) + b[o + 1];
const fourcc = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// ── container extraction ───────────────────────────────────

function extractJpeg(buf: Uint8Array): ExtractResult | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;   // SOI
  let pos = 2;
  // instance → ordered fragments
  const boxes = new Map<number, { seq: number; data: Uint8Array }[]>();
  const ranges: { start: number; length: number }[] = [];

  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;    // SOS / EOI — entropy data follows
    const segLen = be16(buf, pos + 2);
    if (segLen < 2 || pos + 2 + segLen > buf.length) break;

    if (marker === 0xeb) {                            // APP11
      const p = pos + 4;
      if (segLen >= 10 && buf[p] === 0x4a && buf[p + 1] === 0x50) {   // 'JP'
        const instance = be16(buf, p + 2);
        const seq = be32(buf, p + 4);
        const frag = buf.subarray(p + 8, pos + 2 + segLen);
        if (!boxes.has(instance)) boxes.set(instance, []);
        boxes.get(instance)!.push({ seq, data: frag });
        // The whole marker segment (incl. 0xFFEB + length) is excluded from the
        // hard binding.
        ranges.push({ start: pos, length: 2 + segLen });
      }
    }
    pos += 2 + segLen;
  }

  if (!boxes.size) return null;
  // C2PA uses a single box instance for the manifest store; if a file carries
  // more, take the largest reassembly rather than guessing by instance number.
  let best: Uint8Array | null = null;
  for (const frags of boxes.values()) {
    frags.sort((a, b) => a.seq - b.seq);
    const total = frags.reduce((a, f) => a + f.data.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const f of frags) { out.set(f.data, o); o += f.data.length; }
    if (!best || out.length > best.length) best = out;
  }
  if (!best) return null;
  ranges.sort((a, b) => a.start - b.start);
  return { box: best, ranges, container: 'jpeg' };
}

function extractPng(buf: Uint8Array): ExtractResult | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || sig.some((v, i) => buf[i] !== v)) return null;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = be32(buf, pos);
    const type = fourcc(buf, pos + 4);
    if (type === 'caBX') {
      const data = buf.subarray(pos + 8, pos + 8 + len);
      // length + type + data + crc
      return { box: data, ranges: [{ start: pos, length: 12 + len }], container: 'png' };
    }
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return null;
}

/** Locate and reassemble the JUMBF manifest store, or null when absent. */
export function extractManifestStore(buf: Uint8Array): ExtractResult | null {
  return extractJpeg(buf) ?? extractPng(buf);
}

// ── JUMBF box tree ─────────────────────────────────────────

/**
 * Parse a JUMBF box tree. Superboxes ('jumb') carry a description box ('jumd')
 * giving the content-type uuid and an optional label, followed by content
 * boxes. Everything else is treated as a leaf and kept as raw payload.
 */
export function parseBoxes(buf: Uint8Array, depth = 0): JumbfBox[] {
  const out: JumbfBox[] = [];
  if (depth > 12) return out;             // malformed/hostile nesting guard
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let len = be32(buf, pos);
    const type = fourcc(buf, pos + 4);
    let hdr = 8;
    if (len === 1) {                       // 64-bit extended length
      if (pos + 16 > buf.length) break;
      const hi = be32(buf, pos + 8);
      const lo = be32(buf, pos + 12);
      len = hi * 4294967296 + lo;
      hdr = 16;
    } else if (len === 0) {
      len = buf.length - pos;              // to end of container
    }
    if (len < hdr || pos + len > buf.length) break;

    const body = buf.subarray(pos + hdr, pos + len);
    if (type === 'jumb') {
      const children = parseBoxes(body, depth + 1);
      const desc = children.find(c => c.type === 'jumd');
      out.push({
        type,
        label: desc?.label,
        uuid: desc?.uuid,
        payload: body,
        children: children.filter(c => c.type !== 'jumd'),
      });
    } else if (type === 'jumd') {
      // uuid(16) | toggles(1) | [label \0] | ...
      const uuid = body.subarray(0, 16);
      let label: string | undefined;
      if (body.length > 17) {
        const toggles = body[16];
        if (toggles & 0x02) {              // label present
          let end = 17;
          while (end < body.length && body[end] !== 0) end++;
          label = new TextDecoder().decode(body.subarray(17, end));
        }
      }
      out.push({ type, label, uuid, payload: body, children: [] });
    } else {
      out.push({ type, payload: body, children: [] });
    }
    pos += len;
  }
  return out;
}

/** Depth-first search for the first box whose label matches. */
export function findByLabel(boxes: JumbfBox[], label: string): JumbfBox | null {
  for (const b of boxes) {
    if (b.label === label) return b;
    const hit = findByLabel(b.children, label);
    if (hit) return hit;
  }
  return null;
}

/** Depth-first search for boxes whose label ends with a suffix. */
export function findAllByLabelSuffix(boxes: JumbfBox[], suffix: string): JumbfBox[] {
  const out: JumbfBox[] = [];
  const walk = (list: JumbfBox[]) => {
    for (const b of list) {
      if (b.label && b.label.endsWith(suffix)) out.push(b);
      walk(b.children);
    }
  };
  walk(boxes);
  return out;
}

export default {};
