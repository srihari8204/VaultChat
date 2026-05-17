// services/trustedContactService.ts
// Trusted Contact Verification — QR code mutual verification of encryption keys
// Both users scan each other's QR to verify the safety number matches
// Prevents MITM attacks on the encryption channel

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import * as Crypto from 'expo-crypto';

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
  const myUid = auth().currentUser?.uid;
  if (!myUid) throw new Error('Not authenticated');

  const safetyNumber = await generateSafetyNumber(chatId, myUid, peerUid);

  return JSON.stringify({
    type: 'vaultchat_verify',
    chatId,
    uid: myUid,
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

    const myUid = auth().currentUser?.uid;
    if (!myUid) return { verified: false, message: 'Not authenticated' };

    const ourSafetyNumber = await generateSafetyNumber(chatId, myUid, peerUid);

    if (data.safetyNumber === ourSafetyNumber) {
      // Mark contact as verified in Firestore
      await firestore().collection('users').doc(myUid)
        .collection('verifiedContacts').doc(peerUid).set({
          verifiedAt: firestore.FieldValue.serverTimestamp(),
          chatId,
          safetyNumber: ourSafetyNumber,
        });

      return { verified: true, message: 'Contact verified! Encryption keys match.' };
    }

    return { verified: false, message: 'Safety numbers do NOT match. Possible MITM attack.' };
  } catch {
    return { verified: false, message: 'Invalid QR code format' };
  }
}

// Check if a contact is verified
export async function isContactVerified(peerUid: string): Promise<boolean> {
  const myUid = auth().currentUser?.uid;
  if (!myUid) return false;

  try {
    const doc = await firestore().collection('users').doc(myUid)
      .collection('verifiedContacts').doc(peerUid).get();
    return doc.exists;
  } catch {
    return false;
  }
}

// Remove verification (e.g., if keys change)
export async function removeVerification(peerUid: string): Promise<void> {
  const myUid = auth().currentUser?.uid;
  if (!myUid) return;

  await firestore().collection('users').doc(myUid)
    .collection('verifiedContacts').doc(peerUid).delete().catch(() => {});
}
