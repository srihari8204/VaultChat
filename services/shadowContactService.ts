// services/shadowContactService.ts
// Shadow Contact — secret code access to hidden contacts
// Contacts are hidden from the main list and only accessible by entering a secret code
// Stored encrypted in AsyncStorage

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const SHADOW_KEY = 'vc_shadow_contacts';
const SHADOW_CODE_KEY = 'vc_shadow_code_hash';

export interface ShadowContact {
  uid: string;
  name: string;
  chatId: string;
  addedAt: number;
}

// Set secret code for shadow contacts
export async function setShadowCode(code: string): Promise<void> {
  if (!code || code.length < 4) throw new Error('Code must be at least 4 characters');
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code);
  await AsyncStorage.setItem(SHADOW_CODE_KEY, hash);
}

// Verify secret code
export async function verifyShadowCode(code: string): Promise<boolean> {
  const stored = await AsyncStorage.getItem(SHADOW_CODE_KEY);
  if (!stored) return false;
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code);
  return hash === stored;
}

// Check if shadow code is set
export async function hasShadowCode(): Promise<boolean> {
  return !!(await AsyncStorage.getItem(SHADOW_CODE_KEY));
}

// Get all shadow contacts (requires prior code verification)
export async function getShadowContacts(): Promise<ShadowContact[]> {
  try {
    const raw = await AsyncStorage.getItem(SHADOW_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// Add a contact to shadow list
export async function addShadowContact(contact: Omit<ShadowContact, 'addedAt'>): Promise<void> {
  const contacts = await getShadowContacts();
  if (contacts.find(c => c.uid === contact.uid)) return; // already exists
  contacts.push({ ...contact, addedAt: Date.now() });
  await AsyncStorage.setItem(SHADOW_KEY, JSON.stringify(contacts));
}

// Remove a contact from shadow list
export async function removeShadowContact(uid: string): Promise<void> {
  const contacts = await getShadowContacts();
  const filtered = contacts.filter(c => c.uid !== uid);
  await AsyncStorage.setItem(SHADOW_KEY, JSON.stringify(filtered));
}

// Check if a contact is in shadow list
export async function isShadowContact(uid: string): Promise<boolean> {
  const contacts = await getShadowContacts();
  return contacts.some(c => c.uid === uid);
}
