import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compose = spawnSync(
  'docker',
  [
    'compose',
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.prod.yml',
    '-f', 'docker-compose.http3.yml',
    'config', '--format', 'json',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HTTP3_HTTP_BIND: '127.0.0.1:18080',
      HTTP3_TCP_BIND: '127.0.0.1:18443',
      HTTP3_UDP_BIND: '127.0.0.1:18443',
    },
  },
);

assert.equal(compose.status, 0, compose.stderr || 'docker compose config failed');
const edge = JSON.parse(compose.stdout).services['h3-edge'];
assert.ok(edge, 'h3-edge service is missing');

const port = (host, published, target, protocol) =>
  edge.ports.some((p) => p.host_ip === host && p.published === published
    && p.target === target && p.protocol === protocol);

assert.ok(port('127.0.0.1', '18080', 80, 'tcp'), 'safe HTTP staging bind is missing');
assert.ok(port('127.0.0.1', '18443', 443, 'tcp'), 'safe HTTPS staging bind is missing');
assert.ok(port('127.0.0.1', '18443', 443, 'udp'), 'safe HTTP/3 staging bind is missing');
assert.ok(edge.depends_on.caddy && edge.depends_on.minio, 'edge upstream dependencies are incomplete');

const caddy = readFileSync(new URL('../caddy/Caddyfile.http3', import.meta.url), 'utf8');
for (const required of [
  'protocols h1 h2 h3',
  'header Alt-Svc "h3=\\":8443\\"; ma=300"',
  'reverse_proxy caddy:80',
  'path /vaultchat-media /vaultchat-media/*',
  'reverse_proxy minio:9000',
  'header_up X-Real-IP {remote_host}',
  'max_size 104857600',
  'http://api.corefinite.com',
  'redir https://api.corefinite.com{uri} permanent',
]) {
  assert.ok(caddy.includes(required), `Caddy edge is missing: ${required}`);
}

console.log('HTTP/3 edge structure: OK');
