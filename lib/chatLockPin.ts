// lib/chatLockPin.ts — the per-chat lock PIN: storage format and attempt limit.
// Pure (no React Native), so it is Node-tested in chatLockPin.selftest.ts.
//
// Was a fixed prefix plus ONE unsalted SHA-256 (lib/chatLock.ts hashPin) in
// AsyncStorage, with no attempt limit: a 4–8 digit PIN fell to an offline
// search in well under a second, and on the device it could be guessed as fast
// as it could be typed (2026-10-04).
//
// Now: the same per-lock random salt + scrypt record pinStore uses for the
// Device PIN (services/security/vaultKeys), encoded into the existing `pinHash`
// string so every reader that only checks "is there a PIN" (chat-export's
// `if (!lock.pinHash)`) keeps working. Old hashes are accepted once and
// upgraded on that successful unlock. Failures back off on the same schedule
// as the Device PIN (services/security/pinAttempts.backoffFor).

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { backoffFor } from '../services/security/pinAttempts';
import { checkPinRecord, makePinRecordAsync } from '../services/security/vaultKeys';

const V2 = 'scrypt1$';
/** A gap this long ends a streak of wrong PINs (pinAttempts uses the same). */
const DECAY_MS = 15 * 60_000;

/** The pre-2026-10-04 format. Only ever compared against, never written. */
export function legacyChatPinHash(pin: string): string {
  return bytesToHex(sha256(new TextEncoder().encode('vaultchat-chatlock-v1:' + pin)));
}

export async function makeChatPinHash(pin: string): Promise<string> {
  const rec = await makePinRecordAsync(pin);
  return `${V2}${rec.salt}$${rec.verifier}`;
}

/** `ok`: the PIN matches. `upgrade`: it matched an old-format hash. */
export function checkChatPinHash(stored: string | undefined, pin: string): { ok: boolean; upgrade: boolean } {
  if (!stored || !pin) return { ok: false, upgrade: false };
  if (stored.startsWith(V2)) {
    const [salt, verifier] = stored.slice(V2.length).split('$');
    return { ok: checkPinRecord({ v: 1, salt, verifier }, pin), upgrade: false };
  }
  const ok = stored === legacyChatPinHash(pin);
  return { ok, upgrade: ok };
}

export interface ChatPinAttempts { failN?: number; failAt?: number }

/** Milliseconds before another PIN may be tried (0 = now). Clamped so a clock
 *  that moved backwards can never owe more than one step of the schedule. */
export function chatPinWaitMs(a: ChatPinAttempts, now: number): number {
  const n = a.failN ?? 0;
  const at = a.failAt ?? 0;
  if (n <= 0 || now - at > DECAY_MS) return 0;
  const step = backoffFor(n);
  const owed = Math.min(step, step - (now - at));
  return owed > 0 ? owed : 0;
}

/** The streak after one more wrong PIN at `now`. */
export function afterFailure(a: ChatPinAttempts, now: number): Required<ChatPinAttempts> {
  const live = (a.failN ?? 0) > 0 && now - (a.failAt ?? 0) <= DECAY_MS;
  return { failN: (live ? a.failN! : 0) + 1, failAt: now };
}
