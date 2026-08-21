// transportObservability.selftest.ts — the transport label must actually be
// recorded, and must never carry a secret.
//
// WHY STRUCTURAL
//
// The classification itself is pure and fully exercised in transportLabel.ts.
// What that cannot check is the part that goes wrong in practice: whether the
// classifier is CALLED at every point a transport is chosen, whether the ICE
// observation is handed the transfer it belongs to, and whether a blind call can
// overwrite an observed one. Those are wiring facts, and wiring is what silently
// stops happening when someone refactors a call site.
//
// vaultBeamController.ts and vaultBeamDirect.ts both pull in react-native and
// expo modules, so they cannot be imported under `npx tsx`. Reading the source
// is the available check, and it is a real one — every assertion below
// corresponds to a specific way the observability goes quiet or turns unsafe.
//
// STRUCTURAL: reads source, moves no bytes, opens no socket.
//
//   npx tsx lib/vaultBeam/transportObservability.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const CTRL = readFileSync(join(ROOT, 'lib', 'vaultBeamController.ts'), 'utf8');
const DIRECT = readFileSync(join(ROOT, 'lib', 'vaultBeamDirect.ts'), 'utf8');
const ICE = readFileSync(join(ROOT, 'lib', 'icePriority.ts'), 'utf8');

/** Strip comments so prose about a field cannot satisfy a check. */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const C = code(CTRL);
const D = code(DIRECT);
const I = code(ICE);

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam transport observability — wiring\n');

// ── it is recorded, not merely computed ────────────────────────────
A(/transport\?: TransportKind/.test(C),
  '1. the transfer state carries a transport kind');
A(/transportDetail\?: string/.test(C),
  '2. and the candidate-pair detail beside it');
A(/export function noteTransport\(/.test(C),
  '3. there is one place that records it');
A(/classifyTransport\(driverId, ice\)/.test(C),
  '4. which delegates to the tested pure classifier');

// ── called at every transport decision ─────────────────────────────
A(/noteTransport\(transferId, tier\)/.test(C),
  '5. the direct tier (LAN or p2p) is recorded when serveDirect returns');
A((C.match(/noteTransport\(transferId, 'relay'\)/g) ?? []).length >= 2,
  '6. the R2 relay is recorded on BOTH the send and the receive path');

// ── the ICE observation is bound to its transfer ───────────────────
A(/function logIceWin\(pc: any, tag: string, transferId\?: string\)/.test(D),
  '7. the ICE observer is given the transfer it belongs to');
A(/logIceWin\(pc, 'send', g\.transferId\)/.test(D) && /logIceWin\(pc, 'recv', g\.transferId\)/.test(D),
  '8. and both call sites pass it — a sender-only wiring would report half the transfers');
A(/m\.noteTransport\(transferId, 'p2p', \{/.test(D),
  '9. the observed pair reaches the transfer state, not just the perf ring');

// ── THE DEMOTION GUARD ─────────────────────────────────────────────
//
// Two callers report a p2p transfer. The ICE hook knows the candidate pair; the
// tier return knows only the string "p2p", which classifies as WEBRTC_DIRECT.
// If the blind one can land last it rewrites a genuine WEBRTC_TURN as direct,
// and the relay-rate metric reads zero on exactly the networks that need TURN.
A(/if \(!ice && cur\.transport && cur\.transport\.startsWith\('WEBRTC'\) && label\.kind\.startsWith\('WEBRTC'\)\) return;/.test(C),
  '10. a blind call cannot demote an ICE-observed WEBRTC label');

// ── relay detection reads BOTH ends ────────────────────────────────
A(/localType: string;/.test(I) && /remoteType: string;/.test(I),
  '11. the ICE outcome reports both ends of the winning pair');
A(/isDirect: type !== 'relay' && rtype !== 'relay'/.test(I),
  '12. either end relaying counts as relayed — the asymmetric-NAT case');
A(/const remote = get\(report\.remoteCandidateId\);/.test(I),
  '13. the remote candidate is actually looked up');

// ── NOTHING SENSITIVE MAY BE PASSED IN ─────────────────────────────
//
// DirectGeom carries keyB64 and token, and the getStats object carries
// addresses. The classifier emits from a closed set, but the cheapest place to
// catch a mistake is the call site: assert no secret-bearing identifier appears
// in any noteTransport argument list.
const calls = [...C.matchAll(/noteTransport\(([^;]*?)\)\s*;/gs), ...D.matchAll(/noteTransport\(([^;]*?)\)\s*\)/gs)]
  .map(m => m[1]);
A(calls.length >= 4, `14. found the call sites to inspect (${calls.length})`);
const FORBIDDEN = /keyB64|secret|token|password|credential|\.address|\.ip\b|url|signature/i;
A(calls.every(a => !FORBIDDEN.test(a)),
  '15. no key, token, address or URL is passed to noteTransport');
A(calls.filter(a => /localType|remoteType|isIPv6/.test(a)).length >= 1,
  '16. the ICE call passes candidate TYPES and the address family, nothing else');

// ── observability must not be able to break a transfer ─────────────
A(/catch \{ \/\* diagnostics never break a transfer \*\/ \}/.test(CTRL),
  '17. noteTransport swallows its own errors');
A(/\.catch\(\(\) => \{\}\);/.test(D),
  '18. and the dynamic import that reaches it cannot reject into the data path');

// ── the architecture was not redesigned ────────────────────────────
A(/serveDirect/.test(C) && /receiveDirect/.test(C),
  '19. the existing direct path is still the one in use');
A(!/new (Reconnect|Retry)Scheduler|setInterval\(/.test(C.split('noteTransport')[1] ?? ''),
  '20. no scheduler or timer was introduced alongside the labelling');

console.log(failures === 0
  ? '\nALL TRANSPORT-OBSERVABILITY CHECKS PASSED ✓  (device evidence separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
