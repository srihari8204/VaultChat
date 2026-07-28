// lib/icePriority.ts — IPv6-first ICE candidate prioritization + win telemetry.
//
// Biases WebRTC ICE so IPv6 host candidates are checked before IPv4, and long
// before the coturn relay. On Jio/Airtel (IPv6-native, IPv4 behind CGNAT) this
// flips the most expensive case — CGNAT mobile↔mobile relay — into free direct
// P2P whenever the carrier's IPv6 path works. We rewrite the priority field of
// every trickled candidate (sent AND received) so both peers order IPv6 pairs
// first; ICE still falls through to IPv4/relay automatically if IPv6 fails.
//
// Pure functions (no react-native-webrtc import) → unit-checkable in Node.
// Wired into lib/vaultBeamDirect.ts at the seal(send)/open(receive) seams.

// Priority tiers (local_pref, 0..65535; higher = tried first).
export const ICE_LOCAL_PREF = {
  ipv6Host:      65535, // free direct, best case (Jio↔Jio, WiFi dual-stack)
  ipv4Host:      60000, // free direct on LAN / non-CGNAT NAT via hole-punch
  ipv6Reflexive: 50000, // IPv6 seen through a firewall
  ipv4Reflexive: 40000, // IPv4 public addr via STUN (fails under symmetric CGNAT)
  ipv6Relay:     15000, // coturn over IPv6 — you pay
  ipv4Relay:     10000, // coturn over IPv4 — you pay, last resort
} as const;
export type CandidateClass = keyof typeof ICE_LOCAL_PREF;

interface ParsedCandidate {
  prefix: string; foundation: string; component: number; transport: string;
  priority: number; address: string; port: number; type: string; rest: string[];
}

// SDP candidate grammar (RFC 8445), space-delimited:
//   foundation component transport priority address port typ <type> ...
export function parseCandidate(line: string): ParsedCandidate | null {
  if (!line) return null;
  const prefix = line.startsWith('a=') ? 'a=' : '';
  const core = line.replace(/^a=/, '').replace(/^candidate:/, '');
  const p = core.split(' ');
  if (p.length < 8 || p[6] !== 'typ') return null;
  return {
    prefix, foundation: p[0], component: Number(p[1]), transport: p[2],
    priority: Number(p[3]), address: p[4], port: Number(p[5]), type: p[7], rest: p.slice(8),
  };
}

/** True if the connection-address is an IPv6 literal (has ':', no '.'). */
export function isCandidateIPv6(line: string): boolean {
  const parsed = parseCandidate(line);
  if (!parsed) return false;
  // IPv4-mapped (::ffff:1.2.3.4) and mDNS *.local names have a '.' → treated as
  // non-IPv6, so we don't over-prioritize an address whose family is uncertain.
  return parsed.address.includes(':') && !parsed.address.includes('.');
}

/** Classify a candidate line into one of the ICE_LOCAL_PREF tiers. */
export function classifyCandidate(line: string): CandidateClass | null {
  const parsed = parseCandidate(line);
  if (!parsed) return null;
  const v6 = isCandidateIPv6(line);
  switch (parsed.type) {
    case 'host':  return v6 ? 'ipv6Host' : 'ipv4Host';
    case 'srflx':
    case 'prflx': return v6 ? 'ipv6Reflexive' : 'ipv4Reflexive';
    case 'relay': return v6 ? 'ipv6Relay' : 'ipv4Relay';
    default:      return null;
  }
}

// RFC 8445 §5.1.2.1: priority = 2^24·type_pref + 2^8·local_pref + (256 − component).
// type_pref keeps hosts above reflexives above relay; local_pref sorts IPv6 above
// IPv4 within a type. Both together give ipv6Host > ipv4Host > … > ipv4Relay.
const TYPE_PREF: Record<string, number> = { host: 126, prflx: 110, srflx: 100, relay: 0 };

export function computePriority(type: string, localPref: number, component: number): number {
  const typePref = TYPE_PREF[type] ?? 0;
  return ((typePref << 24) + (localPref << 8) + (256 - component)) >>> 0; // unsigned 32-bit
}

/** Rewrite a candidate line's priority using our tiers. Unparseable → unchanged. */
export function reprioritizeCandidate(line: string): string {
  const parsed = parseCandidate(line);
  if (!parsed) return line;
  const cls = classifyCandidate(line);
  if (!cls) return line;
  const p = line.replace(/^a=/, '').replace(/^candidate:/, '').split(' ');
  p[3] = String(computePriority(parsed.type, ICE_LOCAL_PREF[cls], parsed.component));
  return parsed.prefix + 'candidate:' + p.join(' ');
}

