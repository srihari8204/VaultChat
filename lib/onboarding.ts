// lib/onboarding.ts — client for the encrypted onboarding backend + a tiny
// in-memory store carried across the auth screens.
//
// IDENTITY IS THE MOBILE NUMBER, AND ONLY THE MOBILE NUMBER.
//
// Email used to be the login factor: the landing screen asked for both, the OTP
// went to the inbox, and /auth/profile/init would not accept an account without
// an emailTicket. That put a Google account (or a working mail server, or a spam
// folder that behaved) between a person and their own phone. The WhatsApp model
// is one factor the user is already holding — the SIM — so email is now nothing
// but an optional recovery address, collected on the profile step and provable
// later or never.
//
// The store holds onboarding-in-progress data (phone, email, names, dob, status,
// answers, mpin). It is RAM-only and MUST be cleared on success — plaintext MPIN
// and answers never touch disk. (The app has no Zustand; this module singleton
// fills the same role the spec's useOnboardingStore would.)

import * as FileSystem from 'expo-file-system/legacy';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import { api, setTokens, setCachedUser } from './api';
import { uploadAttachment } from './chatService';

// ── In-memory onboarding store ──────────────────────────────────────────────
export interface OnboardingState {
  phone: string;              // E.164 — the identity
  phoneTicket: string;        // proof the number was SMS-OTP-verified
  otpResendInSec: number;     // server's cooldown, handed to the OTP screen
  email: string;              // OPTIONAL recovery address, collected on the profile step
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
    phone: '', phoneTicket: '', otpResendInSec: 0, email: '', firstName: '', lastName: '',
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

// ── Backend calls (error envelope { error: { code, message } }) ──────────────
/**
 * A THROTTLED SIGN-IN MUST SAY SO, AND SAY FOR HOW LONG.
 *
 * OTP sends are capped per number per hour, and both 429 shapes carry the wait:
 * `retryAfter` seconds at the top level, or
 * inside `error`. Neither was ever read. So the landing screen showed a bare
 * "Too many requests. Try again later." with no duration and no cause — and the
 * one thing a person does with that message is press the button again, which
 * spends another of the three and pushes the reset further out.
 *
 * That is how somebody ends up locked out for an hour having never once reached
 * the code-entry screen: `sendPhoneOtp` throws, so the `router.push` after it in
 * app/onboard.tsx never runs, and the alert gives no reason to stop tapping.
 *
 * Naming the minutes is the whole fix — it converts "broken" into "wait". The
 * copy used to end by offering Google sign-in as the way in; there is no such
 * way in any more, and pointing at a door that does not exist is worse than
 * saying nothing. The OTP screen turns the same seconds into a live countdown.
 */
function msg(e: any, fallback: string): string {
  const base = e?.body?.error?.message || e?.message || fallback;
  if (e?.status !== 429 && e?.status !== 423) return base;

  const secs = retryAfterSec(e);
  if (!secs) return `${base}\n\nToo many attempts. Wait a little before asking for another code.`;

  const mins = Math.ceil(secs / 60);
  const wait = mins >= 60
    ? `${Math.ceil(mins / 60)} hour${Math.ceil(mins / 60) === 1 ? '' : 's'}`
    : `${mins} minute${mins === 1 ? '' : 's'}`;
  return `Too many attempts. Try again in about ${wait}.\n\nAsking again before then only extends the wait.`;
}

/** Seconds the server says to wait, off a 429/423 envelope; 0 when it did not say. */
export function retryAfterSec(e: any): number {
  const s = Number(e?.body?.retryAfter ?? e?.body?.error?.retryAfter ?? 0);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

export type OtpChannel = 'sms' | 'voice' | 'whatsapp';

// The send calls return the server's resend cooldown so the OTP screen counts
// down the REAL number instead of guessing 30s — guessing is how the button
// goes live early and spends one of the few allowed sends on a certain 429.
const FALLBACK_RESEND_SEC = 30;

export async function sendPhoneOtp(phone: string): Promise<number> {
  const r = await api<{ ok: true; resendInSec?: number }>('/auth/onboard/send-otp-phone', {
    method: 'POST', json: { phone }, auth: false,
  });
  return r.resendInSec ?? FALLBACK_RESEND_SEC;
}

export async function resendPhoneOtp(phone: string, channel: OtpChannel = 'sms'): Promise<number> {
  const r = await api<{ ok: true; resendInSec?: number }>('/auth/onboard/resend-otp-phone', {
    method: 'POST', json: { phone, channel }, auth: false,
  });
  return r.resendInSec ?? FALLBACK_RESEND_SEC;
}

export async function verifyPhoneOtp(phone: string, code: string): Promise<string> {
  const r = await api<{ ok: true; phoneTicket: string }>('/auth/onboard/verify-otp-phone', {
    method: 'POST', json: { phone, code }, auth: false,
  });
  return r.phoneTicket;
}

// Email is OMITTED rather than sent empty when there isn't one: '' is not "no
// address" to a uniqueness check, and every account would collide on it.
export async function lookupUser(phone: string, email?: string): Promise<{ exists: boolean; userId?: string; conflict?: 'phone' | 'email' }> {
  return api('/auth/lookup', { method: 'POST', json: email ? { phone, email } : { phone }, auth: false });
}

// Returns the new userId AND a short-lived setup ticket bound to it. The two
// calls that follow write credentials but cannot send a JWT — there is no
// session until the MPIN exists — so the ticket is what proves to the server
// that this client is the one that just passed the SMS OTP. Carry it to both
// of them; without it they now 401.
export async function initProfile(input: {
  phone: string; phoneTicket: string; email?: string;
  firstName: string; lastName: string; dob: string; status: string; profilePicUrl?: string | null;
}): Promise<{ userId: string; setupTicket: string }> {
  const r = await api<{ userId: string; setupTicket: string }>('/auth/profile/init', { method: 'POST', json: input, auth: false });
  return { userId: r.userId, setupTicket: r.setupTicket };
}

export async function saveSecurityQuestions(userId: string, setupTicket: string, answers: { questionCode: string; answer: string }[]): Promise<void> {
  await api('/auth/security-questions/save', { method: 'POST', json: { userId, setupTicket, answers }, auth: false });
}

export async function setMpinRemote(userId: string, setupTicket: string, mpin: string): Promise<void> {
  await api('/auth/mpin/set', { method: 'POST', json: { userId, setupTicket, mpin }, auth: false });
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
  const up = await uploadAttachment(tmp, 'avatar.enc', 'application/octet-stream', { purpose: 'profile' });
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
