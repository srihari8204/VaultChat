/**
 * Group E2EE session layer (W5) — RN bindings for the sender-key core.
 *
 * Persists each member's own sender key + received peers' sender keys per group
 * in SecureStore (chunked, since the skipped-key cache can grow), distributes
 * Sender Key Distribution Messages (SKDMs) to each member over the proven
 * pairwise Double Ratchet, and exposes group encrypt/decrypt for the chatService
 * seam. Membership change is handled automatically: on a member removal we ROTATE
 * our sender key (so the leaver's stale copy can't read new messages) and
 * redistribute; on an addition we just redistribute the current key.
 *
 * RN-only (SecureStore + lib/api + pairwise session) → not Node-testable; the
 * crypto it composes is proven in senderKey.selftest.ts.
 */
import * as SecureStore from 'expo-secure-store';
import { api, getCachedUser } from '../../lib/api';
import { chunkedKV } from './e2eeStorage';
import { e2eeEncrypt, e2eeDecrypt, e2eeCachePlaintext, e2eeGetCached, E2EE_UNDECRYPTABLE } from './e2eeSession.rn';
import { createKeyedLock } from './messageStore';
import { redactIds, shortId, warnOnce } from '../../lib/diagLog';
import {
  createSenderKey, distributionMessage, processDistribution, groupEncrypt, groupDecrypt,
  type OwnSenderKey, type PeerSenderKey, type SenderKeyDistribution,
} from './index'; // the facade — picks TS or Rust per EXPO_PUBLIC_CRYPTO_BACKEND

const kv = chunkedKV({
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k).then(() => undefined),
});

const OWN     = (chatId: string) => `vc_gsk_own_${chatId}`;
const PEER    = (chatId: string, senderId: string) => `vc_gsk_peer_${chatId}_${senderId}`;
const MEMBERS = (chatId: string) => `vc_gsk_members_${chatId}`; // last member set we distributed to

async function loadOwn(chatId: string): Promise<OwnSenderKey | null> {
  const raw = await kv.get(OWN(chatId)); return raw ? JSON.parse(raw) : null;
}
async function saveOwn(chatId: string, s: OwnSenderKey): Promise<void> { await kv.set(OWN(chatId), JSON.stringify(s)); }
async function ensureOwn(chatId: string): Promise<OwnSenderKey> {
  let own = await loadOwn(chatId);
  if (!own) { own = createSenderKey(); await saveOwn(chatId, own); }
  return own;
}
async function loadPeer(chatId: string, senderId: string): Promise<PeerSenderKey | null> {
  const raw = await kv.get(PEER(chatId, senderId)); return raw ? JSON.parse(raw) : null;
}
async function savePeer(chatId: string, senderId: string, r: PeerSenderKey): Promise<void> {
  await kv.set(PEER(chatId, senderId), JSON.stringify(r));
}

async function myId(): Promise<string | null> {
  const u = await getCachedUser();
  return u?.id ?? null;
}
async function fetchOtherMembers(chatId: string, me: string): Promise<string[]> {
  const c = await api<{ members?: { userId: string }[] }>(`/chats/${encodeURIComponent(chatId)}`);
  return (c?.members ?? []).map(m => m.userId).filter(id => id && id !== me);
}

/** Publish my current sender key to every other member (encrypted pairwise). */
async function distribute(chatId: string, me: string, others: string[]): Promise<void> {
  const own = await ensureOwn(chatId);
  const skdm = JSON.stringify(distributionMessage(own));
  const distributions: { recipientId: string; skdm: string }[] = [];
  for (const r of others) {
    try { distributions.push({ recipientId: r, skdm: await e2eeEncrypt('', r, skdm) }); }
    catch { /* recipient has no key bundle yet → skip; they can't E2E anyway */ }
  }
  if (distributions.length) {
    await api(`/chats/${encodeURIComponent(chatId)}/sender-keys`, { method: 'POST', json: { distributions } });
  }
  // RECORD WHO WE ACTUALLY REACHED, not who we meant to reach.
  //
  // The loop above skips any member whose pairwise session is not usable yet
  // (no key bundle published, ratchet mid-reset). Recording the full membership
  // anyway latched that failure PERMANENTLY: the next send sees no add and no
  // removal, skips distribution, and that member can never read this group
  // again even after their 1:1 session heals. Recording only the reached set
  // makes an unreached member look "added" next time, so the next send retries.
  //
  // ponytail: a member who is permanently unreachable costs one extra
  // sender-keys POST per send. ensureDistributed already does a GET /chats per
  // send, so this is not a new round trip — add a cooldown if that GET ever goes.
  await kv.set(MEMBERS(chatId), JSON.stringify(distributions.map(d => d.recipientId).sort()));
}

