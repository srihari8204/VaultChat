// Runtime feature flags.
//
// E2EE_ENABLED gates the real end-to-end encryption seam in lib/chatService.ts.
// It stays FALSE until the wiring has been validated on real devices
// (two-device round-trip + history reload after the ratchet advances) — see
// services/crypto/README_E2EE.md. With it false, the message path is exactly
// the pre-E2EE pass-through and none of the crypto is loaded at runtime.
export const E2EE_ENABLED = false;

export default { E2EE_ENABLED };
