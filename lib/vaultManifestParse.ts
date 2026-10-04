// lib/vaultManifestParse.ts
// Reads the vault file manifest (app/vault.tsx). No stored manifest means an
// empty vault; anything unreadable throws, so the screen can block writes
// instead of saving a fresh list over the real one and orphaning .enc files.

export function parseVaultManifest<T>(raw: string | null): T[] {
  if (raw == null || raw === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Vault file list is damaged');
  return parsed as T[];
}