/** Ensure my sender key is distributed to the current membership, rotating on removal. */
async function ensureDistributed(chatId: string, me: string): Promise<void> {
  const others = await fetchOtherMembers(chatId, me);
  // A KEY WE HAD TO MINT HAS NEVER BEEN DISTRIBUTED — membership says nothing.
  //
  // ensureOwn() silently creates a fresh chain AND a fresh Ed25519 signing key
  // when the stored one is gone (SecureStore cleared, restore onto a new device,
  // a Keystore read error). The membership diff below cannot see that: with no
  // add and no removal it skips distribution entirely, so every later message
  // from this device is signed by a key nobody has — "signature verification
  // failed" for every recipient, forever, with no signal to the sender.
  //
  // Checking BEFORE ensureOwn is what makes this work: distribute() calls
  // ensureOwn itself, so the key minted below is the one that gets published.
  if (!(await loadOwn(chatId))) { await distribute(chatId, me, others); return; }
  const lastRaw = await kv.get(MEMBERS(chatId));
  const last: string[] | null = lastRaw ? JSON.parse(lastRaw) : null;
  if (!last) { await distribute(chatId, me, others); return; }
  const removed = last.filter(id => !others.includes(id));
  const added   = others.filter(id => !last.includes(id));
  if (removed.length) {
    // Forward secrecy across membership change: fresh chain, redistribute to all.
    await saveOwn(chatId, createSenderKey());
    await distribute(chatId, me, others);
  } else if (added.length) {
    await distribute(chatId, me, others);
  }
}

// Senders we have already fetched for and STILL have no key for, and how long
// before it is worth asking again. Bounded by group membership, so it does not
// grow with history.
const _noSenderKeyAt = new Map<string, number>();
const INGEST_RETRY_MS = 30_000;

// Concurrent misses share one fetch. Bulk replay decrypts many messages from the
// same chat back-to-back, and without this the first few race past the cooldown
// check together and each issue their own GET.
const _ingestInFlight = new Map<string, Promise<void>>();
function ingestOnce(chatId: string): Promise<void> {
  let p = _ingestInFlight.get(chatId);
  if (!p) {
    p = ingest(chatId).finally(() => _ingestInFlight.delete(chatId));
    _ingestInFlight.set(chatId, p);
  }
  return p;
}

/** Pull SKDMs addressed to me and install/refresh peer records (skips stale ones). */
async function ingest(chatId: string): Promise<void> {
  const list = await api<{ senderId: string; skdm: string }[]>(`/chats/${encodeURIComponent(chatId)}/sender-keys`);
  for (const { senderId, skdm } of (list ?? [])) {
    try {
      const dist = JSON.parse(await e2eeDecrypt('', senderId, 0, skdm)) as SenderKeyDistribution;
      const existing = await loadPeer(chatId, senderId);
      // NEVER REPLACE A RECORD FOR THE SAME SIGNER. Only a ROTATION (new signing
      // key) may install a new record.
      //
      // processDistribution() returns a virgin record: skipped = {} and the head
      // jumped to the SKDM's iteration. Applying that to a signer we already
      // track throws away the skipped message keys held for messages still in
      // flight below that iteration — they then fail permanently with
      // "message key unavailable (too old / already used)". The existing record
      // needs nothing from the re-ingest anyway: groupDecrypt ratchets it forward
      // on its own, over any gap up to MAX_SKIP.
      if (existing && existing.signPubHex === dist.signPubHex) continue;
      await savePeer(chatId, senderId, processDistribution(dist));
    } catch (err) {
      // A sender key arrives wrapped in the 1:1 session with its sender, so a
      // broken/desynced pairwise ratchet silently costs us the GROUP key too —
      // surfacing as "group: no sender key for <id>" with no clue why. Observed
      // on device for the same peer whose 1:1 session was mid auto-reset loop.
      // It heals once that session re-keys and this runs again; logging it makes
      // the dependency visible instead of guesswork.
      //
      // ONCE PER PEER, NOT ONCE PER ATTEMPT. Measured on a cold boot: 9 of these
      // in 3 seconds for a handful of peers, because ingest re-runs per chat and
      // re-reports the same broken pairwise session every time. The FIRST one
      // carries the whole diagnostic — the repeats only bury it. And console.warn
      // is deliberately NOT stripped from release builds, so every repeat was a
      // real line in production logcat carrying a full user id.
      warnOnce(chatId + '|' + senderId,
        '[e2ee] group: could not open sender key from ' + shortId(senderId)
        + ' — ' + redactIds(String((err as any)?.message ?? err)));
    }
  }
}

