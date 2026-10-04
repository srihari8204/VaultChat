// lib/peerSafetyStatus.ts — the live state shown beside each contact in the
// Encryption status screen's safety-number picker (app/d2de-status.tsx).
//
// Each direct chat's state is worked out the way app/verify-contact.tsx does
// it (both identity keys → the safety number → lib/verification
// verificationStatus against the verified list and the number this device
// recorded), so the picker never says "Verified" for a number that has since
// changed. That costs one key fetch per contact, so they run a few at a time
// and stop when the picker closes. Pure, so lib/peerSafetyStatus.selftest.ts
// runs it.

export type PeerSafetyStatus = 'verified' | 'unverified' | 'changed' | 'nokey' | 'unknown';

/** Short words shown after the contact's name. */
export function peerSafetyLabel(s: PeerSafetyStatus): string {
  switch (s) {
    case 'verified':   return 'Verified';
    case 'unverified': return 'Not verified';
    case 'changed':    return 'Security code changed';
    case 'nokey':      return 'No end-to-end encryption yet';
    case 'unknown':    return 'Could not check';
  }
}

/**
 * Run `fn` over `items`, at most `limit` at a time, in order of start.
 * `stopped()` is checked before each item starts; once it is true no new item
 * starts (running ones finish). A failing item does not stop the others.
 */
export async function forEachLimited<T>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<void>, stopped: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) {
      const item = items[next++];
      try { await fn(item); } catch { /* the caller records its own failures */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
