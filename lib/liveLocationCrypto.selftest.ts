// lib/liveLocationCrypto.selftest.ts
//
// Node proof that a live position encrypted with a session key round-trips only
// with that key, and that the relayed blob leaks no coordinates. Mirrors the
// module's AES-256-GCM codec against the same @noble primitive.
// Run:  npx tsx lib/liveLocationCrypto.selftest.ts

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

function newKey(): string { return Buffer.from(randomBytes(32)).toString('base64'); }
function enc(keyB64: string, pos: any): string | null {
  try {
    const key = Buffer.from(keyB64, 'base64'); if (key.length !== 32) return null;
    const nonce = randomBytes(12);
    const ct = gcm(key, nonce).encrypt(Buffer.from(JSON.stringify(pos), 'utf8'));
    const out = new Uint8Array(nonce.length + ct.length); out.set(nonce, 0); out.set(ct, nonce.length);
    return Buffer.from(out).toString('base64');
  } catch { return null; }
}
function dec(keyB64: string, blobB64: string): any {
  try {
    const key = Buffer.from(keyB64, 'base64'); if (key.length !== 32) return null;
    const buf = Buffer.from(blobB64, 'base64'); if (buf.length <= 12) return null;
    const pt = gcm(key, buf.subarray(0, 12)).decrypt(new Uint8Array(buf.subarray(12)));
    const o = JSON.parse(Buffer.from(pt).toString('utf8'));
    return (o && typeof o.lat === 'number' && typeof o.lng === 'number') ? o : null;
  } catch { return null; }
}

let passed = 0;
function assert(c: boolean, m: string): void { if (!c) { console.error('  ✗', m); throw new Error(m); } passed++; console.log('  ✓', m); }

function main(): void {
  console.log('liveLocationCrypto self-test\n');
  const key = newKey(), wrong = newKey();
  const pos = { lat: 12.97123, lng: 77.59456, address: 'MG Road' };

  const blob = enc(key, pos)!;
  const back = dec(key, blob);
  assert(back && back.lat === pos.lat && back.lng === pos.lng, 'right key recovers the position');
  assert(!blob.includes('77.59') && !blob.includes('MG Road'), 'relayed blob leaks no coordinates/address');
  assert(dec(wrong, blob) === null, 'wrong session key cannot decrypt the blob');
  assert(enc('not-32-bytes', pos) === null, 'a malformed key fails closed (no encryption)');

  // Two encryptions of the same position differ (fresh nonce each time).
  assert(enc(key, pos) !== enc(key, pos), 'each update uses a fresh nonce (ciphertexts differ)');

  console.log(`\nALL ${passed} LIVE-LOCATION CHECKS PASSED`);
}
main();
