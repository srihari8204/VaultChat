// lib/iceCredentials.selftest.ts — run: npx tsx lib/iceCredentials.selftest.ts
//
// Guards the one thing in the ICE cache that can fail silently: agreement with
// the credential format the SERVER actually emits. If userTurn() ever changes
// the username shape, credentialExpiryMs() starts returning 0, the cache
// quietly falls back to the blunt MAX_CACHE_MS cap, and nothing anywhere
// reports it. These cases are transcribed from
// vaultchat-backend-go/internal/routes/user.go:userTurn.

import {
  cacheUntil, credentialExpiryMs, EXPIRY_MARGIN_MS, MAX_CACHE_MS,
  type IceServerLike,
} from './iceCredentials';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const NOW = 1_800_000_000_000;          // fixed clock; no Date.now() in assertions
const HOUR = 3600_000;
const uid = '7b1e0c5a-0000-4000-8000-000000000001';

/** Exactly what userTurn() returns when TURN_SECRET is set (24 h TTL). */
function realResponse(expiryUnix: number): IceServerLike[] {
  const username = `${expiryUnix}:${uid}`;
  return [
    { urls: 'stun:stun.l.google.com:19302' },                       // no username
    { urls: ['turn:turn.corefinite.com:3478?transport=udp',
             'turn:turn.corefinite.com:3478?transport=tcp'], username, credential: 'BASE64MAC=' },
    { urls: 'turns:turn.corefinite.com:5349?transport=tcp', username, credential: 'BASE64MAC=' },
  ];
}

/** What userTurn() returns with no TURN_SECRET — STUN only, no credentials. */
const STUN_ONLY_RESPONSE: IceServerLike[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

console.log('credentialExpiryMs — parses the server\'s "<expiry>:<uid>" username:');
const in24h = Math.floor((NOW + 24 * HOUR) / 1000);
check('real 24h response', credentialExpiryMs(realResponse(in24h)), in24h * 1000);
check('STUN-only response yields 0', credentialExpiryMs(STUN_ONLY_RESPONSE), 0);
check('empty list yields 0', credentialExpiryMs([]), 0);
check('picks the EARLIEST of mixed expiries', credentialExpiryMs([
  { urls: 'turn:a', username: '2000:u' }, { urls: 'turn:b', username: '1000:u' },
]), 1000 * 1000);
check('malformed username yields 0', credentialExpiryMs([{ urls: 'turn:a', username: 'not-a-number:u' }]), 0);
check('negative expiry ignored', credentialExpiryMs([{ urls: 'turn:a', username: '-5:u' }]), 0);
check('missing username ignored', credentialExpiryMs([{ urls: 'turn:a', credential: 'x' }]), 0);

console.log('\ncacheUntil — never past the credential, never past the cap:');
check('24h credential is capped at MAX_CACHE_MS',
  cacheUntil(realResponse(in24h), NOW), NOW + MAX_CACHE_MS);

// A credential expiring in 30 min must win over the 1 h cap.
const in30m = Math.floor((NOW + 30 * 60_000) / 1000);
check('30m credential beats the cap (margin applied)',
  cacheUntil(realResponse(in30m), NOW), in30m * 1000 - EXPIRY_MARGIN_MS);

check('STUN-only falls back to the cap',
  cacheUntil(STUN_ONLY_RESPONSE, NOW), NOW + MAX_CACHE_MS);

// Anything already expired, or inside the refresh margin, must not be cached.
const in2m = Math.floor((NOW + 2 * 60_000) / 1000);
check('credential inside the margin is NOT cached', cacheUntil(realResponse(in2m), NOW), 0);
const past = Math.floor((NOW - HOUR) / 1000);
check('already-expired credential is NOT cached', cacheUntil(realResponse(past), NOW), 0);

// The boundary: exactly at the margin is not cacheable; one ms past it is.
const atMargin = (NOW + EXPIRY_MARGIN_MS) / 1000;
check('exactly at the margin is NOT cached', cacheUntil([{ urls: 'turn:a', username: `${atMargin}:u` }], NOW), 0);
const justPast = (NOW + EXPIRY_MARGIN_MS + 1000) / 1000;
check('one second past the margin IS cached',
  cacheUntil([{ urls: 'turn:a', username: `${justPast}:u` }], NOW), justPast * 1000 - EXPIRY_MARGIN_MS);

console.log(failures === 0
  ? '\nALL ICE CREDENTIAL CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