// ── Public API used by the chatService seam ────────────────────────────────────

const PREFIX = 'GSK1:'; // distinguishes a group cipher on the wire

/**
 * Delete this account's group sender keys. 2026-09-18.
 *
 * Group chats use sender keys (vc_gsk_*), never a vc_e2ee_session_, so
 * clearIdentity()'s peer list does not reach them — purgeAccountData said so
 * in its own comment and then skipped them. The consequence is the same class
 * of defect the pairwise purge fixed: an own sender key is the signing key
 * this device publishes as, and a peer sender key decrypts that member's group
 * traffic. Left behind, the next account on the device inherits both.
 *
 * Deletes only what the caller can NAME — SecureStore has no listing call, the
 * same limit documented in e2eeSession.ts. The caller passes the group ids and
 * members it read from the local chat cache before that cache was cleared.
 *
 * RESIDUAL RISK, stated rather than papered over: a group that is not in the
 * local chat cache at sign-out (left, or pruned) keeps its blobs, and a member
 * missing from the cached member list keeps their peer key. Both are
 * unreachable for the same reason, not for a new one.
 *
 * Best-effort and never throws: it runs on the forced sign-out path, where one
 * failed delete must not abandon the rest.
 */
export async function clearGroupSessions(
  groups: { chatId: string; memberIds?: string[] }[],
): Promise<void> {
  for (const g of groups ?? []) {
    if (!g?.chatId) continue;
    // kv.del, not SecureStore.deleteItemAsync: these values are chunked, and a
    // bare head delete would strand the parts.
    await kv.del(OWN(g.chatId)).catch(() => {});
    await kv.del(MEMBERS(g.chatId)).catch(() => {});
    for (const m of g.memberIds ?? []) {
      if (m) await kv.del(PEER(g.chatId, m)).catch(() => {});
    }
  }
}

export function isGroupEnvelope(wire: string | null | undefined): boolean {
  return typeof wire === 'string' && wire.startsWith(PREFIX);
}

// ONE SENDER AT A TIME, PER GROUP. This is a confidentiality control, not a
// tidiness one.
//
// groupEncryptMessage is a read-modify-write over the sending chain:
//   ensureOwn(chatId)  →  groupEncrypt(own, …)  →  saveOwn(chatId, next)
//
// and senderKey.ts's msgKeyMaterial derives BOTH the AES-256 key and the 12-byte
// nonce from the same message key:
//
//   const out = hkdf(sha256, mk, …, INFO_MSG, 44);
//   return { key: out.slice(0, 32), nonce: out.slice(32, 44) };
//
// So two sends that read the same chain state encrypt two different plaintexts
// under an IDENTICAL (key, nonce) pair. That is the one thing AES-GCM must never
// do: it hands an observer P1 XOR P2, and the GHASH subkey for that key. The
// server stores both ciphertexts, so it gets both.
//
// The window is wide, not theoretical: ensureDistributed awaits a network GET
// before the state is read, and saveOwn is several SecureStore round-trips. Any
// two overlapping sends hit it — a GIF and a text, a poll and a forward, an edit
// during a queue flush. Callers like chatService.sendMessage and
// scheduleEncryptedMessage do not go through the outbox's single-flight flag.
//
// The 1:1 path already does exactly this (e2eeSession.rn.ts: withLock(peerId, …));
// the group path was simply missed. Same helper, keyed on chatId.
//
// The visible symptom people reported — a group message that every recipient
// fails to open with "message key unavailable (too old / already used)" — is the
// same bug: both sends went out at the same iteration.
const withGroupSendLock = createKeyedLock();

// ONE DECRYPT AT A TIME, PER (GROUP, SENDER).
//
// groupDecryptMessage is the same read-modify-write shape as the send path:
//   loadPeer(chat, sender) → groupDecrypt(rec, cipher) → savePeer(chat, sender, next)
//
// and hydrateMessages runs from several call sites at once (chat open, cold
// sync, a live message landing). Two concurrent decrypts of the same sender each
// read the same record, and the later savePeer discards the other's advanced
// head AND its cached skipped keys — so the out-of-order messages those keys
// existed for fail permanently with "message key unavailable".
//
// Unlike the send path this is not a nonce-reuse risk (decrypt derives nothing
// new), so it is a durability fix, not a confidentiality one.
//
// KEYED PER (chat, sender), not per chat: different senders own independent
// chains, and serializing a whole group's history behind one lock would make a
// busy chat's hydrate crawl. A SEPARATE lock instance from the send lock, so a
// decrypt can never sit behind a send — the send path awaits a network GET, and
// nothing in either path calls the other (ingest goes through the 1:1 lock,
// which is a third instance), so no cycle exists in either direction.
const withGroupDecryptLock = createKeyedLock();

