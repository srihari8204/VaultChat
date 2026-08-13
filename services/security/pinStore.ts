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

/** Replace the stored PIN. Also clears the legacy keys so no weak copy lingers. */
export async function setPin(pin: string): Promise<void> {
  if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
    throw new Error('PIN must be 4-8 digits');
  }
  await write(await makePinRecordAsync(pin));
  await clearLegacy();
}

/** True when `pin` is the stored PIN. Upgrades a legacy value on first success. */
export async function verifyPin(pin: string): Promise<boolean> {
  if (!pin) return false;

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
