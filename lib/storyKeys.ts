// lib/storyKeys.ts — per-viewer wrapping of a story's content key (W7).
//
// A story's media is encrypted once with a random content key (a MediaKey, same
// primitive as 1:1 media). That single key is then wrapped SEPARATELY for each
// authorized viewer by encrypting it through the author↔viewer E2EE session — the
// same proven per-peer Double Ratchet used for direct messages. The server stores
// the resulting envelopes opaquely (GET /stories/:id/key serves a viewer only
// their own), so it can never recover the content key or read the story.
//
// On the viewing side, the envelope is decrypted back to the MediaKey, which is
// then handed to the normal media-decrypt path (putMediaKey + getDecryptedAttachmentUri).

import { e2eeEncrypt, e2eeDecrypt } from '../services/crypto/e2eeSession.rn';
import type { MediaKey } from './mediaCrypto';

export interface WrappedStoryKey { viewerId: string; wrappedKey: string }

/**
 * Wrap `mediaKey` for each viewer via their E2EE session. Viewers without a
 * published key bundle (or a failing session) are skipped — they simply won't be
 * able to view the encrypted story, which is the safe outcome.
 */
export async function wrapStoryKeyForViewers(
  viewerIds: string[],
  mediaKey: MediaKey,
): Promise<WrappedStoryKey[]> {
  const payload = JSON.stringify(mediaKey);
  const out: WrappedStoryKey[] = [];
  for (const viewerId of viewerIds) {
    try {
      const wrappedKey = await e2eeEncrypt('', viewerId, payload);
      out.push({ viewerId, wrappedKey });
    } catch { /* skip viewers we can't establish a session with */ }
  }
  return out;
}

/**
 * Unwrap an encrypted story's content key, addressed to me by `authorId`.
 * Returns the MediaKey, or null if it can't be decrypted.
 */
export async function unwrapStoryKey(
  authorId: string,
  wrappedKey: string,
): Promise<MediaKey | null> {
  try {
    const plain = await e2eeDecrypt('', authorId, 0, wrappedKey); // messageId 0 → not cached
    const mk = JSON.parse(plain);
    if (mk && typeof mk.k === 'string' && typeof mk.n === 'string') return mk as MediaKey;
  } catch { /* fall through */ }
  return null;
}

// Required by expo-router to silence "no default export" route warnings.
export default {};
