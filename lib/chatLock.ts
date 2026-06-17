// lib/chatLock.ts — real per-chat lock.
//
// Locked chats require biometric and/or a PIN before app/chat.tsx will render
// their messages. The PIN is never stored in clear — only a salted SHA-256
// hash. Config lives in AsyncStorage (device-local, like the rest of the
// app-lock settings).

import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const KEY = 'vc_locked_chats';

export type LockMethod = 'biometric' | 'pin' | 'both';
export type AutoLockTimer = 0 | 60 | 300;

export interface LockedChat {
  chatId: string;
  chatName: string;
  locked: boolean;
  lockMethod: LockMethod;
  autoLockTimer: AutoLockTimer;
  pinHash?: string;       // salted SHA-256 — never the raw PIN
}

function hashPin(pin: string): string {
  return bytesToHex(sha256(new TextEncoder().encode('vaultchat-chatlock-v1:' + pin)));
}

export async function getAllLocks(): Promise<Record<string, LockedChat>> {
  try { const raw = await AsyncStorage.getItem(KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
async function saveAll(d: Record<string, LockedChat>): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(d));
}

export async function getLock(chatId: string): Promise<LockedChat | null> {
  const all = await getAllLocks();
  const e = all[chatId];
  return e && e.locked ? e : null;
}

export async function isChatLocked(chatId: string): Promise<boolean> {
  return !!(await getLock(chatId));
}

export async function setChatLock(
  chatId: string, chatName: string, method: LockMethod, timer: AutoLockTimer, pin?: string,
): Promise<void> {
  const all = await getAllLocks();
  all[chatId] = {
    chatId, chatName, locked: true, lockMethod: method, autoLockTimer: timer,
    pinHash: pin ? hashPin(pin) : undefined,
  };
  await saveAll(all);
}

export async function removeChatLock(chatId: string): Promise<void> {
  const all = await getAllLocks();
  delete all[chatId];
  await saveAll(all);
}

export function verifyPin(lock: LockedChat, pin: string): boolean {
  return !!lock.pinHash && lock.pinHash === hashPin(pin);
}

export async function verifyBiometric(reason = 'Unlock chat'): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  try {
    const hw = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hw || !enrolled) return false;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, fallbackLabel: 'Use PIN' });
    return r.success;
  } catch { return false; }
}

export async function hasBiometric(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try { return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()); }
  catch { return false; }
}

export default {};
