// lib/vaultBeam/signalSealed.selftest.ts — VaultBeam's direct tiers must never
// hand the server a plaintext SDP offer, ICE candidate, or LAN address.
//
//   npx tsx lib/vaultBeam/signalSealed.selftest.ts
//
// SCOPE, STATED PLAINLY — the same split lib/call/frameE2ee.selftest.ts uses.
// The LAN seal is REALLY EXECUTED (./lanSeal is pure and RN-free, which is why
// it is its own module). Everything about lib/vaultBeamDirect.ts is read out of
// the SOURCE, because that file imports react-native-webrtc, the socket and the
// native stream module and cannot be loaded under Node at all.
//
// WHAT WENT WRONG
//
// `newCallCipher()` returns null when there is no X3DH session with the peer —
// a first transfer, a reinstalled peer, a stale ratchet. The sender did not
// abort on that. It sent the offer ANYWAY, in the clear:
//
//     emit('vaultbeam_offer', { offer: cc ? cc.offerWire : offer })
//
// An SDP offer carries the DTLS-SRTP fingerprint that anchors the
// datachannel's encryption, so a server that can read or replace it can MITM
// the whole transfer — which is exactly what lib/callCrypto.ts's header says
// must never happen. The candidates that followed carried device IPs, and the
// LAN tier volunteered the sender's LAN address outright, in the very function
// that buffers ICE candidates so they cannot escape unsealed.
//
// None of it was visible: the transfer worked perfectly either way.

import { readFileSync } from 'fs';
import { join } from 'path';
import { sealLan, openLan } from './lanSeal';

const ROOT = join(__dirname, '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const DIRECT = strip(readFileSync(join(ROOT, 'lib/vaultBeamDirect.ts'), 'utf8'));

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nVaultBeam direct signalling — sealed or not sent\n');

// ── 1. the LAN endpoint seal, really executed ─────────────────────────
{
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const OTHER = Buffer.alloc(32, 9).toString('base64');
  const endpoint = { lanIp: '192.168.1.42', lanPort: 54321 };

  const wire = sealLan(KEY, endpoint);
  A(!wire.includes('192.168.1.42'),
    '1. the sealed endpoint does NOT contain the IP — this is the whole point, '
    + 'and it is what the relay used to be handed verbatim');
  A(JSON.stringify(openLan(KEY, wire)) === JSON.stringify(endpoint),
    '1a. the peer, who holds the same per-transfer key, opens it exactly');
  A(openLan(OTHER, wire) === null,
    '1b. a different key does NOT open it — GCM authenticates, so the server '
    + 'cannot substitute an endpoint of its own either');
  A(openLan(KEY, 'not.a.frame') === null && openLan(KEY, undefined) === null,
    '1c. garbage and absence both open to null rather than throwing');

  // Nonce reuse under one GCM key is catastrophic, and the per-transfer key is
  // ALSO used by the native chunk cipher — hence the domain-separated subkey
  // and a fresh random IV per seal.
  A(sealLan(KEY, endpoint) !== sealLan(KEY, endpoint),
    '1d. two seals of the same endpoint differ — a fresh IV each time');
}

// ── 2. no cipher → NO plaintext SDP is emitted ────────────────────────
{
  // The exact shape of the old bug, which must not come back in any form.
  A(!/offer:\s*cc\s*\?/.test(DIRECT) && !/cc\s*\?\s*cc\.offerWire\s*:/.test(DIRECT),
    '2. the sender no longer falls back to the raw offer when newCallCipher() '
    + 'returns null');
  const setup = DIRECT.slice(DIRECT.indexOf('const cc = await newCallCipher'));
  const body = setup.slice(0, setup.indexOf("emit('vaultbeam_offer'"));
  A(/if \(!cc\)/.test(body) && /throw new Error/.test(body),
    '2a. it ABORTS instead — a transfer that cannot be sealed is not attempted');
  A(/sealDead = true/.test(body) && /outIce\.length = 0/.test(body),
    '2b. and the candidates gathered while waiting for the cipher are DROPPED, '
    + 'not flushed — they carry device IPs');
  A(/const emitIce = \(c: any\) => \{\s*if \(!cipher\) return;/.test(DIRECT),
    '2c. the one function that puts a candidate on the wire refuses to run '
    + 'without a cipher, whatever calls it');
  A(/cipher\?\.open\(/.test(DIRECT) && !/cipher \? cipher\.open/.test(DIRECT),
    '2d. an inbound frame we cannot authenticate is dropped, not trusted as '
    + '"legacy plaintext" — that implicit null check WAS the hole');
}

// ── 3. the receiving half fails closed too ────────────────────────────
{
  A(/!cipher\.enc && !VB_ALLOW_LEGACY_PLAINTEXT/.test(DIRECT),
    '3. an UNSEALED offer from the peer is refused — answering it would put our '
    + 'own fingerprint and candidates on the wire in the clear');
  A(/export const VB_ALLOW_LEGACY_PLAINTEXT = false/.test(DIRECT),
    '3a. and legacy plaintext is an EXPLICIT flag, defaulting to off, rather '
    + 'than an implicit "we had no cipher, so send it anyway"');
}

// ── 4. the LAN address is sealed at the one place it egresses ─────────
{
  const bound = DIRECT.slice(DIRECT.indexOf("onLanEvent('vbLanBound'"));
  const handler = bound.slice(0, bound.indexOf("onLanEvent('vbLanProgress'"));
  A(/sealLan\(g\.keyB64/.test(handler),
    '4. vaultbeam_ready carries a SEALED endpoint');
  // The sealed call is `sealLan(key, { lanIp: lanIpVal, lanPort })`, so the
  // text `lanIp: lanIpVal` legitimately appears INSIDE it. What must never come
  // back is that pair as a sibling of `lan:` on the emitted object. Blank out
  // the sealLan(...) arguments first, then look at what is left.
  const emitted = handler.replace(/sealLan\([\s\S]*?\)\)/g, 'SEALED)');
  A(!/lanIp\s*:/.test(emitted),
    '4a. and not the raw lanIp field it used to emit');
  A(!/ready\.lanIp/.test(DIRECT) && /openLan\(g\.keyB64, ready\.lan\)/.test(DIRECT),
    '4b. the receiver reads the sealed one, gated on the legacy flag for an '
    + 'old sender rather than accepting plaintext silently');
}

// ── 5. failing closed costs the user nothing ──────────────────────────
//
// Worth pinning, because it is the reason this fail-closed rule is safe to
// ship: every abort above returns to serveDirect/receiveDirect's normal
// "direct tier unavailable" path, and lib/vaultBeamController falls through to
// the R2 relay — the guaranteed baseline, whose chunks are the same AES-256-GCM
// ciphertext. No transfer is lost, only its fast path.
{
  A(/Promise<'lan' \| 'p2p' \| null>/.test(DIRECT),
    '5. serveDirect still reports "no direct tier" as null rather than throwing '
    + 'at its caller — the relay fallback is reached exactly as before');
}

console.log(failed === 0 ? '\nsignalSealed: all checks passed' : `\nsignalSealed: ${failed} FAILED`);
if (failed > 0) process.exit(1);