/** Encrypt a message for a group; ensures my sender key is distributed first. */
export async function groupEncryptMessage(chatId: string, plaintext: string): Promise<string> {
  return withGroupSendLock(chatId, () => groupEncryptMessageLocked(chatId, plaintext));
}

async function groupEncryptMessageLocked(chatId: string, plaintext: string): Promise<string> {
  const me = await myId();
  // Unknown identity → we cannot distribute a sender key, so we cannot encrypt.
  // This used to return the plaintext and let the caller ship it; the caller now
  // refuses anything that is not a GSK1 envelope, and this says why.
  if (!me) throw new Error('group: own identity unknown — encryption keys not ready');
  await ensureDistributed(chatId, me);
  const own = await ensureOwn(chatId);
  const { cipher, next } = groupEncrypt(own, plaintext);
  await saveOwn(chatId, next);
  return PREFIX + JSON.stringify(cipher);
}

/**
 * Decrypt a group message from `senderId`; ingests SKDMs on first contact.
 * Checks the own-plaintext cache first — a sender can't decrypt their OWN
 * sender-key message (there's no self record), so their own sends render from the
 * cache that sendMessage populated. Successful decrypts are cached too, so
 * re-renders are cheap and forward-secret (the chain has already advanced).
 */
export async function groupDecryptMessage(
  chatId: string, senderId: string, messageId: number, wire: string,
  edited = false,
  /** Separate plaintext-cache namespace (see chatService.decryptFromChat). */
  cacheScope?: string,
): Promise<string> {
  return withGroupDecryptLock(chatId + '|' + senderId,
    () => groupDecryptMessageLocked(chatId, senderId, messageId, wire, edited, cacheScope));
}

async function groupDecryptMessageLocked(
  chatId: string, senderId: string, messageId: number, wire: string,
  edited: boolean, cacheScope?: string,
): Promise<string> {
  // The sender-key session is the chat's; only the plaintext-cache slot is scoped.
  const cacheChat = cacheScope ? `${chatId}:${cacheScope}` : chatId;
  // An edit keeps its message id but replaces the ciphertext. Require the
  // matching body so an old plaintext cache cannot win over the edit.
  const cached = await e2eeGetCached(cacheChat, messageId, wire, edited);
  // Same store holds the "permanently undecryptable" tombstone. Returning it as
  // plaintext printed "__e2ee_undecryptable__" into group bubbles, exactly as it
  // did for 1:1 (seen on device). Fall through so the real state is reported.
  if (cached !== null && cached !== E2EE_UNDECRYPTABLE) return cached;
  if (cacheScope && messageId > 0) {
    // Written before the scope existed: the unscoped slot, accepted only when
    // tagged with THIS ciphertext. Re-decrypting is not an option — the
    // sender-key chain has already consumed that message key.
    const legacy = await e2eeGetCached(chatId, messageId, wire, true);
    if (legacy !== null && legacy !== E2EE_UNDECRYPTABLE) {
      await e2eeCachePlaintext(cacheChat, messageId, legacy, wire);
      return legacy;
    }
  }
  const cipher = JSON.parse(wire.slice(PREFIX.length));
  let rec = await loadPeer(chatId, senderId);
  if (!rec) {
    // Fetch, but not once per message. This line runs for EVERY undecryptable
    // group message, and ingest() is a network GET plus one pairwise decrypt per
    // sender key returned. On a device whose identity is newer than the group's
    // history no amount of fetching can help — the SKDMs were sealed to the old
    // identity — so replaying that history issued a round trip per message, per
    // launch, all of them doomed.
    //
    // The cooldown is keyed on senders ALREADY KNOWN to have no usable key, so a
    // sender seen for the first time is still fetched immediately: a new member's
    // first message decrypts as promptly as before.
    const k = chatId + '|' + senderId;
    if (Date.now() - (_noSenderKeyAt.get(k) ?? 0) >= INGEST_RETRY_MS) {
      await ingestOnce(chatId);
      rec = await loadPeer(chatId, senderId);
      if (rec) _noSenderKeyAt.delete(k);
      else _noSenderKeyAt.set(k, Date.now());
    }
  }
  if (!rec) throw new Error('group: no sender key for ' + senderId);
  const { plaintext, next } = groupDecrypt(rec, cipher);
  await savePeer(chatId, senderId, next);
  if (messageId > 0) await e2eeCachePlaintext(cacheChat, messageId, plaintext, wire);
  return plaintext;
}

export default {};
