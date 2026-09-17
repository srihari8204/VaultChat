// lib/backupSecretKeys.ts — which AsyncStorage keys must never enter a backup.
//
// Pure and dependency-free so the rule can be executed in a test; lib/cloudBackup.ts
// imports React Native and cannot be.
//
// lib/cloudBackup.ts already documents this threat and excluded the `e2eeKeys`
// FIELD because of it. That exclusion holds — the long-term identity lives in
// SecureStore, which a bundle never touches. What it missed is that the bundle
// also copies the WHOLE of AsyncStorage, where two kinds of key material live:
//
//   vc_mk_*       Per-file media keys. lib/mediaKeyStore.ts's own header says
//                 "The key never leaves the device". In the DEFAULT
//                 account-managed mode the server generates and stores the
//                 bundle key, so shipping these hands the server the keys to
//                 the attachment ciphertext it is already holding. They are not
//                 needed for the bundle's purpose either: readable history
//                 comes from the plaintext cache.
//
//   vc_peer_ik_*  The pinned peer identity keys behind the "safety number
//                 changed" warning. Exported, they leak who the user talks to.
//                 IMPORTED they are worse — a restore does a blanket multiSet,
//                 so a bundle carrying a pre-acknowledged key change silences
//                 that warning for a chosen peer, and a MITM lands with the
//                 user never told.
//
// Prefix-matched rather than listed: both are per-peer or per-attachment.

export const BACKUP_SECRET_PREFIXES = ['vc_mk_', 'vc_peer_ik_'] as const;

/** True when this key holds key material that must not travel in a bundle. */
export function isSecretBackupKey(k: string): boolean {
  return BACKUP_SECRET_PREFIXES.some((pre) => k.startsWith(pre));
}
