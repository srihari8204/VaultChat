// lib/onboarding.ts — client for the encrypted onboarding backend + a tiny
// in-memory store carried across the auth screens.
//
// The store holds onboarding-in-progress data (email, phone, names, dob, status,
// answers, mpin). It is RAM-only and MUST be cleared on success — plaintext MPIN
// and answers never touch disk. (The app has no Zustand; this module singleton
// fills the same role the spec's useOnboardingStore would.)

import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as FileSystem from 'expo-file-system/legacy';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { api, setTokens, setCachedUser } from './api';
import { uploadAttachment } from './chatService';

// ── In-memory onboarding store ──────────────────────────────────────────────
export interface OnboardingState {
  email: string;
  phone: string;
  emailTicket: string;        // proof email was OTP-verified
  firstName: string;
  lastName: string;
  dob: string;                // ISO yyyy-mm-dd
  status: string;
  profilePicLocalUri: string | null;
  profilePicUrl: string | null;
  securityAnswers: { questionCode: string; answer: string }[];
  mpin: string;
  userId: string | null;
}

function blank(): OnboardingState {
  return {
    email: '', phone: '', emailTicket: '', firstName: '', lastName: '',
    dob: '', status: '', profilePicLocalUri: null, profilePicUrl: null,
    securityAnswers: [], mpin: '', userId: null,
  };
}

let _state: OnboardingState = blank();

export const onboarding = {
  get: (): OnboardingState => _state,
  set: (patch: Partial<OnboardingState>) => { _state = { ..._state, ...patch }; },
  reset: () => { _state = blank(); },
};

// ── Google account picker (no auto-auth) ────────────────────────────────────
// Opens the Google account chooser and returns the profile WITHOUT exchanging
// for our JWT — the new flow authenticates via email-OTP + MPIN, not /auth/google.
export interface GoogleAccount { email: string; firstName: string; lastName: string; photoURL: string | null }

export async function pickGoogleAccount(): Promise<GoogleAccount> {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  try { await GoogleSignin.signOut(); } catch { /* force the chooser to show */ }
  let res: any;
  try {
    res = await GoogleSignin.signIn();
  } catch (e: any) {
    if (e?.code === statusCodes.SIGN_IN_CANCELLED) throw new Error('Cancelled');
    if (e?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) throw new Error('Google Play Services not available');
    throw new Error(e?.message ?? 'Google sign-in failed');
  }
  // v13+ returns { type: 'success' | 'cancelled' | 'noSavedCredential', data }.
  // Treat a dismissed chooser as a clean cancel (not a hard error).
  if (res?.type === 'cancelled' || res?.type === 'noSavedCredential') throw new Error('Cancelled');
  const u = res?.data?.user ?? res?.user ?? {};   // v13+: data.user; legacy: user
  if (!u.email) throw new Error('Could not read the account email');
  return {
    email: u.email,
    firstName: u.givenName ?? (u.name ? String(u.name).split(' ')[0] : ''),
    lastName: u.familyName ?? '',
    photoURL: u.photo ?? null,
  };
}

// ── Backend calls (error envelope { error: { code, message } }) ──────────────
function msg(e: any, fallback: string): string {
  return e?.body?.error?.message || e?.message || fallback;
}

export async function sendEmailOtp(email: string): Promise<void> {
  await api('/auth/onboard/send-otp', { method: 'POST', json: { email }, auth: false });
}

export async function verifyEmailOtp(email: string, code: string): Promise<string> {
  const r = await api<{ ok: true; emailTicket: string }>('/auth/onboard/verify-otp', {
    method: 'POST', json: { email, code }, auth: false,
  });
  return r.emailTicket;
}

export async function lookupUser(email: string, phone: string): Promise<{ exists: boolean; userId?: string; conflict?: 'phone' | 'email' }> {
  return api('/auth/lookup', { method: 'POST', json: { email, phone }, auth: false });
}

export async function initProfile(input: {
  email: string; phone: string; emailTicket: string;
  firstName: string; lastName: string; dob: string; status: string; profilePicUrl?: string | null;
}): Promise<string> {
  const r = await api<{ userId: string }>('/auth/profile/init', { method: 'POST', json: input, auth: false });
  return r.userId;
}

export async function saveSecurityQuestions(userId: string, answers: { questionCode: string; answer: string }[]): Promise<void> {
  await api('/auth/security-questions/save', { method: 'POST', json: { userId, answers }, auth: false });
}

export async function setMpinRemote(userId: string, mpin: string): Promise<void> {
  await api('/auth/mpin/set', { method: 'POST', json: { userId, mpin }, auth: false });
}

// Verifies MPIN, stores the issued JWTs, returns nothing (caller routes to chats).
export async function verifyMpinRemote(userId: string, mpin: string): Promise<void> {
  const r = await api<{ accessToken: string; refreshToken: string }>('/auth/mpin/verify', {
    method: 'POST', json: { userId, mpin }, auth: false,
  });
  await setTokens(r.accessToken, r.refreshToken);
  await setCachedUser({ id: userId });
}

export async function configureMfa(enabled: boolean): Promise<void> {
  await api('/auth/mfa/configure', { method: 'POST', json: { mfaEnabled: enabled } });
}

// Upload a picked/cropped avatar (post-login — needs the JWT) and set it on the
// profile. The bytes are AES-256-GCM encrypted with a random per-photo key BEFORE
// upload, so the object store only ever holds ciphertext; the key is sent to the
// server (over TLS) which wraps it under the master key. Best-effort: a failed
// photo upload must not block reaching Chats.
export async function uploadAndSetProfilePhoto(localUri: string): Promise<void> {
  const b64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));

  const dek = randomBytes(32);
  const iv  = randomBytes(12);
  const ct  = gcm(dek, iv).encrypt(bytes);                 // ciphertext includes the 16-byte tag
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0); blob.set(ct, iv.length);                // iv ‖ ct‖tag

  const tmp = `${FileSystem.cacheDirectory}avatar_${Date.now()}.enc`;
  await FileSystem.writeAsStringAsync(tmp, Buffer.from(blob).toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
  const up = await uploadAttachment(tmp, 'avatar.enc', 'application/octet-stream');
  if (up?.id) await api('/auth/profile/photo', { method: 'POST', json: { photoId: up.id, photoKey: bytesToHex(dek) } });
}

// ── MPIN recovery (forgot MPIN → security questions) ────────────────────────
export async function getRecoveryQuestions(userId: string): Promise<string[]> {
  const r = await api<{ questions: string[] }>(`/auth/security-questions/${encodeURIComponent(userId)}`, { auth: false });
  return r.questions;
}

export async function verifyRecoveryAnswers(userId: string, answers: { questionCode: string; answer: string }[]): Promise<string> {
  const r = await api<{ ok: true; recoveryTicket: string }>('/auth/security-questions/verify', {
    method: 'POST', json: { userId, answers }, auth: false,
  });
  return r.recoveryTicket;
}

export async function recoverMpin(userId: string, recoveryTicket: string, mpin: string): Promise<void> {
  const r = await api<{ accessToken: string; refreshToken: string }>('/auth/mpin/recover', {
    method: 'POST', json: { userId, recoveryTicket, mpin }, auth: false,
  });
  await setTokens(r.accessToken, r.refreshToken);
  await setCachedUser({ id: userId });
}

export { msg as onboardingError };
