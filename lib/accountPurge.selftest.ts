/**
 * Node self-test for the account purge. 2026-09-17.  `npx tsx lib/accountPurge.selftest.ts`
 *
 * Guards fixes that all share one failure mode: a security routine that looks
 * present, runs without error, and does nothing.
 *
 *   1. lib/api endSessionAndBounce() purges, instead of dropping tokens and
 *      handing the next account the previous user's data.
 *   2. The E2EE identity + ratchets are destroyed on purge.
 *   3. Failed-PIN tracking and its backoff are wired into pinStore.verifyPin,
 *      the one function every local PIN check routes through.
 *   4. wipeAllKeys() wipes the real keys, not a list of names nothing writes.
 *
 * Section 2b adds the 2026-09-17 adversarial-review round, where the purge was
 * present and still lost the race:
 *   • a publish in flight when the purge lands wrote the identity BACK to disk
 *   • backup-restored sessions were never indexed, so nothing could delete them
 *   • pre-index sessions are live symmetric ratchets, not inert orphans
 *   • a failed index write marked the peer indexed anyway, forever
 *   • the purge blocked the redirect (and the guard promise it runs under)
 *   • a stale 401 could purge whichever account happened to be signed in
 *
 * Only (2) can be EXECUTED here: authService, lib/api, securityService and
 * pinStore all import react-native / expo-*, which cannot load in Node. Those
 * are source-scanned — weaker than running them, but it is the difference
 * between a check and no check, and each scan is anchored on the exact call
 * that was missing.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createE2EESession } from '../services/crypto/e2eeSession';
import type { KVStore, KeyBundleTransport, PublishBundle, FetchedBundle } from '../services/crypto/e2eeSession';

const root = join(__dirname, '..');
const src = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
/** Source with // and /* *\/ comments stripped — a claim in a comment is not code. */
const code = (...p: string[]) =>
  src(...p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  assert.ok(cond, `FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  console.log('  ✓ ' + name);
  passed++;
}

// ── 1. forced sign-out purges ────────────────────────────────────────────────
{
  const api = code('lib', 'api.ts');
  const bounce = api.slice(api.indexOf('async function endSessionAndBounce'));
  const body = bounce.slice(0, bounce.indexOf('\n}\n'));
  ok('endSessionAndBounce calls purgeAccountData', /purgeAccountData/.test(body));
  ok('endSessionAndBounce still guards on sessionEndingPromise', /sessionEndingPromise/.test(body));

  const auth = code('app', '(constants)', 'authService.ts');
  ok('authService exports purgeAccountData', /export async function purgeAccountData/.test(auth));
  ok('logoutUser routes through it too', /logoutUser[\s\S]{0,800}?purgeAccountData\(\)/.test(auth));
  const purge = auth.slice(auth.indexOf('export async function purgeAccountData'));
  for (const step of ['clearTokens', 'clearLocalDb', 'purgeUserContent', 'purgeDocumentCache', 'clearPin'])
    ok(`purgeAccountData still does ${step}()`, purge.includes(step));
  // The onboarding store is RAM, not storage, so nothing above reaches it: it
  // outlives a sign-out because the process does not restart. Left behind, the
  // PREVIOUS signup's userId and setupTicket are still there when someone signs
  // up on a different number, and /auth/mpin/set writes the new number's PIN
  // onto the old account — while the new one stays MPIN-less, i.e. unusable.
  ok('purgeAccountData resets the in-RAM onboarding store', /onboarding\.reset\(\)/.test(purge));
}

// ── 2. E2EE identity does not survive a purge ────────────────────────────────
{
  const auth = code('app', '(constants)', 'authService.ts');
  ok('purgeAccountData clears the E2EE identity', /clearE2EEIdentity/.test(auth));
  const rn = code('services', 'crypto', 'e2eeSession.rn.ts');
  ok('clearE2EEIdentity resets the provisioned flag', /_provisioned = false/.test(rn.slice(rn.indexOf('export async function clearE2EEIdentity'))));
}

function makeKV(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(k) { return map.has(k) ? (map.get(k) as string) : null; },
    async set(k, v) { map.set(k, v); },
    async del(k) { map.delete(k); },
  };
}

(async () => {
  const backend = new Map<string, any>();
  const transport = (uid: string): KeyBundleTransport => ({
    async publish(b: PublishBundle) { backend.set(uid, b); },
    async fetch(peerId: string): Promise<FetchedBundle | null> {
      const e = backend.get(peerId);
      if (!e) return null;
      return { identityKey: e.identityKey, signedPreKey: e.signedPreKey, oneTimePreKey: e.oneTimePreKeys[0] ?? null };
    },
  });

  const bobKV = makeKV();
  const bob = createE2EESession({ store: bobKV, transport: transport('bob') });
  await bob.ensurePublished();

  const aliceKV = makeKV();
  const alice = createE2EESession({ store: aliceKV, transport: transport('alice') });
  await alice.ensurePublished();
  await alice.encryptForPeer('bob', 'hi bob');

  const identityBefore = backend.get('alice').identityKey;
  ok('alice holds an identity + a session with bob',
    aliceKV.map.has('vc_e2ee_identity') && aliceKV.map.has('vc_e2ee_session_bob'));

  await alice.clearIdentity();
  ok('clearIdentity removed the identity keypair', !aliceKV.map.has('vc_e2ee_identity'));
  ok('clearIdentity removed the per-peer ratchet', !aliceKV.map.has('vc_e2ee_session_bob'));
  ok('clearIdentity removed the peer index', !aliceKV.map.has('vc_e2ee_peers'));
  ok('no vc_e2ee_* key survives', ![...aliceKV.map.keys()].some(k => k.startsWith('vc_e2ee_')),
    [...aliceKV.map.keys()].join(','));

  // The in-memory single-flight memo is the half a disk wipe cannot reach: the
  // next account must publish ITS key, not the one we just deleted.
  await alice.ensurePublished();
  ok('the next account publishes a fresh identity', backend.get('alice').identityKey !== identityBefore);
  ok('and has no session with bob', !(await alice.hasSession('bob')));

  // ── 2b. the purge vs. work already in flight (2026-09-17 review) ───────────
  //
  // Every check below is about a purge that RAN AND SUCCEEDED, and was then
  // undone — or never reached — by something the flag resets could not see.
  {
    // (1) A publish parked mid-write when the purge lands must not write the
    // identity back to disk. This is the startup path: app/_layout fires
    // provisionE2EEIdentity() and forgets it, so a forced sign-out lands inside
    // it routinely.
    const kv = makeKV();
    const warm = createE2EESession({ store: kv, transport: transport('carol') });
    await warm.ensurePublished();
    await warm.encryptForPeer('bob', 'hi bob');

    // Starve the OTPK pool so the next ensurePublished() tops it up — which is
    // the identity write that used to resurrect the account.
    const stored = JSON.parse(kv.map.get('vc_e2ee_identity') as string);
    stored.opks = stored.opks.slice(0, 3);
    kv.map.set('vc_e2ee_identity', JSON.stringify(stored));

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let parked!: () => void;
    const reached = new Promise<void>((r) => { parked = r; });
    let stall = true;
    const stalling: KVStore = {
      get: kv.get,
      async set(k, v) {
        if (stall && k === 'vc_e2ee_identity') { stall = false; parked(); await gate; }
        return kv.set(k, v);
      },
      del: kv.del,
    };
    const fresh = createE2EESession({ store: stalling, transport: transport('carol') });
    const publishing = fresh.ensurePublished();
    await reached;                       // the top-up write is now mid-flight
    const genBefore = fresh.identityGeneration();
    await fresh.clearIdentity();         // …and the purge lands on top of it
    ok('clearIdentity bumps the identity generation', fresh.identityGeneration() !== genBefore);
    open();
    await publishing;
    ok('a publish in flight during the purge does not rewrite the identity',
      !kv.map.has('vc_e2ee_identity'), [...kv.map.keys()].join(','));
    ok('and does not leave the ratchet behind either', !kv.map.has('vc_e2ee_session_bob'));
  }

  {
    // (2) + (3). Two ways a session key exists that saveSession() never wrote:
    // restored from an encrypted backup (importE2EEKeys writes the blob
    // directly), and written by a build older than the peer index. Neither is
    // in the index, and SecureStore cannot be enumerated — so unless they are
    // NAMED they survive the purge, and a StoredSession is a symmetric ratchet
    // that the next account would simply carry on using.
    const kv = makeKV();
    const s = createE2EESession({ store: kv, transport: transport('dan') });
    await s.ensurePublished();

    kv.map.set('vc_e2ee_session_restored', '{"state":"from-a-backup"}');
    await s.rememberPeers(['restored']);
    kv.map.set('vc_e2ee_session_preindex', '{"state":"from-an-old-build"}');

    await s.clearIdentity(['preindex']);
    ok('a backup-restored session is indexed and purged', !kv.map.has('vc_e2ee_session_restored'));
    ok('a pre-index session named by the caller is purged', !kv.map.has('vc_e2ee_session_preindex'));
  }

  {
    // (4) A throwing index write must be RETRIED, not remembered as done. The
    // write is best-effort by design (indexing a peer may never fail a
    // message), so marking the memo first meant one failed write hid that peer
    // from the purge for the rest of the process lifetime.
    const kv = makeKV();
    let breakIndex = true;
    const flaky: KVStore = {
      get: kv.get,
      async set(k, v) {
        if (breakIndex && k === 'vc_e2ee_peers') throw new Error('secure store unavailable');
        return kv.set(k, v);
      },
      del: kv.del,
    };
    const s = createE2EESession({ store: flaky, transport: transport('erin') });
    await s.ensurePublished();
    await s.encryptForPeer('bob', 'first');    // index write throws, swallowed
    breakIndex = false;
    await s.encryptForPeer('bob', 'second');   // must try again, not short-circuit
    ok('a failed index write is retried rather than assumed done', kv.map.has('vc_e2ee_peers'));
    await s.clearIdentity();
    ok('so the session it names does not survive the purge', !kv.map.has('vc_e2ee_session_bob'));
  }

  // Source-scanned halves (RN/expo — not loadable in Node).
  {
    const rn = code('services', 'crypto', 'e2eeSession.rn.ts');
    ok('provisioned is only set for the generation that actually published',
      /gen === e2ee\.identityGeneration\(\)[\s\S]{0,120}_provisioned = true/.test(rn));
    const imp = rn.slice(rn.indexOf('export async function importE2EEKeys'));
    ok('importE2EEKeys indexes the sessions it restores',
      /rememberPeers/.test(imp.slice(0, imp.indexOf('\n}\n'))));

    // The comment, not just the code: it told a reader the residual risk was
    // harmless when it was an impersonation.
    const sess = src('services', 'crypto', 'e2eeSession.ts');
    ok('the pre-index limitation no longer claims those sessions are unreadable',
      !/unreadable without the identity and get overwritten/.test(sess));

    const auth = code('app', '(constants)', 'authService.ts');
    const purge = auth.slice(auth.indexOf('export async function purgeAccountData'));
    ok('purgeAccountData names the peers the index cannot', /clearE2EEIdentity\(knownPeers\)/.test(purge));
    ok('and reads them BEFORE clearTokens drops the cache DEK',
      purge.indexOf('getCachedChats') >= 0 && purge.indexOf('getCachedChats') < purge.indexOf('clearTokens'));
    ok('purgeAccountData deletes the secret unlock code', /vc_secret_code_hash/.test(purge));

    const api = code('lib', 'api.ts');
    const bounce = api.slice(api.indexOf('async function endSessionAndBounce'));
    const body = bounce.slice(0, bounce.indexOf('\n}\n'));
    ok('the redirect happens BEFORE the purge',
      body.indexOf("resetTo('/onboard')") < body.indexOf('purgeAccountData'));
    ok('the purge does not hold the session-ending guard promise',
      !/await\s+require\([^\n]*authService[^\n]*purgeAccountData/.test(body));
    ok('rawFetch records which session a request was sent under',
      /sentAs\.sub = tokenSubject\(token\)/.test(api));
    ok("a superseded session's 401 cannot purge the live account",
      /tokenSubject\(await getAccessToken\(\)\) !== sentAs\.sub/.test(api));
  }

  // ── 3. brute-force detection is reachable ──────────────────────────────────
  const pin = code('services', 'security', 'pinStore.ts');
  const verify = pin.slice(pin.indexOf('export async function verifyPin'));
  const verifyBody = verify.slice(0, verify.indexOf('\n}\n'));
  ok('verifyPin records failures', /recordFailure/.test(verifyBody));
  ok('verifyPin records successes', /recordSuccess/.test(verifyBody));
  ok('verifyPin consults the backoff', /getBackoffMs/.test(verifyBody));
  ok('the backoff is checked BEFORE the PIN is',
    verifyBody.indexOf('getBackoffMs') < verifyBody.indexOf('check(pin)'));
  // Refusing an attempt must not count as a failure — that is what would turn a
  // 60-second backoff into a permanent lockout.
  const refusal = verifyBody.slice(verifyBody.indexOf('getBackoffMs'), verifyBody.indexOf('check(pin)'));
  ok('a refused attempt is not recorded as a failure', !/record/.test(refusal));

  // The tracker itself is pure — check the ceiling it promises.
  const { backoffFor } = await import('../services/security/pinAttempts');
  ok('backoff grows with the streak', backoffFor(2) > 0 && backoffFor(4) > backoffFor(2));
  ok('backoff is bounded (no permanent lockout)', backoffFor(9999) <= 60_000);

  // ── 4. wipeAllKeys wipes something ─────────────────────────────────────────
  const sec = code('services', 'securityService.ts');
  const wipe = sec.slice(sec.indexOf('export async function wipeAllKeys'));
  const wipeBody = wipe.slice(0, wipe.indexOf('\n}\n'));
  ok('wipeAllKeys purges the account', /purgeAccountData/.test(wipeBody));
  ok('wipeAllKeys no longer deletes keys nothing writes',
    !/vault_pin|d2de_key_|active_sessions/.test(wipeBody));

  // ── 5. Group sender keys die with the account ──────────────────────────────
  //
  // clearIdentity(alsoPeerIds) reaches vc_e2ee_session_ blobs only. Group chats
  // use sender keys (vc_gsk_*), and purgeAccountData's own comment used to say
  // group members would be "wasted deletes" — true for the pairwise purge, and
  // the reason the group keys survived every sign-out. An own sender key is the
  // key this device signs group messages with; a peer sender key decrypts that
  // member's group traffic. Both inherited by the next account (2026-09-18).
  const auth = code('app', '(constants)', 'authService.ts');
  const purge = auth.slice(auth.indexOf('export async function purgeAccountData'));
  const purgeBody = purge.slice(0, purge.indexOf('\n}\n'));
  ok('the purge clears group sender keys', /clearGroupSessions/.test(purgeBody));
  ok('the purge enumerates group chats to name them',
    /type === 'group'/.test(purgeBody) && /knownGroups/.test(purgeBody));
  ok('group ids are read BEFORE the local cache is cleared',
    purgeBody.indexOf('knownGroups.push') < purgeBody.indexOf('clearLocalDb'));

  const gs = code('services', 'crypto', 'groupSession.rn.ts');
  const clearFn = gs.slice(gs.indexOf('export async function clearGroupSessions'));
  const clearBody = clearFn.slice(0, clearFn.indexOf('\n}\n'));
  ok('clearGroupSessions deletes own, peer and member records',
    /OWN\(/.test(clearBody) && /PEER\(/.test(clearBody) && /MEMBERS\(/.test(clearBody));
  // These values are chunked. A bare SecureStore delete removes the head and
  // strands the parts, which reads as success and leaves key material on disk.
  ok('clearGroupSessions deletes through the chunk-aware store',
    /kv\.del\(/.test(clearBody) && !/SecureStore\.deleteItemAsync/.test(clearBody));

  console.log(`\naccountPurge self-test: ${passed} checks passed\n`);
})().catch((e) => { console.error('\n' + (e?.message || e) + '\n'); process.exit(1); });