/**
 * Reprioritize a react-native-webrtc candidate object (or the plain
 * {candidate,sdpMid,sdpMLineIndex} we seal over the wire). Idempotent — safe to
 * apply on both send and receive. Non-candidate / end-of-candidates → unchanged.
 */
export function reprioritizeIceObject(cand: any): any {
  if (!cand || typeof cand.candidate !== 'string' || !cand.candidate) return cand;
  return {
    candidate:     reprioritizeCandidate(cand.candidate),
    sdpMid:        cand.sdpMid ?? null,
    sdpMLineIndex: cand.sdpMLineIndex ?? null,
    usernameFragment: cand.usernameFragment,
  };
}

// ── Telemetry: which pair actually won (measure the real IPv6 hit-rate) ──
export interface ConnectionOutcome {
  wonVia: CandidateClass | 'unknown';
  isDirect: boolean;   // host/reflexive = free; relay = you paid
  isIPv6: boolean;
  roundTripTimeMs?: number;
}

/** Parse getStats() into the chosen (nominated, succeeded) pair, or null. */
export function readWinningPair(stats: any): ConnectionOutcome | null {
  if (!stats || typeof stats.forEach !== 'function') return null;
  const get = (id: string) => (typeof stats.get === 'function' ? stats.get(id) : undefined);
  let outcome: ConnectionOutcome | null = null;
  stats.forEach((report: any) => {
    if (report?.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
      const local = get(report.localCandidateId);
      const type: string = local?.candidateType ?? 'unknown';
      const addr: string = local?.address ?? local?.ip ?? '';
      const v6 = addr.includes(':') && !addr.includes('.');
      let wonVia: CandidateClass | 'unknown' = 'unknown';
      if (type === 'host') wonVia = v6 ? 'ipv6Host' : 'ipv4Host';
      else if (type === 'srflx' || type === 'prflx') wonVia = v6 ? 'ipv6Reflexive' : 'ipv4Reflexive';
      else if (type === 'relay') wonVia = v6 ? 'ipv6Relay' : 'ipv4Relay';
      outcome = {
        wonVia, isDirect: type !== 'relay', isIPv6: v6,
        roundTripTimeMs: report.currentRoundTripTime != null ? Math.round(report.currentRoundTripTime * 1000) : undefined,
      };
    }
  });
  return outcome;
}

// ── self-check: `npx tsx lib/icePriority.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('icePriority: ' + m); };
  const v6host = 'candidate:1 1 UDP 2130706431 2401:4900:1c30:8b:1234::5 54321 typ host';
  const v4host = 'candidate:2 1 UDP 2130706431 192.168.1.5 54321 typ host';
  const v6srflx = 'candidate:3 1 UDP 1694498815 2401::9 40000 typ srflx raddr 2401::5 rport 54321';
  const v4srflx = 'candidate:4 1 UDP 1694498815 49.207.1.2 40000 typ srflx raddr 192.168.1.5 rport 54321';
  const v4relay = 'candidate:5 1 UDP 16777215 49.207.9.9 3478 typ relay raddr 192.168.1.5 rport 54321';

  A(parseCandidate(v6host)!.type === 'host', 'parse type');
  A(parseCandidate('garbage tokens here') === null, 'reject garbage');
  A(isCandidateIPv6(v6host) && !isCandidateIPv6(v4host), 'v6 detect');
  A(!isCandidateIPv6('candidate:1 1 UDP 1 ::ffff:1.2.3.4 5 typ host'), 'v4-mapped is not v6');
  A(classifyCandidate(v6host) === 'ipv6Host', 'classify v6 host');
  A(classifyCandidate(v4relay) === 'ipv4Relay', 'classify v4 relay');

  const pri = (l: string) => Number(reprioritizeCandidate(l).split(' ')[3]);
  // The whole point: IPv6 host > IPv4 host > IPv6 srflx > IPv4 srflx > relay.
  A(pri(v6host) > pri(v4host), 'v6 host beats v4 host');
  A(pri(v4host) > pri(v6srflx), 'host beats srflx');
  A(pri(v6srflx) > pri(v4srflx), 'v6 srflx beats v4 srflx');
  A(pri(v4srflx) > pri(v4relay), 'srflx beats relay');

  // Round-trips + idempotent + fail-safe.
  A(reprioritizeCandidate(v6host).startsWith('candidate:'), 're-serialize prefix');
  A(reprioritizeCandidate(reprioritizeCandidate(v6host)) === reprioritizeCandidate(v6host), 'idempotent');
  A(reprioritizeCandidate('not a candidate') === 'not a candidate', 'fail-safe passthrough');
  A(reprioritizeIceObject(null) === null && reprioritizeIceObject({}).candidate === undefined, 'ice-object guards');

  console.log('icePriority self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
