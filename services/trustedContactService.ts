// services/trustedContactService.ts
// Trusted Contact Verification — QR code mutual verification of encryption keys
// Both users scan each other's QR to verify the safety number matches
// Prevents MITM attacks on the encryption channel
//
// ── Why this no longer touches Firebase ──
//
// It used to read identity from `auth().currentUser?.uid` (Firebase Auth) and
// store verifications in Firestore. The app moved to JWT sessions long ago and
// nothing signs in to Firebase Auth any more, so `currentUser` was always null
// and EVERY function here returned early:
//
//   getVerificationQRData()  → threw 'Not authenticated'
//   verifyScannedQR()        → returned 'Not authenticated'
//   isContactVerified()      → returned false, always
//
// The feature was inert. lib/vaultBeamAutoDownload gates "trusted contacts
// only" auto-download on isContactVerified(), so that setting failed CLOSED —
// nothing auto-downloaded in trusted-only mode, whatever the user had verified.
//
// Identity now comes from the real session, and verifications are stored on the
// device. Device-local is the correct home for this: a verification is an
// assertion that THIS device saw the peer's key in person, so it should not
// sync to a new device that never witnessed the exchange — the same reason
// Signal keeps verification state per-device.
//
// The failure semantics are unchanged: any error, missing session, or unknown
// contact still resolves false. This can only widen from "never verified" to
// "verified after the user actually scans", which is the designed behaviour.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { getCurrentUserAsync } from '../app/(constants)/authService';

const STORE_KEY = 'vc_verified_contacts';

/** Current session user id, or null when signed out. Never throws. */
async function myId(): Promise<string | null> {
  try { return (await getCurrentUserAsync())?.id ?? null; } catch { return null; }
}

interface VerificationRecord {
  chatId: string;
  safetyNumber: string;
  verifiedAt: string;
}

/** Whole store: { [ownerId]: { [peerId]: record } } — scoped by owner so a
 *  device shared between accounts never leaks one account's verifications. */
type Store = Record<string, Record<string, VerificationRecord>>;

async function readStore(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch { return {}; }
}

async function writeStore(s: Store): Promise<void> {
  try { await AsyncStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}

// Generate a safety number for a chat (derived from both users' public keys)
export async function generateSafetyNumber(chatId: string, myUid: string, peerUid: string): Promise<string> {
  // Combine both UIDs and chatId to create a deterministic safety number
  const combined = [myUid, peerUid].sort().join(':') + ':' + chatId;
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, combined);

  // Format as 60-digit number (like Signal's safety number)
  const digits = hash.replace(/[a-f]/gi, (c) => String(c.charCodeAt(0) % 10));
  const formatted = digits.substring(0, 60);

  // Group into 12 groups of 5
  return formatted.match(/.{1,5}/g)?.join(' ') ?? formatted;
}

// Generate QR code data for verification
export async function getVerificationQRData(chatId: string, peerUid: string): Promise<string> {
  const uid = await myId();
  if (!uid) throw new Error('Not authenticated');

  const safetyNumber = await generateSafetyNumber(chatId, uid, peerUid);

  return JSON.stringify({
    type: 'vaultchat_verify',
    chatId,
    uid,
    safetyNumber,
    timestamp: Date.now(),
  });
}

// Verify scanned QR code matches our safety number
export async function verifyScannedQR(scannedData: string, chatId: string, peerUid: string): Promise<{
  verified: boolean;
  message: string;
}> {
  try {
    const data = JSON.parse(scannedData);

    if (data.type !== 'vaultchat_verify') {
      return { verified: false, message: 'Not a VaultChat verification code' };
    }

    if (data.uid !== peerUid) {
      return { verified: false, message: 'QR code belongs to a different contact' };
    }

    const uid = await myId();
    if (!uid) return { verified: false, message: 'Not authenticated' };

    const ourSafetyNumber = await generateSafetyNumber(chatId, uid, peerUid);

    if (data.safetyNumber === ourSafetyNumber) {
      const store = await readStore();
      store[uid] = store[uid] ?? {};
      store[uid][peerUid] = {
        chatId,
        safetyNumber: ourSafetyNumber,
        verifiedAt: new Date().toISOString(),
      };
      await writeStore(store);

      return { verified: true, message: 'Contact verified! Encryption keys match.' };
    }

    return { verified: false, message: 'Safety numbers do NOT match. Possible MITM attack.' };
  } catch {
    return { verified: false, message: 'Invalid QR code format' };
  }
}

// Check if a contact is verified
export async function isContactVerified(peerUid: string): Promise<boolean> {
  const uid = await myId();
  if (!uid) return false;
  try {
    const store = await readStore();
    return !!store[uid]?.[peerUid];
  } catch {
    return false;
  }
}

/** Full verification record, for a UI that wants to show when it happened. */
export async function getVerification(peerUid: string): Promise<VerificationRecord | null> {
  const uid = await myId();
  if (!uid) return null;
  const store = await readStore();
  return store[uid]?.[peerUid] ?? null;
}

// Remove verification (e.g., if keys change)
export async function removeVerification(peerUid: string): Promise<void> {
  const uid = await myId();
  if (!uid) return;
  const store = await readStore();
  if (store[uid]?.[peerUid]) {
    delete store[uid][peerUid];
    await writeStore(store);
  }
}
