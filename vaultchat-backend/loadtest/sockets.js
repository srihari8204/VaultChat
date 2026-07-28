// vaultchat-backend/loadtest/sockets.js
//
// WebSocket fan-out load test. Opens N concurrent Socket.IO connections
// (one per simulated user), each authenticated with a JWT, and reports
// connection success rate + server memory pressure.
//
// Why we need this: HTTP RPS doesn't tell us how many idle sockets the
// box can hold. For 10K-user launch we need ~5-7K idle WS at peak (most
// users won't have the app open in the foreground).
//
// Run:
//   node loadtest/sockets.js \
//     --base wss://api.corefinite.com \
//     --jwt-list ./jwt-list.txt \
//     --count 1000
//
// jwt-list.txt: one JWT per line. Pre-bake by running auth/verify-otp for
// N test accounts and saving the access tokens.

const { io }     = require('socket.io-client');
const fs         = require('fs');
const { argv }   = require('process');

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : def;
}

const BASE   = arg('base', process.env.WS_BASE || 'http://127.0.0.1:3000');
const JWTS   = arg('jwt-list');
const COUNT  = parseInt(arg('count', '500'), 10);
const RAMP_MS = parseInt(arg('ramp-ms', '50'), 10); // connect this many ms apart

if (!JWTS) {
  console.error('usage: node loadtest/sockets.js --jwt-list <file> [--base URL] [--count N] [--ramp-ms 50]');
  process.exit(1);
}

const tokens = fs.readFileSync(JWTS, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
if (tokens.length === 0) { console.error('no tokens in', JWTS); process.exit(1); }

const stats = {
  attempted: 0, connected: 0, failed: 0, disconnected: 0,
  start: Date.now(), errors: new Map(),
};

function dump() {
  const elapsed = Math.round((Date.now() - stats.start) / 1000);
  const rss     = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(
    `[${elapsed}s] attempted=${stats.attempted} ` +
    `connected=${stats.connected} failed=${stats.failed} ` +
    `disconnected=${stats.disconnected} client-rss=${rss}MB`,
  );
  if (stats.errors.size) {
    for (const [k, v] of stats.errors) console.log(`   error '${k}' ×${v}`);
  }
}
setInterval(dump, 5000);

let next = 0;
const sockets = [];
function spawn() {
  if (stats.attempted >= COUNT) return;
  const token = tokens[next % tokens.length];
  next++;
  stats.attempted++;
  const s = io(BASE, {
    transports: ['websocket'],
    auth:       { token },
    reconnection: false,
  });
  sockets.push(s);
  s.on('connect',    () => { stats.connected++; });
  s.on('disconnect', () => { stats.disconnected++; });
  s.on('connect_error', (e) => {
    stats.failed++;
    const k = e?.message || 'unknown';
    stats.errors.set(k, (stats.errors.get(k) || 0) + 1);
  });
}

const timer = setInterval(() => {
  spawn();
  if (stats.attempted >= COUNT) clearInterval(timer);
}, RAMP_MS);

// Hold connections for 5 minutes then drain
setTimeout(() => {
  console.log('Draining…');
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  setTimeout(() => { dump(); process.exit(0); }, 2000);
}, 5 * 60 * 1000);
