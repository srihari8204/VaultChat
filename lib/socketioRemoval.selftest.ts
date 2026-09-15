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

assert.equal(pkg.dependencies && pkg.dependencies['socket.io-client'], undefined, 'mobile package must not depend on socket.io-client');
assert.equal(lock.packages && lock.packages['node_modules/socket.io-client'], undefined, 'lockfile must not install socket.io-client');
assert.ok(!socket.includes('socket.io-client'), 'mobile socket facade must not import socket.io-client');
assert.ok(!socket.includes('ioClient('), 'mobile socket facade must not construct Socket.IO');
assert.ok(socket.includes("export type TransportName = 'ccwire'"), 'mobile runtime must select CC-Wire');
assert.ok(!events.includes('switchToLegacy'), 'CC-Wire event facade must not fall back to Socket.IO');
assert.ok(apiMain.includes('os.Getenv("SOCKET_IO_ENABLED") != "0"'), 'server must keep Socket.IO compatibility enabled by default');
assert.ok(apiMain.includes('mux.Handle("/socket.io/", hub.Handler())'), 'server must still expose the legacy/admin mount unless disabled');
assert.ok(apiMain.includes('realtime.RegisterCCWire(mux, hub)'), 'server must mount CC-Wire alongside the legacy path');
assert.ok(ccwire.includes('func CCWireEnabled() bool { return os.Getenv("CCWIRE_WS") == "1" }'), 'CC-Wire server endpoint must stay explicitly gated');

console.log('Socket.IO replacement audit: mobile runtime is CC-Wire-only; server has safe legacy/admin compatibility gate.');
