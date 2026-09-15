// Run: npx tsx lib/socket.transport.selftest.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const socket = read('lib/socket.ts');
const eventsSocket = read('lib/ccwire/eventsSocket.ts');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.equal(pkg.dependencies?.['socket.io-client'], undefined, 'mobile app must not depend on socket.io-client');
assert.equal(lock.packages?.['node_modules/socket.io-client'], undefined, 'lockfile must not install socket.io-client');
assert.equal(lock.packages?.['']?.dependencies?.['socket.io-client'], undefined, 'root lock deps must not include socket.io-client');

assert.ok(!socket.includes('socket.io-client'), 'lib/socket.ts must not import socket.io-client');
assert.ok(!socket.includes('ioClient('), 'lib/socket.ts must not construct a Socket.IO client');
assert.ok(!socket.includes("'socketio'"), 'lib/socket.ts must not expose a socketio transport choice');
assert.match(socket, /export type TransportName = 'ccwire';/);
assert.match(socket, /export function selectTransport\(\): TransportName \{\s*return 'ccwire';\s*\}/);
assert.match(socket, /new CCWireEventSocket\(/, 'shared facade must be CC-Wire backed');
assert.match(socket, /webSocketFallback:/, 'WebTransport must fall back to WebSocket');
assert.match(socket, /carrier: webTransport \? 'rust-wt' : webSocket \? 'rust-ws' : 'ws'/,
  'carrier order must support Rust WT, Rust WS, and platform WS');

assert.ok(!eventsSocket.includes('LegacySocket'), 'CC-Wire facade must not keep a legacy socket bridge');
assert.ok(!eventsSocket.includes('switchToLegacy'), 'CC-Wire facade must not switch to Socket.IO after startup');
assert.match(eventsSocket, /requireAppEvents: true/, 'app-event capability remains required');
assert.match(eventsSocket, /body_field: 100/, 'named app events must use the protobuf AppEvent body');

console.log('Socket transport replacement: mobile runtime has no Socket.IO client path and uses CC-Wire/WebTransport/WebSocket fallback');
