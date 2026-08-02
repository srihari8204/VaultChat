// lib/vaultcheck/c2pa.ts — Content Credentials (C2PA) verification.
//
// Reads the manifest a camera or editor embedded in the file and answers three
// separate questions that are easy to conflate:
//
//   1. Is there a manifest at all, and what does it claim?
//        → who generated it, when, what edits were declared
//   2. Do the bytes still match the claim? (hard binding)
//        → catches "signed image, then someone altered the pixels"
//   3. Is the claim cryptographically signed by the certificate it names?
//        → catches a forged or transplanted manifest
//
// What this DELIBERATELY does not do: validate the signing certificate against
// the C2PA trust list. We do not bundle the trust anchors, so the honest answer
// is `issuer: 'unverified'` — the signature is mathematically sound and the
// named issuer is reported, but "is this issuer legitimate" is out of scope.
// Reporting an unverified issuer as trusted would be the single most misleading
// thing this file could do, given the output is shown to someone deciding
// whether to believe an image.
//
// Supported signature algorithms: ES256 / ES384 (COSE alg -7 / -35), which is
// what current cameras and Adobe tooling emit. Anything else is reported as
// `signature: 'unsupported'` rather than failed — an algorithm we cannot check
// is not evidence of forgery.

import { p256 } from '@noble/curves/nist.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { decode, get, isTag, type CborValue } from './cbor';
import { extractManifestStore, parseBoxes, findAllByLabelSuffix, type JumbfBox } from './jumbf';

export type SignatureState = 'valid' | 'invalid' | 'unsupported' | 'absent';
export type BindingState = 'match' | 'mismatch' | 'absent' | 'unsupported';

export interface C2paAction { action: string; when?: string; softwareAgent?: string }

export interface C2paResult {
  present: boolean;
  /** Claim generator string, e.g. "Adobe Photoshop 25.0" or a camera model. */
  generator?: string;
  /** ISO timestamp from the signature, when present. */
  signedAt?: string;
  /** Declared edit actions, in order. */
  actions: C2paAction[];
  /** Does the asset still hash to what the claim signed? */
  binding: BindingState;
  /** Is the claim signature cryptographically valid? */
  signature: SignatureState;
  /** Subject common name of the signing certificate, when parseable. */
  signerName?: string;
  /**
   * Always 'unverified' today — see the header. Kept in the shape so the UI can
   * never accidentally imply chain validation happened.
   */
  issuer: 'unverified';
  /** Human-readable note when something could not be checked. */
  note?: string;
}

const EMPTY: C2paResult = {
  present: false, actions: [], binding: 'absent', signature: 'absent', issuer: 'unverified',
};

// ── tiny CBOR encoder (only what Sig_structure needs) ──────

function encHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function encBytes(b: Uint8Array): Uint8Array { return concat([encHead(2, b.length), b]); }
function encText(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concat([encHead(3, b.length), b]);
}

/** COSE Sig_structure for a Signature1: ["Signature1", protected, aad, payload]. */
function sigStructure(protectedHdr: Uint8Array, payload: Uint8Array): Uint8Array {
  return concat([
    encHead(4, 4),
    encText('Signature1'),
    encBytes(protectedHdr),
    encBytes(new Uint8Array(0)),
    encBytes(payload),
  ]);
}

// ── minimal DER walking, to reach the signer's public key ──

interface Der { tag: number; contents: Uint8Array; end: number }

function derRead(buf: Uint8Array, pos: number): Der | null {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos];
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  if (p + len > buf.length) return null;
  return { tag, contents: buf.subarray(p, p + len), end: p + len };
}

function derChildren(seq: Uint8Array): Der[] {
  const out: Der[] = [];
  let pos = 0;
  while (pos < seq.length) {
    const d = derRead(seq, pos);
    if (!d) break;
    out.push(d);
    pos = d.end;
  }
  return out;
}

/**
 * Pull the uncompressed EC point out of an X.509 certificate's
 * SubjectPublicKeyInfo, plus the subject CN when we can find one.
 *
 * Walks Certificate → tbsCertificate → SPKI by position rather than by OID
 * matching, which is enough for the EC certs C2PA signers use, and returns null
 * (not a guess) for anything shaped differently.
 */
