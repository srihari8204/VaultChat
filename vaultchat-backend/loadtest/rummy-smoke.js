// rummy-smoke.js — closed-loop capacity ramp against the LOCAL bench go-api.
//
// SCOPE, stated up front so the report cannot overclaim:
//   - Target is VaultChat's OWN backend (go-api /health), NOT the rummy game
//     engine. The rummy engine is a separate Go server; the local copy was
//     found in a crash loop (its Postgres was down), so it is not tested here.
//   - /health touches Postgres AND Redis (the handler returns db+redis state),
//     so this exercises the real HTTP stack, router, and both backends — not a
//     static string.
//   - One Windows laptop drives the load AND hosts the server, so every number
//     is a LOWER BOUND. Prod is a 12-core/62GB Hetzner box; it measures better.
//
// MODEL: closed-loop. We hold `conc` requests in flight continuously and
// measure achieved throughput (req/s) and latency. The throughput CEILING is
// the answer to "how many users": at a realistic 1 req/s per active user,
// ceiling RPS ≈ concurrent active users the tier can hold.

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:14000';
const PATH = process.env.LT_PATH || '/health';
const { hostname, port } = new URL(BASE);

// keepAlive so we reuse a small socket pool instead of exhausting Windows
// ephemeral ports — the generator limit that makes a naive 100k-socket test
// meaningless.
const agent = new http.Agent({ keepAlive: true, maxSockets: 100000, maxFreeSockets: 100000 });

function once() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.get({ hostname, port, path: PATH, agent }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        resolve({ ok: res.statusCode === 200, ms });
      });
    });
    req.on('error', () => resolve({ ok: false, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, ms: 10000 }); });
  });
}

async function tier(conc, seconds) {
  const lat = [];
  let ok = 0, err = 0, running = true;
  const endAt = Date.now() + seconds * 1000;
  // one persistent worker per concurrency slot; each loops closed-loop
  async function worker() {
    while (running && Date.now() < endAt) {
      const r = await once();
      if (r.ok) ok++; else err++;
      lat.push(r.ms);
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, worker));
  running = false;
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const total = ok + err;
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0;
  return {
    conc, seconds: +elapsed.toFixed(1),
    requests: total, rps: +(total / elapsed).toFixed(0),
    errors: err, errPct: +(total ? (err / total) * 100 : 0).toFixed(2),
    p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), p99: +pct(99).toFixed(1),
    max: +(lat[lat.length - 1] || 0).toFixed(1),
  };
}

(async () => {
  const CONC = (process.env.CONC || '50,200,500,1000,2000,4000').split(',').map(Number);
  const SECS = Number(process.env.SECS || 15);
  const out = [];
  // warmup so the first tier is not measuring cold connection setup
  await tier(20, 3);
  for (const c of CONC) {
    const r = await tier(c, SECS);
    out.push(r);
    console.log(JSON.stringify(r));
  }
  require('fs').writeFileSync(process.env.OUT || 'rummy-smoke-results.json',
    JSON.stringify({ base: BASE, path: PATH, secsPerTier: SECS, tiers: out, at: new Date().toISOString() }, null, 2));
  console.log('DONE');
})();
