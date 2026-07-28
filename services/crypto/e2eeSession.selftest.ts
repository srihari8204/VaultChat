/**
 * Node self-test for services/crypto/e2eeSession.ts — full two-party flow
 * against an in-memory backend that mimics the real /user/keybundle routes
 * (atomic one-time-prekey claim on fetch). Run via esbuild bundle (see
 * README_E2EE.md) — dev-only, never imported by the app.
 */
import { createE2EESession } from './e2eeSession';
import type { KVStore, KeyBundleTransport, PublishBundle, FetchedBundle } from './e2eeSession';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
async function checkThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  check(name, threw);
}

function makeKV(): KVStore {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.has(k) ? (m.get(k) as string) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}

// In-memory stand-in for the backend keybundle store.
interface BackendEntry { identityKey: string; signedPreKey: any; otpks: { keyId: number; publicKey: string }[]; }
function makeBackend() {
  const store = new Map<string, BackendEntry>();
  return {
    store,
    transportFor(userId: string): KeyBundleTransport {
      return {
        async publish(b: PublishBundle) {
          const cur = store.get(userId) || { identityKey: '', signedPreKey: null, otpks: [] };
          // Mirror the backend: a changed identity purges the now-dead prekeys.
          if (cur.identityKey && cur.identityKey !== b.identityKey) cur.otpks = [];
          cur.identityKey = b.identityKey;
          cur.signedPreKey = b.signedPreKey;
          const have = new Set(cur.otpks.map((o) => o.keyId));
          for (const o of b.oneTimePreKeys) if (!have.has(o.keyId)) cur.otpks.push(o);
          store.set(userId, cur);
        },
        async fetch(peerId: string): Promise<FetchedBundle | null> {
          const e = store.get(peerId);
          if (!e || !e.identityKey || !e.signedPreKey) return null;
          const otpk = e.otpks.shift() || null; // atomic single-use claim
          return { identityKey: e.identityKey, signedPreKey: e.signedPreKey, oneTimePreKey: otpk };
        },
      };
    },
  };
}

(async () => {
  console.log('\nVaultChat E2EE session-layer self-test\n──────────────────────────────────────');

  const backend = makeBackend();
  const aliceKV = makeKV();
  const bobKV = makeKV();
  const alice = createE2EESession({ store: aliceKV, transport: backend.transportFor('alice') });
  const bob = createE2EESession({ store: bobKV, transport: backend.transportFor('bob') });

  // Provisioning
  console.log('Provisioning:');
  await alice.ensurePublished();
  await bob.ensurePublished();
  check('both identities published to backend', backend.store.has('alice') && backend.store.has('bob'));
  check('bob published a one-time-prekey pool', (backend.store.get('bob') as BackendEntry).otpks.length > 0);
  const bobOtpksBefore = (backend.store.get('bob') as BackendEntry).otpks.length;

  // First message: Alice → Bob (X3DH bootstrap)
  console.log('X3DH bootstrap + first message:');
  const wire1 = await alice.encryptForPeer('bob', 'hi bob');
  check('first wire carries the X3DH header', JSON.parse(wire1).x3dh !== undefined);
  check('one OTPK was claimed from the backend', (backend.store.get('bob') as BackendEntry).otpks.length === bobOtpksBefore - 1);
  const dec1 = await bob.decryptFromPeer('alice', wire1);
  check('Bob decrypts Alice’s first message', dec1 === 'hi bob');
  check('Bob now has a session', await bob.hasSession('alice'));

  // Reply path (DH ratchet)
  console.log('Bidirectional:');
  const wire2 = await bob.encryptForPeer('alice', 'hey alice');
  check('Bob’s reply does NOT carry an X3DH header', JSON.parse(wire2).x3dh === undefined);
  const dec2 = await alice.decryptFromPeer('bob', wire2);
  check('Alice decrypts Bob’s reply', dec2 === 'hey alice');

  // After hearing back, Alice stops attaching the X3DH header
  const wire3 = await alice.encryptForPeer('bob', 'third');
  check('Alice drops the X3DH header after first reply', JSON.parse(wire3).x3dh === undefined);
  check('Bob decrypts subsequent message', (await bob.decryptFromPeer('alice', wire3)) === 'third');

  // Out-of-order delivery within a chain
  console.log('Out-of-order delivery:');
  const oa = createE2EESession({ store: aliceKV, transport: backend.transportFor('alice') }); // simulate app restart
  const mA = await oa.encryptForPeer('bob', 'A');
  const mB = await oa.encryptForPeer('bob', 'B');
  const mC = await oa.encryptForPeer('bob', 'C');
  const gC = await bob.decryptFromPeer('alice', mC);
  const gA = await bob.decryptFromPeer('alice', mA);
  const gB = await bob.decryptFromPeer('alice', mB);
  check('restarted Alice continues the same session', gA === 'A' && gB === 'B' && gC === 'C');

  // Identity is stable across "restart"
  console.log('Identity persistence:');
  const idBefore = await aliceKV.get('vc_e2ee_identity');
  await oa.ensurePublished();
  const idAfter = await aliceKV.get('vc_e2ee_identity');
  check('ensurePublished() does not regenerate identity', idBefore === idAfter);

  // Re-key recovery: a peer reinstalls (fresh identity) and re-initiates. The
  // other side has a now-DEAD session and must adopt the fresh one instead of
  // being stuck on "unable to decrypt".
  console.log('Re-key recovery (reinstall self-heal):');
  const bobKV2 = makeKV();
  const bob2 = createE2EESession({ store: bobKV2, transport: backend.transportFor('bob') });
  await bob2.ensurePublished();                               // fresh identity replaces bob's bundle
  const rk1 = await bob2.encryptForPeer('alice', 'new bob here');
  check('reinstalled Bob re-initiates with an X3DH header', JSON.parse(rk1).x3dh !== undefined);
  const adopted = await alice.decryptFromPeer('bob', rk1);    // alice still holds the STALE session
  check('Alice adopts the new session over the dead one', adopted === 'new bob here');
  const rk2 = await alice.encryptForPeer('bob', 'welcome back');
  check('Alice replies on the adopted session', (await bob2.decryptFromPeer('alice', rk2)) === 'welcome back');

  // Manual "reset secure session": drop the local session → next message re-keys.
  console.log('Reset secure session:');
  await alice.resetSession('bob');
  const rs1 = await alice.encryptForPeer('bob', 'after reset');
  check('after reset Alice re-attaches an X3DH header', JSON.parse(rs1).x3dh !== undefined);
  check('peer adopts the reset session', (await bob2.decryptFromPeer('alice', rs1)) === 'after reset');

  // Helpers + error paths
  console.log('Helpers & guards:');
  check('isEnvelope() true for dr1 wire', alice.isEnvelope(wire1));
  check('isEnvelope() false for legacy plaintext', !alice.isEnvelope('just text'));
  await checkThrows('decrypt without session and without X3DH header throws', async () => {
    const stranger = createE2EESession({ store: makeKV(), transport: backend.transportFor('carol') });
    await stranger.ensurePublished();
    await stranger.decryptFromPeer('alice', JSON.stringify({ v: 'dr1', env: 'AAAA' }));
  });

  console.log('──────────────────────────────────────');
  if (failures === 0) { console.log('ALL SESSION TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} SESSION TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