function certPublicKey(der: Uint8Array): { key: Uint8Array; name?: string } | null {
  const cert = derRead(der, 0);
  if (!cert || cert.tag !== 0x30) return null;
  const top = derChildren(cert.contents);
  if (!top.length || top[0].tag !== 0x30) return null;
  const tbs = derChildren(top[0].contents);

  // [0] EXPLICIT version is optional; when present SPKI shifts by one.
  const hasVersion = tbs.length > 0 && tbs[0].tag === 0xa0;
  const spkiIdx = hasVersion ? 6 : 5;
  const subjectIdx = hasVersion ? 5 : 4;
  if (tbs.length <= spkiIdx) return null;

  const spki = tbs[spkiIdx];
  if (spki.tag !== 0x30) return null;
  const spkiKids = derChildren(spki.contents);
  const bitStr = spkiKids.find(k => k.tag === 0x03);
  if (!bitStr || bitStr.contents.length < 2) return null;
  // First byte of a BIT STRING is the unused-bit count (0 for keys).
  const key = bitStr.contents.subarray(1);

  // Subject CN: RDNSequence → SET → SEQUENCE { OID 2.5.4.3, UTF8String }
  let name: string | undefined;
  try {
    const subject = tbs[subjectIdx];
    if (subject?.tag === 0x30) {
      for (const rdn of derChildren(subject.contents)) {
        for (const attr of derChildren(rdn.contents)) {
          const kids = derChildren(attr.contents);
          const oid = kids.find(k => k.tag === 0x06);
          const val = kids.find(k => k.tag === 0x0c || k.tag === 0x13);
          // 2.5.4.3 = id-at-commonName → DER 55 04 03
          if (oid && val && oid.contents.length === 3 &&
              oid.contents[0] === 0x55 && oid.contents[1] === 0x04 && oid.contents[2] === 0x03) {
            name = new TextDecoder().decode(val.contents);
          }
        }
      }
    }
  } catch { /* name is a nicety, not a verdict */ }

  return { key, name };
}

// ── manifest interpretation ────────────────────────────────

function boxPayload(box: JumbfBox | undefined | null): Uint8Array | null {
  if (!box) return null;
  // A content box under a jumb superbox holds the bytes we want.
  if (box.children.length) {
    const leaf = box.children.find(c => c.type === 'cbor' || c.type === 'bidb' || c.type === 'json');
    if (leaf) return leaf.payload;
  }
  return box.payload;
}

