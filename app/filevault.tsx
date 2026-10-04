// app/filevault.tsx — redirects to the real encrypted Vault (/vault).
//
// This screen used to be a second "file vault" that stored only file
// *references* (uri:'') with plaintext folder passwords — it showed lock icons
// and "PRIVATE ON-DEVICE STORAGE" but encrypted nothing and kept no file bytes.
// The real vault (app/vault.tsx) encrypts the actual file bytes on-device with
// AES-256-GCM (a random file key wrapped under the Device PIN, lib/vaultCrypto)
// and stores them as .enc files with a SecureStore manifest. Rather than ship
// two vaults — one real, one fake — every "Vault" entry point now lands on the
// real one. Kept only as an alias for old links; nothing in the app links here
// any more (SafetyNavBar points at /vault directly).

import { Redirect } from 'expo-router';

export default function FileVaultScreen() {
  return <Redirect href="/vault" />;
}
