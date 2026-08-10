// services/crypto/otpkConsume.selftest.ts
// run: npx tsx services/crypto/otpkConsume.selftest.ts
//
// WHEN a one-time prekey is spent, and what happens when the sender names one
// we no longer hold.
//
// This was the bug that made E2EE look permanently broken between two devices.
// bootstrapResponder consumed the OTPK BEFORE the caller decrypted, so a failed
// decrypt destroyed the key — and the sender's retry, carrying the SAME header,
// then found nothing:
//
//   1. offer arrives with opkId 7; 7 is consumed; a secret is derived
//   2. decrypt fails
//   3. the ring loop resends the same offer, still naming opkId 7
//   4. 7 is gone, so myOpk fell back to null
//   5. x3dhResponder derived a DIFFERENT secret than the sender used
//   6. "aes/gcm: invalid ghash tag" — forever, through any number of resets
//
// Measured on device as resets=4, decryptFails=29, concurrentRekeys=0, with 15
// of one account's 20 prekeys burned by failed bootstraps.
//
// Two properties are asserted here, and the second is what made the first so
// hard to diagnose: a missing OTPK must FAIL rather than silently produce a
// different key.

import { createE2EESession, type KVStore, type KeyBundleTransport, type PublishBundle, type FetchedBundle } from './e2eeSession';

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

function makeKV(): KVStore {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.has(k) ? (m.get(k) as string) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}

interface Entry { identityKey: string; signedPreKey: any; otpks: { keyId: number; publicKey: string }[] }
function makeBackend() {
  const store = new Map<string, Entry>();
  return {
    store,
    transportFor(userId: string): KeyBundleTransport {
      return {
        async publish(b: PublishBundle) {
          const cur = store.get(userId) || { identityKey: '', signedPreKey: null, otpks: [] };
          if (cur.identityKey && cur.identityKey !== b.identityKey) cur.otpks = [];
          cur.identityKey = b.identityKey;
          cur.signedPreKey = b.signedPreKey;
          const have = new Set(cur.otpks.map(o => o.keyId));
          for (const o of b.oneTimePreKeys) if (!have.has(o.keyId)) cur.otpks.push(o);
          store.set(userId, cur);
        },
        async fetch(peerId: string): Promise<FetchedBundle | null> {
          const e = store.get(peerId);
          if (!e || !e.identityKey || !e.signedPreKey) return null;
          const otpk = e.otpks.shift() || null;   // single-use claim, as the server does
          return { identityKey: e.identityKey, signedPreKey: e.signedPreKey, oneTimePreKey: otpk };
        },
      };
    },
  };
}

/** How many private OTPKs the device still holds. */
function opkCount(kvDump: Map<string, string>): number {
  const raw = kvDump.get('vc_e2ee_identity');
  return raw ? (JSON.parse(raw).opks?.length ?? 0) : 0;
}

(async () => {
  console.log('\nOne-time prekey consumption\n');

  const backend = makeBackend();

  // A KV we can inspect, to count the prekeys the device actually holds.
  const bobMap = new Map<string, string>();
  const bobKV: KVStore = {
    async get(k) { return bobMap.has(k) ? (bobMap.get(k) as string) : null; },
    async set(k, v) { bobMap.set(k, v); },
    async del(k) { bobMap.delete(k); },
  };

  const alice = createE2EESession({ store: makeKV(), transport: backend.transportFor('alice') });
  const bob = createE2EESession({ store: bobKV, transport: backend.transportFor('bob') });

  await alice.ensurePublished();
  await bob.ensurePublished();

  const before = opkCount(bobMap);
  check('bob published a pool of prekeys', before > 0);

  // ── a CORRUPT message must not cost a prekey ──────────────────────────
  //
  // The heart of it: an undecryptable message used to burn the OTPK, and the
  // sender's retry could then never derive the same secret.
  //
  // The envelope must stay STRUCTURALLY VALID — a mangled one throws in
  // decodeEnvelope before the bootstrap is ever reached, which is not the
  // failure we are testing. Flip the ciphertext bytes instead, so it decodes
  // cleanly and dies on the GCM tag, exactly as on device.
  const wire = await alice.encryptForPeer('bob', 'hello');
  const parsed = JSON.parse(wire);
  const env = JSON.parse(parsed.env);
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff;
  const corrupt = JSON.stringify({ ...parsed, env: JSON.stringify({ ...env, ct: ct.toString('base64') }) });

  let threw = false;
  try { await bob.decryptFromPeer('alice', corrupt); } catch { threw = true; }
  check('a corrupt message fails to decrypt', threw);
  check('...and the prekey is NOT consumed', opkCount(bobMap) === before);

  // ── the retry then succeeds with the SAME header ──────────────────────
  // Previously impossible: the key was gone and every retry derived a
  // different secret, forever.
  const plain = await bob.decryptFromPeer('alice', wire);
  check('the ORIGINAL message still decrypts after the failure', plain === 'hello');
  check('...and only now is the prekey spent', opkCount(bobMap) === before - 1);

  // ── a genuinely missing OTPK must fail LOUDLY ─────────────────────────
  //
  // Silently falling back to "no prekey" derived a different key and reported
  // it as a decrypt failure, which is what disguised this as a ratchet problem.
  const bob2Map = new Map<string, string>();
  const bob2KV: KVStore = {
    async get(k) { return bob2Map.has(k) ? (bob2Map.get(k) as string) : null; },
    async set(k, v) { bob2Map.set(k, v); },
    async del(k) { bob2Map.delete(k); },
  };
  const bob2 = createE2EESession({ store: bob2KV, transport: backend.transportFor('bob2') });
  await bob2.ensurePublished();

  const w2 = await (async () => {
    const a2 = createE2EESession({ store: makeKV(), transport: backend.transportFor('a2') });
    await a2.ensurePublished();
    return a2.encryptForPeer('bob2', 'second');
  })();

  // Spend every prekey bob2 holds, so the header names one that is gone.
  // The identity is memoized per session object, so this has to be re-opened
  // afterwards — the same thing an app restart does.
  const id2 = JSON.parse(bob2Map.get('vc_e2ee_identity') as string);
  id2.opks = [];
  bob2Map.set('vc_e2ee_identity', JSON.stringify(id2));
  const bob2Restarted = createE2EESession({ store: bob2KV, transport: backend.transportFor('bob2') });

  let msg = '';
  try { await bob2Restarted.decryptFromPeer('a2', w2); } catch (e: any) { msg = String(e?.message ?? e); }
  check('a missing prekey throws', msg !== '');
  check('...and says so explicitly, not "decrypt failed"',
    /missing requested one-time prekey/i.test(msg));

  // ── an ordinary conversation still works ──────────────────────────────
  const w3 = await alice.encryptForPeer('bob', 'still fine');
  check('normal messaging is unaffected', await bob.decryptFromPeer('alice', w3) === 'still fine');

  console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all prekey-consumption checks passed\n');
  process.exit(failures ? 1 : 0);
})();
