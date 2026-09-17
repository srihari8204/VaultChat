// Run: npx tsx lib/socketioRemoval.selftest.ts
//
// The standing guard that Socket.IO does not come back.
//
// WHAT CHANGED, AND WHY THIS FILE CHANGED WITH IT
//
// This test used to assert the DUAL-STACK policy: mobile on CC-Wire, but the
// server still mounting /socket.io/ by default for the admin console and any
// client installed before the migration. Two of its assertions actively
// required `SOCKET_IO_ENABLED != "0"` and `mux.Handle("/socket.io/", ...)` to
// be present in main.go.
//
// That policy is finished. Socket.IO is removed outright: the Go server no
// longer imports it, the mount is gone, and admin/index.html — the last
// consumer — streams GET /admin/events over SSE instead. Leaving the old
// assertions in place would have failed the suite for doing exactly what was
// asked, so they are replaced by their opposites: the mount must be ABSENT and
// the SSE firehose must be mounted.
//
// The dependency assertions below are unchanged and are the ones that matter
// most, because they are what a future `npm install socket.io-client` trips
// over. That includes dev-only installs: a bench harness needing Socket.IO is
// not a reason to put it back in the lockfile, and this test is where that
// argument gets settled.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const socket = read('lib/socket.ts');
const events = read('lib/ccwire/eventsSocket.ts');
const apiMain = read('vaultchat-backend-go/cmd/api/main.go');
const ccwire = read('vaultchat-backend-go/internal/realtime/ccwire.go');
const goMod = read('vaultchat-backend-go/go.mod');
const adminPage = read('admin/index.html');

// ── Mobile: CC-Wire only, no way back ────────────────────────────────
assert.equal(pkg.dependencies && pkg.dependencies['socket.io-client'], undefined, 'mobile package must not depend on socket.io-client');
assert.equal(pkg.devDependencies && pkg.devDependencies['socket.io-client'], undefined, 'socket.io-client must not return as a devDependency either');
assert.equal(lock.packages && lock.packages['node_modules/socket.io-client'], undefined, 'lockfile must not install socket.io-client');
assert.ok(!socket.includes('socket.io-client'), 'mobile socket facade must not import socket.io-client');
assert.ok(!socket.includes('ioClient('), 'mobile socket facade must not construct Socket.IO');
assert.ok(socket.includes("export type TransportName = 'ccwire'"), 'mobile runtime must select CC-Wire');
assert.ok(!events.includes('switchToLegacy'), 'CC-Wire event facade must not fall back to Socket.IO');

// ── Go server: Socket.IO gone, CC-Wire and the SSE firehose mounted ──
assert.ok(!apiMain.includes('mux.Handle("/socket.io/"'), 'server must not mount /socket.io/ any more');
assert.ok(!apiMain.includes('hub.Handler()'), 'the Socket.IO HTTP handler must not be referenced');
assert.ok(apiMain.includes('realtime.RegisterCCWire(mux, hub)'), 'server must mount CC-Wire');
assert.ok(apiMain.includes('realtime.RegisterAdminSSE(mux, hub)'), 'server must mount the admin SSE firehose — without it the admin console has no event source at all');
assert.ok(ccwire.includes('func CCWireEnabled() bool { return os.Getenv("CCWIRE_WS") == "1" }'), 'CC-Wire server endpoint must stay explicitly gated');

// ── Go modules: the Socket.IO stack is gone, WebTransport is NOT ─────
// webtransport-go is load-bearing for CC-Wire's HTTP/3 carrier
// (ccwire_webtransport.go). It shares the zishang520 namespace with the
// Socket.IO packages, so a careless prune takes the fastest transport with it.
assert.ok(!goMod.includes('zishang520/socket.io'), 'go.mod must not require zishang520/socket.io');
assert.ok(!goMod.includes('zishang520/engine.io'), 'go.mod must not require zishang520/engine.io');
assert.ok(goMod.includes('zishang520/webtransport-go'), 'webtransport-go must REMAIN — CC-Wire HTTP/3 depends on it');

// ── Admin console: SSE, and no CDN script ───────────────────────────
assert.ok(!adminPage.includes('cdn.socket.io'), 'admin console must not load Socket.IO from a CDN');
assert.ok(adminPage.includes('/admin/events'), 'admin console must stream the SSE firehose');
assert.ok(adminPage.includes("'x-admin-key'"), 'admin console must authenticate the stream with the x-admin-key header, not a URL query');

console.log('Socket.IO removal audit: mobile is CC-Wire-only, Go server has no Socket.IO, admin console is on SSE, webtransport-go intact.');
