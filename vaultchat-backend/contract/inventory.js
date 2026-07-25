// vaultchat-backend/contract/inventory.js
//
// Freezes the FULL client-facing surface of the backend as JSON contracts:
//   contract/endpoints.json      every REST endpoint (method + full path) per module
//   contract/socket-events.json  every Socket.IO event (client→server + server→client)
//
// Same pattern as the crypto golden vectors: the committed JSON is the frozen
// copy; check mode re-derives from source and fails on ANY drift. During a
// backend migration the same files are the route-by-route checklist — a Go
// port that drops/renames an endpoint or event fails this before it ships.
//
// Check (CI):  node contract/inventory.js
// Regenerate:  node contract/inventory.js --write   (intentional change only)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Mount prefixes exactly as wired in server.js.
const MOUNTS = {
  'auth.js': '/auth', 'user.js': '/user', 'uploads.js': '/uploads', 'ai.js': '/ai',
  'contacts.js': '/contacts', 'chats.js': '/chats', 'stories.js': '/stories',
  'communities.js': '/communities', 'calls.js': '/call', 'link.js': '/link',
  'gif.js': '/gif', 'channels.js': '/channels', 'games.js': '/games',
  'vaultbeam.js': '/vaultbeam', 'nav.js': '/nav', 'vaultlens.js': '/vaultlens',
  'admin.js': '/api/admin',
};

function deriveEndpoints() {
  const out = {};
  for (const [file, mount] of Object.entries(MOUNTS)) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
    const eps = [];
    const re = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      eps.push(`${m[1].toUpperCase()} ${mount}${m[2] === '/' ? '' : m[2]}`);
    }
    out[file.replace('.js', '')] = eps.sort();
  }
  // server.js-level endpoints (not in route modules).
  out._server = ['GET /health'];
  return out;
}

function deriveSocketEvents() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routeFiles = fs.readdirSync(path.join(ROOT, 'routes'))
    .filter(f => f.endsWith('.js') && !f.endsWith('.legacy'))
    .map(f => fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8'));
  const workers = fs.readdirSync(path.join(ROOT, 'workers'))
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, 'workers', f), 'utf8'));

  const clientToServer = new Set();
  for (const m of server.matchAll(/socket\.on\(\s*'([^']+)'/g)) clientToServer.add(m[1]);
  clientToServer.delete('disconnect'); // lifecycle, not an app event

  const serverToClient = new Set();
  const sources = [server, ...routeFiles, ...workers].join('\n');
  // Direct emits: io.to(...).emit / socket.emit / socket.to(...).emit
  for (const m of sources.matchAll(/\.emit\(\s*'([^']+)'/g)) serverToClient.add(m[1]);
  // Indirect emits routed through helpers with (…, 'event', …) signatures.
  for (const m of sources.matchAll(/(?:emitToUid|fanOutToChat)\(\s*[^,]+,\s*'([^']+)'/g)) serverToClient.add(m[1]);
  // Broadcaster callbacks wired in server.js: newMessage → 'new_message';
  // chatEvent / channel broadcaster call sites in routes pass the event name
  // as the 2nd arg: broadcast.chatEvent(chatId, 'event', …).
  for (const m of sources.matchAll(/chatEvent\(\s*[^,]+,\s*'([^']+)'/g)) serverToClient.add(m[1]);
  for (const m of sources.matchAll(/broadcast\(\s*[^,]+,\s*'([^']+)'/g)) serverToClient.add(m[1]);
  serverToClient.add('new_message'); // via setBroadcasters({ newMessage }) in chats.js

  return {
    clientToServer: [...clientToServer].sort(),
    serverToClient: [...serverToClient].sort(),
  };
}

const derived = {
  endpoints: deriveEndpoints(),
  socketEvents: deriveSocketEvents(),
};

const EP_FILE = path.join(__dirname, 'endpoints.json');
const SE_FILE = path.join(__dirname, 'socket-events.json');

if (process.argv.includes('--write')) {
  fs.writeFileSync(EP_FILE, JSON.stringify(derived.endpoints, null, 2) + '\n');
  fs.writeFileSync(SE_FILE, JSON.stringify(derived.socketEvents, null, 2) + '\n');
  const n = Object.values(derived.endpoints).reduce((a, v) => a + v.length, 0);
  console.log(`wrote contract/endpoints.json (${n} endpoints) + contract/socket-events.json ` +
    `(${derived.socketEvents.clientToServer.length}→server, ${derived.socketEvents.serverToClient.length}→client)`);
} else {
  let ok = true;
  for (const [file, current] of [[EP_FILE, derived.endpoints], [SE_FILE, derived.socketEvents]]) {
    if (!fs.existsSync(file)) {
      console.error(`✗ missing ${file} — run: node contract/inventory.js --write`);
      ok = false;
      continue;
    }
    const frozen = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (frozen !== JSON.stringify(current)) {
      console.error(`✗ ${path.basename(file)}: source has DRIFTED from the frozen contract.`);
      console.error('  If the change is intentional, regenerate with --write and review the diff.');
      ok = false;
    } else {
      console.log(`✓ ${path.basename(file)} matches source`);
    }
  }
  process.exit(ok ? 0 : 1);
}
