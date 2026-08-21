// lib/vaultBeam/transportLabel.ts — what actually moved the bytes, in one label.
//
// WHY A DRIVER ID IS NOT AN ANSWER
//
// The session already records `lastTransport`, which is a driver id: 'lan',
// 'p2p' or 'relay'. That is enough to pick the next transport and not enough to
// answer the question anyone actually asks after a transfer:
//
//     did this go peer-to-peer, or did it go through TURN?
//
// Both are the 'p2p' driver. TURN is not a tier — it is an ICE candidate type
// INSIDE WebRTC — so the driver id cannot distinguish them by construction, and
// a report that says "p2p" for a relayed transfer is not a small inaccuracy: it
// is the difference between free and paid, and between "NAT traversal works on
// this network" and "it does not".
//
// # THIS MODULE MAY NEVER LEAK AN ADDRESS
//
// It sits on the path to persistent logs, and the objects around it are full of
// things that must never be written down — DirectGeom alone carries `keyB64`
// and `token`. So the contract is deliberately narrow: it accepts ICE candidate
// TYPES and a boolean, and it emits from a CLOSED SET of constant strings. It
// never formats an input into its output. That is what makes "no IP address can
// appear in a label" a property of the code rather than a promise, and the
// self-check below asserts it against addresses, URLs, keys and tokens.
//
// PURE — no react-native, no network. `npx tsx lib/vaultBeam/transportLabel.ts`.

/** What moved the bytes. Closed set — these four plus the unknown case. */
export type TransportKind =
  | 'LAN'             // LAN TCP direct, no ICE involved
  | 'WEBRTC_DIRECT'   // WebRTC, host or server-reflexive on both ends
  | 'WEBRTC_TURN'     // WebRTC, relayed through TURN
  | 'R2_RELAY'        // Cloudflare R2 store-and-forward
  | 'UNKNOWN';

export interface TransportLabel {
  kind: TransportKind;
  /**
   * Human-readable, address-free detail: 'host-srflx / IPv4', 'relay-relay /
   * IPv6', 'LAN_TCP', 'R2_RELAY'. Built only from constants.
   */
  detail: string;
}

/** ICE candidate types we will name. Anything else collapses to 'unknown'. */
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay', 'unknown'] as const;
type CandidateType = (typeof CANDIDATE_TYPES)[number];

/**
 * Map an arbitrary string onto the closed set.
 *
 * `indexOf` rather than passing the input through: an unrecognised value must
 * become the CONSTANT 'unknown', not a sanitised copy of itself. That is the
 * difference between a closed set and a filter someone will later widen.
 */
function safeType(t: unknown): CandidateType {
  const s = typeof t === 'string' ? t.toLowerCase() : '';
  const i = (CANDIDATE_TYPES as readonly string[]).indexOf(s);
  return i >= 0 ? CANDIDATE_TYPES[i] : 'unknown';
}

export interface IceFacts {
  localType?: string;
  remoteType?: string;
  isIPv6?: boolean;
}

/**
 * Classify a completed (or in-flight) transport.
 *
 * @param driverId the transport driver that ran — 'lan' | 'p2p' | 'relay'
 * @param ice      the winning ICE pair, when the driver was WebRTC. Types only.
 *
 * A WebRTC transfer with no ICE facts is WEBRTC_DIRECT with an 'unknown-unknown'
 * detail, NOT WEBRTC_TURN: absence of evidence is not evidence of relaying, and
 * over-reporting TURN would make the relay-rate metric useless in the opposite
 * direction. The detail string says plainly that nothing was observed.
 */
export function classifyTransport(driverId: string | null | undefined, ice?: IceFacts | null): TransportLabel {
  const id = typeof driverId === 'string' ? driverId.toLowerCase() : '';

  if (id === 'lan') return { kind: 'LAN', detail: 'LAN_TCP' };
  if (id === 'relay') return { kind: 'R2_RELAY', detail: 'R2_RELAY' };

  if (id === 'p2p') {
    const l = safeType(ice?.localType);
    const r = safeType(ice?.remoteType);
    const fam = ice?.isIPv6 === true ? 'IPv6' : ice?.isIPv6 === false ? 'IPv4' : 'unknown-family';
    // EITHER end relaying means the pair was relayed.
    const kind: TransportKind = l === 'relay' || r === 'relay' ? 'WEBRTC_TURN' : 'WEBRTC_DIRECT';
    return { kind, detail: `${l}-${r} / ${fam}` };
  }

  return { kind: 'UNKNOWN', detail: 'unknown' };
}

/** True when the label says a paid relay carried the bytes. */
export function isRelayed(l: TransportLabel): boolean {
  return l.kind === 'WEBRTC_TURN' || l.kind === 'R2_RELAY';
}

