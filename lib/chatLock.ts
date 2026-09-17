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

// ABSENT IS NOT THE SAME AS UNREADABLE.
//
// This used to be try { ... } catch { return {}; }, so a corrupt or unreadable
// lock table read as "no chat is locked anywhere". Every caller inherited that:
// app/chat.tsx has a deliberate fail-closed catch that this swallow turned into
// DEAD CODE, and chat-export.tsx opened its export gate the same way. Patching
// the callers could never work while the shared reader lied to all of them.
//
// Now a missing key returns {} (genuinely nothing locked) and a storage or
// parse failure THROWS, so each caller decides - and all three fail closed
// (2026-09-17).
export async function getAllLocks(): Promise<Record<string, LockedChat>> {
  const raw = await AsyncStorage.getItem(KEY);
  if (raw == null) return {};
  const parsed = JSON.parse(raw) as Record<string, LockedChat>;
  // Array.isArray as well as typeof: typeof [] is 'object', so a truncated or
  // rewritten blob that parses as an ARRAY sailed through this guard and then
  // read as "no chat is locked anywhere" - the exact fail-open this throw was
  // added to close, surviving in one shape (2026-09-17).
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('chatLock: lock table is not an object');
  }
  return parsed;
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

// FAIL CLOSED ON WEB.
//
// This used to `return true` on web, and web is a configured platform (app.json)
// — so in a browser build every biometric-locked chat opened with no check at
// all, the export gate included. expo-local-authentication has no real web
// implementation, so "no answer" was being read as "yes".
//
// The rest of the app already treats web as "biometrics do not exist here":
// app/lock.tsx sends web straight to the secret-code stage, and hasBiometric()
// below already returns false. This now agrees with both. Callers that also
// hold a PIN fall through to it, so a web user with a PIN is not stranded —
// only a biometric-only chat is, and that is the correct answer (2026-09-17).
export async function verifyBiometric(reason = 'Unlock chat'): Promise<boolean> {
  if (Platform.OS === 'web') return false;
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