function asString(v: CborValue): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function hashFor(alg: string | undefined): ((d: Uint8Array) => Uint8Array) | null {
  switch ((alg || 'sha256').toLowerCase()) {
    case 'sha256': return sha256;
    case 'sha384': return sha384;
    case 'sha512': return sha512;
    default: return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Hash the asset the way C2PA's `c2pa.hash.data` assertion specifies: over the
 * whole file with the listed byte ranges (the embedded manifest itself) cut
 * out. Any mismatch means the pixels changed after signing.
 */
function hashWithExclusions(
  file: Uint8Array,
  exclusions: { start: number; length: number }[],
  hash: (d: Uint8Array) => Uint8Array,
): Uint8Array {
  const sorted = [...exclusions].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const ex of sorted) {
    if (ex.start > pos) parts.push(file.subarray(pos, ex.start));
    pos = Math.max(pos, ex.start + ex.length);
  }
  if (pos < file.length) parts.push(file.subarray(pos));
  return hash(concat(parts));
}

/**
 * Verify the Content Credentials on a media file.
 *
 * `file` is the complete original bytes — the hard-binding check hashes the
 * asset, so a re-encoded or partially-read buffer will (correctly) report a
 * mismatch.
 */
export function verifyC2pa(file: Uint8Array): C2paResult {
  let store;
  try { store = extractManifestStore(file); } catch { return { ...EMPTY, note: 'manifest unreadable' }; }
  if (!store) return { ...EMPTY };

  let boxes: JumbfBox[];
  try { boxes = parseBoxes(store.box); } catch { return { ...EMPTY, present: true, note: 'manifest structure invalid' }; }

  const claimBox = findAllByLabelSuffix(boxes, 'c2pa.claim')[0];
  const sigBox = findAllByLabelSuffix(boxes, 'c2pa.signature')[0];
  const claimBytes = boxPayload(claimBox);
  if (!claimBytes) return { ...EMPTY, present: true, note: 'no claim in manifest' };

  const result: C2paResult = {
    present: true, actions: [], binding: 'absent', signature: 'absent', issuer: 'unverified',
  };

  // ── claim ──
  let claim: CborValue;
  try { claim = decode(claimBytes); } catch { return { ...result, note: 'claim not decodable' }; }
  result.generator = asString(get(claim, 'claim_generator'))
    ?? asString(get(claim, 'claim_generator_info'))
    ?? undefined;

  // ── assertions: actions + hard binding ──
  const assertionBoxes = findAllByLabelSuffix(boxes, 'c2pa.actions');
  for (const ab of assertionBoxes) {
    const payload = boxPayload(ab);
    if (!payload) continue;
    try {
      const a = decode(payload);
      const list = get(a, 'actions');
      if (Array.isArray(list)) {
        for (const item of list) {
          const action = asString(get(item, 'action'));
          if (!action) continue;
          result.actions.push({
            action,
            when: asString(get(item, 'when')),
            softwareAgent: asString(get(item, 'softwareAgent')),
          });
        }
      }
    } catch { /* one bad assertion must not sink the whole verdict */ }
  }

  const hashBox = findAllByLabelSuffix(boxes, 'c2pa.hash.data')[0];
  const hashPayload = boxPayload(hashBox);
  if (!hashPayload) {
    result.binding = 'absent';
  } else {
    try {
      const h = decode(hashPayload);
      const alg = asString(get(h, 'alg'));
      const fn = hashFor(alg);
      const expected = get(h, 'hash');
      if (!fn) {
        result.binding = 'unsupported';
      } else if (expected instanceof Uint8Array) {
        const rawEx = get(h, 'exclusions');
        const exclusions: { start: number; length: number }[] = [];
        if (Array.isArray(rawEx)) {
          for (const e of rawEx) {
            const start = get(e, 'start');
            const length = get(e, 'length');
            if (typeof start === 'number' && typeof length === 'number') exclusions.push({ start, length });
          }
        }
        // Fall back to the ranges we located ourselves when the assertion does
        // not spell them out — the embedded manifest is always excluded.
        const use = exclusions.length ? exclusions : store.ranges;
        result.binding = bytesEqual(hashWithExclusions(file, use, fn), expected) ? 'match' : 'mismatch';
      } else {
        result.binding = 'unsupported';
      }
    } catch {
      result.binding = 'unsupported';
    }
  }

  // ── signature ──
  const sigBytes = boxPayload(sigBox);
  if (!sigBytes) return result;

  try {
    let cose = decode(sigBytes);
    if (isTag(cose)) cose = cose.value;            // COSE_Sign1 tag 18
    if (!Array.isArray(cose) || cose.length < 4) { result.signature = 'unsupported'; return result; }

    const protectedHdr = cose[0] as Uint8Array;
    const unprotected = cose[1];
    const signature = cose[3] as Uint8Array;
    if (!(protectedHdr instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
      result.signature = 'unsupported'; return result;
    }

    const hdr = decode(protectedHdr);
    const alg = hdr instanceof Map ? hdr.get(1) : undefined;    // COSE label 1 = alg
    // -7 = ES256 (P-256/SHA-256). -35 = ES384, which needs P-384; we do not
    // bundle that curve, so it is reported unsupported rather than failed.
    if (alg !== -7) { result.signature = 'unsupported'; return result; }

    // x5chain lives at label 33, in the protected or unprotected header.
    let chain: CborValue = hdr instanceof Map ? hdr.get(33) : undefined;
    if (chain === undefined && unprotected instanceof Map) chain = unprotected.get(33);
    const leafDer = Array.isArray(chain) ? chain[0] : chain;
    if (!(leafDer instanceof Uint8Array)) { result.signature = 'unsupported'; return result; }

    const pk = certPublicKey(leafDer);
    if (!pk) { result.signature = 'unsupported'; return result; }
    result.signerName = pk.name;

    // C2PA detaches the payload: the claim bytes are the signed content.
    const toSign = sigStructure(protectedHdr, claimBytes);
    const digest = sha256(toSign);
    result.signature = p256.verify(signature, digest, pk.key) ? 'valid' : 'invalid';
  } catch {
    result.signature = 'unsupported';
    result.note = 'signature could not be checked';
  }

  return result;
}

export default {};
