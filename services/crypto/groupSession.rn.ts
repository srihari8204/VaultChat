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
import { e2eeEncrypt, e2eeDecrypt, e2eeCachePlaintext, e2eeGetCached } from './e2eeSession.rn';
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
  await kv.set(MEMBERS(chatId), JSON.stringify([...others].sort()));
}

/** Ensure my sender key is distributed to the current membership, rotating on removal. */
async function ensureDistributed(chatId: string, me: string): Promise<void> {
  const others = await fetchOtherMembers(chatId, me);
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

/** Pull SKDMs addressed to me and install/refresh peer records (skips stale ones). */
async function ingest(chatId: string): Promise<void> {
  const list = await api<{ senderId: string; skdm: string }[]>(`/chats/${encodeURIComponent(chatId)}/sender-keys`);
  for (const { senderId, skdm } of (list ?? [])) {
    try {
      const dist = JSON.parse(await e2eeDecrypt('', senderId, 0, skdm)) as SenderKeyDistribution;
      const existing = await loadPeer(chatId, senderId);
      // Don't reset a chain we've already advanced past (same signer, >= iteration).
      if (existing && existing.signPubHex === dist.signPubHex && existing.iteration >= dist.iteration) continue;
      await savePeer(chatId, senderId, processDistribution(dist));
    } catch { /* can't decrypt this SKDM (no session yet) → skip */ }
  }
}

// ── Public API used by the chatService seam ────────────────────────────────────

const PREFIX = 'GSK1:'; // distinguishes a group cipher on the wire

export function isGroupEnvelope(wire: string | null | undefined): boolean {
  return typeof wire === 'string' && wire.startsWith(PREFIX);
}

/** Encrypt a message for a group; ensures my sender key is distributed first. */
export async function groupEncryptMessage(chatId: string, plaintext: string): Promise<string> {
  const me = await myId();
  if (!me) return plaintext; // unknown identity → don't block sending
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
): Promise<string> {
  const cached = await e2eeGetCached(chatId, messageId);
  if (cached !== null) return cached;
  const cipher = JSON.parse(wire.slice(PREFIX.length));
  let rec = await loadPeer(chatId, senderId);
  if (!rec) { await ingest(chatId); rec = await loadPeer(chatId, senderId); }
  if (!rec) throw new Error('group: no sender key for ' + senderId);
  const { plaintext, next } = groupDecrypt(rec, cipher);
  await savePeer(chatId, senderId, next);
  if (messageId > 0) await e2eeCachePlaintext(chatId, messageId, plaintext);
  return plaintext;
}

export default {};
