// metricsWiring.selftest.ts — the timing marks must sit at HONEST sites.
//
// transferMetrics.ts can only be as truthful as its call sites. Its own unit
// test proves first-write-wins and that a cheaper event cannot satisfy
// `firstVerifiedChunk`; this one proves the calls are actually placed where
// verification happens, in the code that production runs.
//
// The specific trap this guards:
//
//   receiveTransfer() credits blocks from `opts.haveBytes` during hydration —
//   bytes a PREVIOUS run already landed on disk. Those blocks are real, but
//   this session did not receive them. Stamping first-verified-chunk there
//   would make every resumed transfer report ~0 ms forever, which is exactly
//   the kind of flattering, meaningless number the metric exists to avoid.
//
// STRUCTURAL: reads source, sends nothing, transfers nothing.
//
//   npx tsx lib/vaultBeam/metricsWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
// Comments AND import statements go: an `import { markFirstVerifiedChunk }`
// line names every mark at position ~0, which would satisfy any "is it called
// here?" check and invert every ordering assertion below.
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const XFER = strip(read('lib', 'vaultBeamTransfer.ts'));
const DIRECT = strip(read('lib', 'vaultBeamDirect.ts'));
const CTRL = strip(read('lib', 'vaultBeamController.ts'));

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam metrics wiring — are the marks honest?\n');

// ── 1. THE LIVE PATH IS INSTRUMENTED ───────────────────────────────
A(/markFirstVerifiedChunk\(opts\.transferId\)/.test(XFER),
  '1. the relay receive path stamps first-verified-chunk');
A(/markFirstVerifiedChunk\(g\.transferId\)/.test(DIRECT),
  '2. the direct receive path stamps it too');
A(/markStart\(transferId\)/.test(CTRL),
  '3. the controller — which owns the transfer — starts the clock');
A(!/markStart\(/.test(XFER) && !/markStart\(/.test(DIRECT),
  '4. and neither transport restarts it, so a direct→relay handover keeps one window');

// ── 2. THE HYDRATION TRAP ──────────────────────────────────────────
// Split receiveTransfer at the relay download loop. Everything before it is
// hydration/credit; the mark must appear only after.
const relayLoopAt = XFER.indexOf('await downloadBlock(');
A(relayLoopAt > 0, '5. the relay download call is locatable');
const beforeDownload = XFER.slice(0, relayLoopAt);
A(/opts\.haveBytes/.test(beforeDownload),
  '6. the hydration credit really does live before it (trap is present)');
A(!/markFirstVerifiedChunk/.test(beforeDownload),
  '7. NOTHING before the first real download stamps first-verified-chunk');

// The mark must follow the download, and precede/accompany the bitmap commit.
const afterDownload = XFER.slice(relayLoopAt);
const markAt = afterDownload.indexOf('markFirstVerifiedChunk');
const commitAt = afterDownload.indexOf('got.add(blockIndex)');
A(markAt > 0 && commitAt > 0 && markAt < commitAt,
  '8. it is stamped after verification and at the bitmap commit, not before');

// ── 3. THE DIRECT PATH ORDERING ────────────────────────────────────
const writeAt = DIRECT.indexOf('await writeCipherChunk(');
const dMarkAt = DIRECT.indexOf('markFirstVerifiedChunk');
A(writeAt > 0 && dMarkAt > writeAt,
  '9. direct stamps only AFTER writeCipherChunk (GCM verify + positional write)');

// ── 4. CHEAPER EVENTS STAY IN THEIR OWN LANE ───────────────────────
for (const [name, src] of [['direct', DIRECT], ['relay', XFER]] as const) {
  const fb = src.indexOf('markFirstByte');
  const fv = src.indexOf('markFirstVerifiedChunk');
  A(fb > 0 && fv > 0 && fb !== fv,
    `10. ${name}: first-byte and first-verified-chunk are distinct call sites`);
}
A(/markTransportConnected/.test(DIRECT) && !/markTransportConnected/.test(XFER),
  '11. transport-connected is stamped where a transport actually connects');
A(!/markFirstVerifiedChunk/.test(CTRL),
  '12. the controller never stamps verification — it cannot observe a chunk');

// ── 5. IT CANNOT FAIL A TRANSFER ───────────────────────────────────
const METRICS = read('lib', 'vaultBeam', 'transferMetrics.ts');
A(!/\bthrow\b/.test(strip(METRICS).split('require.main === module')[0]),
  '13. the metrics module throws nothing in its production half');
A(/export function forget/.test(METRICS) && /forgetMetrics\(/.test(CTRL),
  '14. records are forgotten on terminal state, so the map stays bounded');

// ── 6. THE LOGICAL CHUNK IS UNTOUCHED BY ANY OF THIS ────────────────
A(!/CHUNK_BYTES\s*=/.test(METRICS),
  '15. the metric defines no chunk size — it only observes');

console.log(failures === 0
  ? '\nALL METRICS-WIRING CHECKS PASSED ✓  (measured values need devices)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
