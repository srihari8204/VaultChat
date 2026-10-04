// lib/recoveryKeyCheck.ts — "type back a few groups" check for the show-once
// backup recovery key (app/backup-e2ee.tsx). Pure, so it is Node-tested.
//
// The key is shown exactly once and nobody keeps a copy, so leaving that
// screen without having really saved it loses the backup. Asking for two
// randomly chosen 4-character groups proves the user holds a copy, without
// making them retype all 64 characters.

// No import from ./backupCrypto: it pulls in React Native and this file must
// run under plain Node. Same rule as backupCrypto.normalizeRecoveryKey.
const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export const KEY_GROUP_LEN = 4;

/** `n` distinct group indexes (0-based, ascending) out of `groupCount`. */
export function pickCheckGroups(groupCount: number, n = 2, rand: () => number = Math.random): number[] {
  const want = Math.max(0, Math.min(n, groupCount));
  const picked = new Set<number>();
  while (picked.size < want) picked.add(Math.floor(rand() * groupCount) % groupCount);
  return [...picked].sort((a, b) => a - b);
}

/** True when `typed` is group `index` of `key` (spacing and case ignored). */
export function keyGroupMatches(key: string, index: number, typed: string): boolean {
  const k = normalize(key);
  const want = k.slice(index * KEY_GROUP_LEN, (index + 1) * KEY_GROUP_LEN);
  return want.length === KEY_GROUP_LEN && normalize(typed) === want;
}
