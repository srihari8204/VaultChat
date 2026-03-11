import * as ExpoCrypto from 'expo-crypto';

// lib/contactSync.ts
// Reads phone contacts, hashes phones, syncs with server.
// Phone numbers are NEVER sent raw — SHA-256 hashed only.

import * as Contacts from 'expo-contacts';
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
  vaultAvatar?: string;   // their VaultChat profile photo
  vaultName?:   string;   // their VaultChat display name
  isOnVault:    boolean;
  isSaved:      boolean;  // true = saved in your phone contacts
  lastSeen?:    number;
  status?:      string;
  online?:      boolean;
};

// Normalise to E.164 (+91XXXXXXXXXX for India)
function normalisePhone(raw: string, cc = '+91'): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return cc + d;
  if (d.length > 10)   return '+' + d;
  return d;
}

// Read all phone contacts
export async function readPhoneContacts(): Promise<PhoneContact[]> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('Contacts permission denied');

  const { data } = await Contacts.getContactsAsync({
    fields: [
      Contacts.Fields.Name,
      Contacts.Fields.PhoneNumbers,
      Contacts.Fields.Image,
    ],
  });

  const out: PhoneContact[] = [];
  for (const c of data) {
    if (!c.phoneNumbers?.length) continue;
    for (const pn of c.phoneNumbers) {
      if (!pn.number) continue;
      const phone     = normalisePhone(pn.number);
      const phoneHash = await ExpoCrypto.digestStringAsync(ExpoCrypto.CryptoDigestAlgorithm.SHA256, phone);
      out.push({
        id:        c.id || Math.random().toString(36).slice(2),
        name:      c.name || 'Unknown',
        phone,
        phoneHash,
        avatar:    c.imageAvailable ? c.image?.uri : undefined,
      });
    }
  }
  return out;
}

// Send hashes to server → get back VaultIDs + their profile info
export async function syncContactsWithServer(
  serverUrl:     string,
  myVaultId:     string,
  phoneContacts: PhoneContact[]
): Promise<VaultContact[]> {
  const hashes = phoneContacts.map(c => c.phoneHash);

  const res = await fetch(`${serverUrl}/api/contacts/match`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ myVaultId, phoneHashes: hashes }),
  });
  if (!res.ok) throw new Error('Contact sync failed');

  // Server returns: [{ phoneHash, vaultId, vaultName, vaultAvatar, online, lastSeen, status }]
  const matched: {
    phoneHash:   string;
    vaultId:     string;
    vaultName?:  string;
    vaultAvatar?:string;
    online?:     boolean;
    lastSeen?:   number;
    status?:     string;
  }[] = await res.json();

  const contacts: VaultContact[] = phoneContacts.map(pc => {
    const m = matched.find(x => x.phoneHash === pc.phoneHash);
    return {
      vaultId:     m?.vaultId     || '',
      name:        pc.name,            // YOUR saved name for this person
      phone:       pc.phone,
      phoneHash:   pc.phoneHash,
      avatar:      pc.avatar,
      vaultAvatar: m?.vaultAvatar,
      vaultName:   m?.vaultName,
      isOnVault:   !!m,
      isSaved:     true,               // came from phone contacts = saved
      online:      m?.online,
      lastSeen:    m?.lastSeen,
      status:      m?.status,
    };
  });

  await AsyncStorage.setItem('vaultContacts', JSON.stringify(contacts));
  await AsyncStorage.setItem('contactSyncTs', String(Date.now()));
  return contacts;
}

export async function getCachedContacts(): Promise<VaultContact[]> {
  const raw = await AsyncStorage.getItem('vaultContacts');
  return raw ? JSON.parse(raw) : [];
}

export async function findContactByVaultId(
  vaultId:  string,
  contacts: VaultContact[]
): Promise<VaultContact | null> {
  return contacts.find(c => c.vaultId === vaultId) || null;
}
