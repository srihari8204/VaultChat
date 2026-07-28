// Runtime feature flags.
//
// E2EE_ENABLED gates the real end-to-end encryption seam in lib/chatService.ts
// (X3DH + Double Ratchet, services/crypto — 47/47 self-tests pass).
//
// ON: direct-chat messages are end-to-end encrypted. The rollout is GRACEFUL —
// if a peer hasn't published a key bundle yet (older app), encryptForChat falls
// back to plaintext for that message, and pre-E2EE history stays readable. So
// turning this on never blocks or breaks messaging.
//
// NOT YET encrypted: group chats (need sender-key/MLS group E2EE — separate
// work) and media payloads. Verify with a two-device round-trip after deploy.
export const E2EE_ENABLED = true;

// E2EE_STRICT hardens the 1:1 seam so it NEVER silently sends plaintext. When a
// direct-chat message can't be encrypted (peer key bundle missing / transient
// session error), the send THROWS instead of falling back to plaintext — so the
// message shows as failed + retries (the retry re-fetches the bundle and almost
// always succeeds), rather than leaking a plaintext body to the server. This is
// the WhatsApp guarantee. Groups stay graceful during the E2EE rollout.
export const E2EE_STRICT = true;

// VAULT_SESSION_SEALED gates #32 Phase A: the real account's session tokens are
// sealed under the unlock PIN (services/security/sessionSeal) instead of sitting
// in plaintext SecureStore, so a duress/decoy PIN cannot reach the real session.
//
// DEFAULT OFF — when off, token storage behaves exactly as before (zero change).
// When ON, unlock is PIN-only (a PIN-sealed session can't be unsealed by
// biometrics, which is also a coercion weakness), and the seam falls back to
// re-login if anything can't be unsealed — it can never brick. Verify with a
// two-device set-PIN → reload → unlock round-trip before enabling in prod.
export const VAULT_SESSION_SEALED = false;

// VAULT_CACHE_ENCRYPTED gates #32 Phase B: the local SQLite message cache
// (lib/localDb) holds message bodies in plaintext today. With this ON, the
// sensitive columns (messages.content, messages.meta, chats.data) are sealed at
// rest with AES-256-GCM under a random Data Encryption Key (DEK) that is itself
// envelope-sealed under the unlock PIN (lib/cacheCrypto). The DEK is loaded into
// memory only after a successful unlock, so a duress/decoy PIN or a seized device
// cannot read cached message bodies.
//
// DEFAULT OFF — when off (or before unlock), the field codecs are pass-through, so
// localDb behaves byte-identically to before. Rows carry an `enc:v1:` prefix when
// sealed, so old plaintext rows and new encrypted rows coexist (lazy migration);
// nothing is bulk-rewritten and the cache can never brick. Indexed/queried columns
// (ids, chat_id, timestamps, deleted_at) stay cleartext — only message bodies are
// sealed. Best paired with VAULT_SESSION_SEALED. Verify with a two-device
// set-PIN → send → reload → unlock round-trip before enabling in prod.
export const VAULT_CACHE_ENCRYPTED = false;

// MEDIA_E2EE gates W6 media-at-rest: in DIRECT chats, attachment bytes (photo,
// video, voice, file) are encrypted with a fresh per-file AES-256-GCM key before
// upload — the server stores opaque ciphertext only. The key rides to the
// recipient inside the E2E message envelope (lib/mediaAttachments), never in
// plaintext meta, so it requires E2EE_ENABLED and a direct (1:1) chat.
//
// DEFAULT OFF — when off, media uploads behave exactly as before (plaintext bytes
// on the server). The receive/render path is always tolerant: an attachment with
// no local key falls back to the direct URL, so legacy/plaintext and group media
// keep rendering. Group chats stay plaintext until group E2EE (W5) lands. Verify
// with a two-device direct-chat photo/voice/file round-trip before enabling.
export const MEDIA_E2EE = true;   // enabled 2026-06-28 — VERIFY two-device direct-chat photo/voice/file round-trip after deploy

// STORY_E2EE gates W7 per-viewer story encryption: a story's media is uploaded as
// opaque AES-256-GCM ciphertext and its single content key is wrapped SEPARATELY
// for each authorized viewer via the author↔viewer E2EE session (reuses the proven
// per-peer Double Ratchet). The server stores only opaque ciphertext + opaque
// per-viewer wrapped keys — it can never read a story. Requires E2EE_ENABLED.
//
// DEFAULT OFF — when off, stories post/render exactly as before (plaintext media).
// The viewer is tolerant: `story.encrypted` decides the path, so plaintext and
// encrypted stories coexist. Viewers who weren't in the audience at post time have
// no wrapped key and cannot decrypt (correct for an ephemeral, audience-scoped
// post). Verify with a two-device round-trip before enabling.
export const STORY_E2EE = true;   // enabled 2026-06-28 — VERIFY two-device story round-trip after deploy

// GROUP_E2EE gates W5 group chat encryption via Sender Keys (Signal-style). Each
// member encrypts with their own hash-ratchet sender key (services/crypto/senderKey,
// 9/9 self-tests) and distributes it to other members over the pairwise Double
// Ratchet (services/crypto/groupSession). The server stores only ciphertext +
// opaque distribution blobs. Sender keys rotate automatically on membership change.
//
// DEFAULT OFF — when off, group messages are plaintext exactly as before. The
// rollout is GRACEFUL: decrypt detects a group envelope (GSK1: prefix), and
// pre-E2EE / plaintext history stays readable; a member without a sender key yet
// falls back so messaging never breaks. Requires E2EE_ENABLED. Verify with a
// 3-device group round-trip (incl. add/remove member) before enabling.
export const GROUP_E2EE = true;   // enabled 2026-06-28 — needs migration 040; VERIFY 3-device group round-trip (incl add/remove) after deploy

// Scheduled messages (#73): local encrypted on-device queue (send at time) vs
// the legacy server-side queue (scheduled_messages table + 30s sweep). Local is
// the differentiator — nothing waits on a server; encrypted at send time.
// FALSE = reliable server-side delivery (E2E-encrypted on-device before upload;
// the server forwards ciphertext at send time — fires even if the app is killed).
// TRUE = on-device queue, but best-effort timing on Android (Doze/OEM kills).
export const SCHEDULED_LOCAL = false;

export default { E2EE_ENABLED, VAULT_SESSION_SEALED, VAULT_CACHE_ENCRYPTED, MEDIA_E2EE, STORY_E2EE, GROUP_E2EE, SCHEDULED_LOCAL };
