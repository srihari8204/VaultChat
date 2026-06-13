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

export default { E2EE_ENABLED };
