// services/ghostModeService.ts
// Ghost Mode — per-contact privacy controls
// Hide: online status, typing indicators, read receipts, last seen
// Stored in Firestore under users/{uid}/ghostMode/{contactUid}

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

export interface GhostSettings {
  hideOnline: boolean;
  hideTyping: boolean;
  hideReadReceipts: boolean;
  hideLastSeen: boolean;
  enabled: boolean;       // master toggle for this contact
  updatedAt: number;
}

const DEFAULT_SETTINGS: GhostSettings = {
  hideOnline: true,
  hideTyping: true,
  hideReadReceipts: true,
  hideLastSeen: true,
  enabled: false,
  updatedAt: Date.now(),
};

function ghostRef(contactUid: string) {
  const uid = auth().currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');
  return firestore().collection('users').doc(uid).collection('ghostMode').doc(contactUid);
}

// Get ghost settings for a specific contact
export async function getGhostSettings(contactUid: string): Promise<GhostSettings> {
  try {
    const doc = await ghostRef(contactUid).get();
    if (doc.exists) return doc.data() as GhostSettings;
    return { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Update ghost settings for a contact
export async function setGhostSettings(contactUid: string, settings: Partial<GhostSettings>): Promise<void> {
  const current = await getGhostSettings(contactUid);
  const updated = { ...current, ...settings, updatedAt: Date.now() };
  await ghostRef(contactUid).set(updated);
}

// Toggle ghost mode on/off for a contact (master toggle)
export async function toggleGhostMode(contactUid: string): Promise<boolean> {
  const current = await getGhostSettings(contactUid);
  const newEnabled = !current.enabled;
  await setGhostSettings(contactUid, { enabled: newEnabled });
  return newEnabled;
}

// Check if ghost mode is active for a specific contact
export async function isGhostActiveFor(contactUid: string): Promise<boolean> {
  const settings = await getGhostSettings(contactUid);
  return settings.enabled;
}

// Check if we should hide typing from a contact
export async function shouldHideTyping(contactUid: string): Promise<boolean> {
  const settings = await getGhostSettings(contactUid);
  return settings.enabled && settings.hideTyping;
}

// Check if we should hide read receipts from a contact
export async function shouldHideReadReceipts(contactUid: string): Promise<boolean> {
  const settings = await getGhostSettings(contactUid);
  return settings.enabled && settings.hideReadReceipts;
}

// Check if we should hide online status from a contact
export async function shouldHideOnline(contactUid: string): Promise<boolean> {
  const settings = await getGhostSettings(contactUid);
  return settings.enabled && settings.hideOnline;
}

// Check if we should hide last seen from a contact
export async function shouldHideLastSeen(contactUid: string): Promise<boolean> {
  const settings = await getGhostSettings(contactUid);
  return settings.enabled && settings.hideLastSeen;
}

// Get all contacts with ghost mode enabled
export async function getAllGhostContacts(): Promise<string[]> {
  const uid = auth().currentUser?.uid;
  if (!uid) return [];
  try {
    const snap = await firestore()
      .collection('users').doc(uid).collection('ghostMode')
      .where('enabled', '==', true)
      .get();
    return snap.docs.map(d => d.id);
  } catch {
    return [];
  }
}

// Remove ghost mode for a contact entirely
export async function removeGhostMode(contactUid: string): Promise<void> {
  try {
    await ghostRef(contactUid).delete();
  } catch {
    // ignore
  }
}
