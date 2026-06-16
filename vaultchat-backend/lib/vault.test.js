// lib/vault.test.js — proof for lib/vault.js. Run: node lib/vault.test.js
//
// Covers: AES-GCM round-trip, non-deterministic ciphertext, tag-tamper rejection,
// version/length guards, deterministic + normalized lookup hashes, argon2 verify
// true/false, and that secrets never round-trip back to plaintext.

process.env.VAULTCHAT_MASTER_KEY    = process.env.VAULTCHAT_MASTER_KEY    || require('crypto').randomBytes(32).toString('hex');
process.env.VAULTCHAT_LOOKUP_PEPPER = process.env.VAULTCHAT_LOOKUP_PEPPER || 'test-pepper-not-for-prod';

const v = require('./vault');

let passed = 0;
function assert(c, m) { if (!c) { console.error('  ✗', m); process.exit(1); } passed++; console.log('  ✓', m); }
async function throwsAsync(fn, m) { let t = false; try { await fn(); } catch { t = true; } assert(t, m); }
function throws(fn, m) { let t = false; try { fn(); } catch { t = true; } assert(t, m); }

(async () => {
  console.log('vault self-test\n');

  // AES-GCM round-trip (incl. unicode/emoji — status field allows it)
  const samples = ['user@example.com', '+919876543210', 'Śrihari 🔐 status — हिंदी', ''];
  for (const s of samples) {
    if (s === '') { throws(() => v.encrypt(s === '' ? null : s), 'encrypt rejects null'); continue; }
    const env = v.encrypt(s);
    assert(v.decrypt(env) === s, `round-trips: ${s.slice(0, 16)}`);
    assert(!env.includes(s), 'envelope contains no plaintext');
  }

  // Non-deterministic: same plaintext → different ciphertext (random salt+iv)
  assert(v.encrypt('same') !== v.encrypt('same'), 'ciphertext is non-deterministic');

  // Tag-tamper rejection
  const env = v.encrypt('secret-data');
  const buf = Buffer.from(env, 'base64'); buf[buf.length - 1] ^= 0xff;             // flip a tag byte
  throws(() => v.decrypt(buf.toString('base64')), 'flipped tag byte rejected');
  const buf2 = Buffer.from(env, 'base64'); buf2[20] ^= 0xff;                       // flip a ciphertext byte
  throws(() => v.decrypt(buf2.toString('base64')), 'flipped ciphertext byte rejected');
  const bad = Buffer.from(env, 'base64'); bad[0] = 0x02;                            // wrong version
  throws(() => v.decrypt(bad.toString('base64')), 'wrong version rejected');
  throws(() => v.decrypt('AA";'), 'garbage envelope rejected');

  // Deterministic, normalized lookup hashes
  assert(v.emailLookup('User@Example.com ') === v.emailLookup('user@example.com'), 'email lookup is normalized + stable');
  assert(v.phoneLookup('+91 98765 43210') === v.phoneLookup('+919876543210'), 'phone lookup is normalized + stable');
  assert(v.emailLookup('a@b.com') !== v.emailLookup('c@d.com'), 'different emails → different hash');
  assert(/^[0-9a-f]{64}$/.test(v.emailLookup('a@b.com')), 'lookup hash is 64 hex chars');

  // Argon2id secret hashing (MPIN / answers)
  const mpinHash = await v.hashSecret('204060');
  assert(mpinHash.startsWith('$argon2id$'), 'hashSecret returns an argon2id PHC string');
  assert(!mpinHash.includes('204060'), 'hash does not contain the secret');
  assert(await v.verifySecret('204060', mpinHash) === true, 'verifySecret true on correct secret');
  assert(await v.verifySecret('204061', mpinHash) === false, 'verifySecret false on wrong secret');
  assert(await v.verifySecret('x', 'not-a-hash') === false, 'verifySecret false on malformed hash');

  // Answer normalization feeds the hash consistently
  const ans = await v.hashSecret(v.normalizeAnswer('  Fluffy  THE Cat '));
  assert(await v.verifySecret(v.normalizeAnswer('fluffy the cat'), ans) === true, 'normalized answer verifies case/space-insensitively');

  // Stateless tickets (email-OTP proof)
  const el = v.emailLookup('proof@example.com');
  const ticket = v.signTicket(el);
  assert(v.verifyTicket(ticket, el) === true, 'valid ticket verifies for its data');
  assert(v.verifyTicket(ticket, v.emailLookup('other@example.com')) === false, 'ticket bound to its data');
  assert(v.verifyTicket(ticket + 'x', el) === false, 'tampered ticket rejected');
  assert(v.verifyTicket(v.signTicket(el, -1), el) === false, 'expired ticket rejected');

  console.log(`\n${passed} checks passed`);
})();
