// lib/contactSync.ts
// Cache of the contacts that contact discovery matched, keyed for lookup by
// VaultID. The READ+HASH+SYNC half of this file was deleted: it was dead code
// (nothing imported readPhoneContacts/syncContactsWithServer) that hashed
// sha256("+91XXXXXXXXXX") — WITH the plus — against a server that stores
// sha256("91XXXXXXXXXX"), so it could only ever return zero matches, and it
// POSTed to /api/contacts/match with no Authorization header at all. Contact
// discovery lives in app/contacts.tsx via chatService.hashPhoneForLookup /
// matchContacts; there is exactly one hashing path and this is not it.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type PhoneContact = {
  id:        string;
  name:      string;
  phone:     string;      // normalised E.164
  phoneHash: string;      // sha256(phone) — sent to server
  avatar?:   string;      // local contact photo URI
};

export type VaultContact = {
  vaultId:      string;
  name:         string;   // from phone contacts (YOUR saved name)
  phone:        string;
  phoneHash:    string;
  avatar?:      string;   // local contact photo
  vaultAvatar?: string;   // their crazzychat profile photo
  vaultName?:   string;   // their crazzychat display name
  isOnVault:    boolean;
  isSaved:      boolean;  // true = saved in your phone contacts
  lastSeen?:    number;
  status?:      string;
  online?:      boolean;
};

// A CACHE, not a source of truth: a truncated blob (killed mid-write, disk
// full) must read as "nothing cached yet" so the caller re-fetches, never as a
// throw the caller has no way to recover from. Array.isArray as well, because
// a blob that parses to an object would sail through and then fail on .find.
export async function getCachedContacts(): Promise<VaultContact[]> {
  const raw = await AsyncStorage.getItem('vaultContacts');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export async function findContactByVaultId(
  vaultId:  string,
  contacts: VaultContact[]
): Promise<VaultContact | null> {
  return contacts.find(c => c.vaultId === vaultId) || null;
}
