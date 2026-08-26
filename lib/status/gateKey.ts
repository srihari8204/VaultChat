// lib/status/gateKey.ts — wrap a story's content key under its ANSWER.
//
// This is the half of the feature that is real. lib/storyKeys already wraps the
// content key per viewer through the Double Ratchet, which decides WHO may
// decrypt. This adds a second wrap over the top: even an authorised viewer must
// know the answer.
//
// NO NEW CRYPTO. services/security/vaultKeys already solved exactly this
// problem for the unlock PIN — a low-entropy secret turned into a 32-byte key —
// and does it with native scrypt on quick-crypto's background thread, falling
// back to @noble. Reused verbatim rather than reimplemented, so there is one
// KDF in this app and one place to tune it.
//
// WHAT THIS CAN AND CANNOT PROMISE. The strength is the ANSWER's. Whoever holds
// the ciphertext can guess offline, and "my dog's name" falls quickly whatever
// the KDF. scrypt at N=2^14 makes each guess cost real memory and time, which
// is the most any KDF can do — it cannot make a weak answer strong. The compose
// UI should push toward answers only the intended people know; this module
// cannot enforce that.
//
// open() returning null IS the wrong-answer signal — it is authenticated
// decryption, so a wrong key fails to authenticate rather than yielding
// garbage. No separate "is this right?" check is needed, and none should be
// added: a comparison against a stored hash of the answer would hand an
// attacker a cheaper oracle than the KDF.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { deriveVaultKeyAsync, newSalt, seal, open } from '../../services/security/vaultKeys';
import { normalizeAnswer } from './gate';
import type { MediaKey } from '../mediaCrypto';

export interface AnswerLockedKey {
  /** Per-story scrypt salt, hex. Public — it is not a secret, it defeats rainbow tables. */
  salt: string;
  /** The content key, sealed under the answer-derived key. */
  envelope: string;
}

/**
 * Seal `mediaKey` so that only someone who can reproduce `answer` can open it.
 *
 * The salt is fresh per story: without it, two people who chose the same answer
 * would derive the same key, and one precomputed table would open both.
 */
export async function lockKeyWithAnswer(
  mediaKey: MediaKey,
  answer: string,
): Promise<AnswerLockedKey> {
  const salt = newSalt();
  const key = await deriveVaultKeyAsync(normalizeAnswer(answer), salt);
  return { salt: bytesToHex(salt), envelope: seal(key, JSON.stringify(mediaKey)) };
}

/**
 * Try to open an answer-locked key. Returns null when the answer is wrong —
 * which is the ONLY way this reports failure, and is indistinguishable from a
 * tampered envelope. That is intended: an attacker learns nothing beyond "not
 * this guess".
 */
export async function unlockKeyWithAnswer(
  locked: AnswerLockedKey,
  answer: string,
): Promise<MediaKey | null> {
  try {
    const key = await deriveVaultKeyAsync(normalizeAnswer(answer), hexToBytes(locked.salt));
    const plain = open(key, locked.envelope);
    return plain ? (JSON.parse(plain) as MediaKey) : null;
  } catch {
    return null;   // malformed salt/envelope reads as a wrong answer, never a crash
  }
}

export default {};
