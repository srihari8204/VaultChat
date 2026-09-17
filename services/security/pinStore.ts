// services/security/pinStore.ts — the ONE place the app's PIN is stored.
//
// Before this file there were three, and they disagreed:
//   • vaultKeys.ts        scrypt + salt, PIN never stored        (correct)
//   • authService.ts      unsalted SHA-256 → 'vc_pin_hash'       (~10^8 space,
//                         precomputable; identical PINs collide across users)
//   • securityService.ts  the PIN verbatim → 'vault_pin'         (nothing to break)
//
// They also used DIFFERENT KEYS, so the PIN set on the backup-PIN screen was a
// different secret from the one the lock screen checked — a user with the right
// PIN could be locked out. Everything now reads and writes the record below.
//
// Migration is lazy and one-way: the first successful verify against a legacy
// value re-seals it as a v1 record and deletes the legacy key. Nobody is logged
// out by the upgrade, and the weak copies stop existing as people unlock.

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import {
  makePinRecordAsync, checkPinRecordAsync, type PinRecord,
} from './vaultKeys';
import { createPinAttemptTracker } from './pinAttempts';

const KEY          = 'vc_pin_v1';     // the scrypt record
const LEGACY_HASH  = 'vc_pin_hash';   // authService: unsalted SHA-256 of the PIN
const LEGACY_PLAIN = 'vault_pin';     // securityService: the PIN itself

async function read(): Promise<PinRecord | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? JSON.parse(raw) as PinRecord : null;
  } catch { return null; }
}

async function write(rec: PinRecord): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(rec));
}

// ─── #32: session sealing is OPT-IN and PIN-GATED, and this is the gate ───────
//
// Sealing the real session under a PIN is only safe for a user who HAS one.
// Every other unlock path in the app (biometric, the REMOTE MPIN check in
// app/app-lock) produces no local PIN, so a blanket seal would lock those users
// out permanently. So the seal is hung on the two moments that define "this
// user has a local PIN", right here where all callers already route through:
// setPin → seal what already exists, clearPin → put it back in the clear.
// A user who never sets a PIN never touches either, and their token path stays
// byte-identical to before. Dynamic import: lib/api pulls in half the app.
const apiMod = () => import('../../lib/api');

/** Replace the stored PIN. Also clears the legacy keys so no weak copy lingers. */
export async function setPin(pin: string): Promise<void> {
  if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
    throw new Error('PIN must be 4-8 digits');
  }
  await write(await makePinRecordAsync(pin));
  await clearLegacy();
  // Seal the session that already exists under the new PIN (and provision the
  // at-rest cache DEK). No-op when the flag is off or there is no session yet;
  // it keeps the plaintext fallback on any failure, so this cannot brick login.
  try { await (await apiMod()).sealCurrentSession(pin); } catch {}
}

// ─── Brute-force tracking lives HERE, not in the screens. 2026-09-17 ─────────
//
// services/security/pinAttempts has done this correctly since it was written,
// and it was never reachable: recordFailure() had one caller
// (securityService.verifyPIN, whose only caller is an unrouted screen) and
// getBackoffMs() had NO caller anywhere. So a guessing attack against the app
// lock, the vault or a hidden chat raised no signal and cost the attacker
// nothing. verifyPin is the one function every local PIN check already routes
// through, so wiring it here fixes all of them without touching a screen.
//
// Second tracker instance, on purpose: securityService keeps its own for
// getSignal(). The tracker is stateless — all of it is the one SecureStore key
// — so both instances read and write the same streak.
const attempts = createPinAttemptTracker({
  get: (k: string) => SecureStore.getItemAsync(k),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  del: (k: string) => SecureStore.deleteItemAsync(k).then(() => undefined),
});

/** True when `pin` is the stored PIN. Upgrades a legacy value on first success. */
export async function verifyPin(pin: string): Promise<boolean> {
  if (!pin) return false;

  // Refuse while the backoff owed by the current streak is unspent.
  //
  // Returning false WITHOUT recording a failure is the whole safety argument:
  // counting a refused attempt would extend the streak that caused the refusal,
  // and a user tapping an impatient retry would ratchet themselves into a
  // lockout that never ends. As written the streak can only grow from a real
  // wrong PIN, caps at 60s (pinAttempts.BACKOFF_MS) and decays after 15 quiet
  // minutes, so no PIN holder is ever locked out for good.
  try { if (await attempts.getBackoffMs() > 0) return false; } catch {}

  const ok = await check(pin);
  // Never let the tracker's storage break an otherwise correct unlock.
  try {
    if (ok) await attempts.recordSuccess();
    else await attempts.recordFailure();
  } catch {}
  return ok;
}

async function check(pin: string): Promise<boolean> {
  const rec = await read();
  if (rec) return checkPinRecordAsync(rec, pin);

  // No v1 record — this install still holds one of the old shapes.
  if (await verifyLegacy(pin)) {
    await write(await makePinRecordAsync(pin));   // upgrade in place
    await clearLegacy();
    return true;
  }
  return false;
}

export async function hasPin(): Promise<boolean> {
  if (await read()) return true;
  try {
    return !!(await SecureStore.getItemAsync(LEGACY_HASH))
        || !!(await SecureStore.getItemAsync(LEGACY_PLAIN));
  } catch { return false; }
}

/** Forget the PIN entirely (logout / account wipe). */
export async function clearPin(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY); } catch {}
  await clearLegacy();
  // Removing the PIN removes the only key to the sealed session — put the
  // tokens back on the plaintext path so the user isn't stranded. No-op during
  // logout (clearTokens() already ran and there is nothing in memory).
  try { await (await apiMod()).unsealCurrentSession(); } catch {}
}

async function verifyLegacy(pin: string): Promise<boolean> {
  try {
    const plain = await SecureStore.getItemAsync(LEGACY_PLAIN);
    if (plain != null && plain === pin) return true;
  } catch {}
  try {
    const hash = await SecureStore.getItemAsync(LEGACY_HASH);
    if (hash) {
      const h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pin);
      if (h === hash) return true;
    }
  } catch {}
  return false;
}

async function clearLegacy(): Promise<void> {
  for (const k of [LEGACY_HASH, LEGACY_PLAIN]) {
    try { await SecureStore.deleteItemAsync(k); } catch {}
  }
}

export default {};
