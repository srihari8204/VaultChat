// lib/onboarding.ts — client for the encrypted onboarding backend + a tiny
// in-memory store carried across the auth screens.
//
// The store holds onboarding-in-progress data (email, phone, names, dob, status,
// answers, mpin). It is RAM-only and MUST be cleared on success — plaintext MPIN
// and answers never touch disk. (The app has no Zustand; this module singleton
// fills the same role the spec's useOnboardingStore would.)

import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { api, setTokens, setCachedUser } from './api';

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
  const u = res?.data?.user ?? {};
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

export async function lookupUser(email: string, phone: string): Promise<{ exists: boolean; userId?: string }> {
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

export { msg as onboardingError };