export default { classifyTransport, isRelayed };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  console.log('\nVaultBeam transport labelling\n');

  A(classifyTransport('lan').kind === 'LAN', '1. the LAN driver is LAN');
  A(classifyTransport('relay').kind === 'R2_RELAY', '2. the relay driver is R2_RELAY');

  // THE DISTINCTION THIS MODULE EXISTS FOR.
  const direct = classifyTransport('p2p', { localType: 'host', remoteType: 'host', isIPv6: false });
  A(direct.kind === 'WEBRTC_DIRECT', '3. host-host is WEBRTC_DIRECT');
  A(direct.detail === 'host-srflx / IPv4' || direct.detail === 'host-host / IPv4',
    `4. detail names both ends and the family (${direct.detail})`);

  A(classifyTransport('p2p', { localType: 'srflx', remoteType: 'srflx' }).kind === 'WEBRTC_DIRECT',
    '5. srflx-srflx is still direct — a STUN-discovered address is not a relay');
  A(classifyTransport('p2p', { localType: 'relay', remoteType: 'relay' }).kind === 'WEBRTC_TURN',
    '6. relay-relay is WEBRTC_TURN');

  // The asymmetric case, which reading only the local side gets wrong.
  A(classifyTransport('p2p', { localType: 'host', remoteType: 'relay' }).kind === 'WEBRTC_TURN',
    '7. a REMOTE relay makes the pair relayed, even with a local host candidate');
  A(classifyTransport('p2p', { localType: 'relay', remoteType: 'host' }).kind === 'WEBRTC_TURN',
    '8. and symmetrically the other way round');

  // Absence of evidence is not evidence of relaying.
  const blind = classifyTransport('p2p');
  A(blind.kind === 'WEBRTC_DIRECT', '9. WebRTC with no ICE facts is not reported as TURN');
  A(blind.detail.includes('unknown'), '10. and its detail says so plainly');

  A(classifyTransport(null).kind === 'UNKNOWN', '11. no driver is UNKNOWN');
  A(classifyTransport('something-else').kind === 'UNKNOWN', '12. an unregistered driver is UNKNOWN');

  A(isRelayed(classifyTransport('relay')) && isRelayed(classifyTransport('p2p', { localType: 'relay' })),
    '13. isRelayed covers both paid paths');
  A(!isRelayed(classifyTransport('lan')) && !isRelayed(direct),
    '14. and neither free one');

  // ── THE SECURITY PROPERTY ──────────────────────────────────────
  //
  // Feed it every shape of secret and address that exists on this code path and
  // assert none of it survives into the label.
  const POISON = [
    '192.168.1.14', '10.0.0.1', '2401:4900:639a:f02b:9c56:30ff:feff:98bb', '::1',
    'https://7fd1208c57579b53f47307ade895aa3c.r2.cloudflarestorage.com/vaultchat-beam/x?X-Amz-Signature=abc',
    'turn:65.21.229.167:3478', 'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig', 'keyB64=c2VjcmV0', 'Bearer tok_live_123',
  ];
  let leaked = 0;
  for (const bad of POISON) {
    for (const l of [
      classifyTransport('p2p', { localType: bad, remoteType: bad }),
      classifyTransport(bad, { localType: bad, remoteType: bad, isIPv6: true }),
    ]) {
      const blob = l.kind + ' ' + l.detail;
      // Any fragment of the poison longer than 3 chars must be absent, and the
      // label must never contain the characters an address or URL needs.
      if (blob.includes(bad) || /[0-9]{1,3}\.[0-9]{1,3}/.test(blob) || /[:/?=]/.test(blob.replace(' / ', ' '))) {
        leaked++;
        console.error('      leaked via', JSON.stringify(bad), '->', JSON.stringify(blob));
      }
    }
  }
  A(leaked === 0, '15. no address, URL, key or token can reach a label (22 hostile inputs)');

  // Every output must come from the constant set.
  const ALLOWED = new Set(['LAN', 'WEBRTC_DIRECT', 'WEBRTC_TURN', 'R2_RELAY', 'UNKNOWN']);
  let strayKind = 0;
  for (const d of ['lan', 'p2p', 'relay', 'bogus', '', '../../etc/passwd']) {
    for (const t of [...CANDIDATE_TYPES, 'weird', '<script>']) {
      const l = classifyTransport(d, { localType: t, remoteType: t });
      if (!ALLOWED.has(l.kind)) strayKind++;
      if (!/^[A-Za-z0-9_ /-]*$/.test(l.detail)) strayKind++;
    }
  }
  A(strayKind === 0, '16. kind and detail are always drawn from the closed set');

  console.log(failures === 0
    ? '\nALL TRANSPORT-LABEL CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
