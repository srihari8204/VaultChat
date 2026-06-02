// VaultChat auth service — Phase 2.
//
// Backed by the custom Postgres + JWT backend (Phase 1).
// NO Firebase Auth — sign-in produces a JWT stored in SecureStore.
//
// Firestore-dependent screens elsewhere in the app will be dark until
// Phases 4-7 migrate them to Postgres-backed routes.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import {
  api,
  clearTokens,
  getAccessToken,
  getCachedUser,
  setCachedUser,
  setTokens,
} from '../../lib/api';

// Web Client ID from Firebase Console → Auth → Sign-in method → Google.
// (Google Sign-In SDK still talks to Google's OAuth — the resulting
//  idToken gets exchanged for OUR JWT via the backend /auth/google route.)
const WEB_CLIENT_ID = '207307621485-53m82dlcolfctpfagjnddnsq1euvvmpe.apps.googleusercontent.com';

// ─── Google Sign-In configuration ─────────────────────────────
export function configureGoogleSignIn() {
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    offlineAccess: true,
  });
}

// ─── Sign in flows ────────────────────────────────────────────

/**
 * Sign in with Google. Hits /auth/google with the idToken from the
 * Google Sign-In SDK. Backend mints our JWT, we store it.
 */
export async function signInWithGoogle(): Promise<{
  isNewUser: boolean;
  user: any;
  displayName: string;
  email: string;
  photoURL: string | null;
}> {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  let signInResult: any;
  try {
    signInResult = await GoogleSignin.signIn();
  } catch (error: any) {
    if (error?.code === statusCodes.SIGN_IN_CANCELLED) throw new Error('Google sign-in was cancelled');
    if (error?.code === statusCodes.IN_PROGRESS) throw new Error('Google sign-in already in progress');
    if (error?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) throw new Error('Google Play Services not available');
    throw new Error(error?.message ?? 'Google sign-in failed');
  }
  const idToken = signInResult?.data?.idToken;
  if (!idToken) throw new Error('Failed to get Google ID token');

  const r = await api<{
    accessToken: string; refreshToken: string; user: any; isNewUser: boolean;
  }>('/auth/google', { method: 'POST', json: { idToken }, auth: false });

  await setTokens(r.accessToken, r.refreshToken);
  await setCachedUser(r.user);

  return {
    isNewUser: r.isNewUser,
    user: r.user,
    displayName: r.user?.name ?? '',
    email: r.user?.email ?? '',
    photoURL: r.user?.photoURL ?? null,
  };
}

export async function signOutGoogle(): Promise<void> {
  try { await GoogleSignin.signOut(); } catch {}
}

// ─── Email OTP ────────────────────────────────────────────────
// (Server emits the OTP via Nodemailer — needs EMAIL_PASS set on
//  the backend, otherwise /auth/send-otp returns 500.)

export async function sendOTP(email: string): Promise<void> {
  const e = (email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error('Enter a valid email address');
  }
  await api('/auth/send-otp', { method: 'POST', json: { email: e }, auth: false });
}

/**
 * Verify OTP. `name` only matters on first sign-up (backend ignores it
 * for existing accounts). Returns { isNewUser } so the caller can route
 * to profile-setup vs straight to chats.
 */
export async function verifyOTP(
  email: string,
  code: string,
  name?: string,
): Promise<{ isNewUser: boolean; user: any }> {
  const e = (email ?? '').trim().toLowerCase();
  if (!/^\d{6}$/.test(code ?? '')) throw new Error('OTP must be 6 digits');

  const r = await api<{
    accessToken: string; refreshToken: string; user: any; isNewUser: boolean;
  }>('/auth/verify-otp', {
    method: 'POST',
    json: { email: e, otp: code, name: name?.trim() || undefined },
    auth: false,
  });

  await setTokens(r.accessToken, r.refreshToken);
  await setCachedUser(r.user);
  return { isNewUser: r.isNewUser, user: r.user };
}

// Old phone-flow state machine is gone. Stub kept so existing imports compile.
export function clearOTPState() {}

// ─── Signup pending data (multi-step UI) ─────────────────────
export interface SignupData {
  name: string; dob: string; email: string; mobile: string;
  securityQ1: string; securityA1: string;
  securityQ2: string; securityA2: string;
}

export async function savePendingSignup(d: SignupData) {
  await AsyncStorage.setItem('vc_pending_signup', JSON.stringify(d));
}

export async function getPendingSignup(): Promise<SignupData | null> {
  const r = await AsyncStorage.getItem('vc_pending_signup');
  return r ? JSON.parse(r) : null;
}

export async function clearPendingSignup() {
  await AsyncStorage.removeItem('vc_pending_signup').catch(() => {});
}

/**
 * Push profile fields to the backend after OTP verify.
 * Called from the OTP screen on successful signup.
 */
export async function saveUserProfile(d: SignupData) {
  // DOB in the UI is "DD/Month/YYYY" — backend wants YYYY-MM-DD or omit.
  let dobIso: string | undefined;
  if (d.dob) {
    const m = d.dob.match(/^(\d{1,2})\/([A-Za-z]+|\d{1,2})\/(\d{4})$/);
    if (m) {
      const day = m[1].padStart(2, '0');
      const monthRaw = m[2];
      const year = m[3];
      const monthIdx = /^\d+$/.test(monthRaw)
        ? parseInt(monthRaw, 10) - 1
        : ['January','February','March','April','May','June','July','August','September','October','November','December']
            .findIndex(n => n.toLowerCase() === monthRaw.toLowerCase());
      if (monthIdx >= 0) {
        dobIso = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${day}`;
      }
    }
  }
  await api('/user/profile', {
    method: 'PUT',
    json: {
      name:        d.name?.trim(),
      phone:       d.mobile?.trim() || undefined,
      dob:         dobIso,
      securityQ1:  d.securityQ1 || undefined,
      securityA1:  d.securityA1 || undefined,
      securityQ2:  d.securityQ2 || undefined,
      securityA2:  d.securityA2 || undefined,
    },
  });
}

// ─── PIN (local hash + best-effort backend sync) ─────────────
async function sha256(s: string): Promise<string> {
  if (!s) throw new Error('Cannot hash empty string');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);
}

export async function savePIN(pin: string) {
  if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
    throw new Error('PIN must be 4-8 digits');
  }
  const hash = await sha256(pin);
  await SecureStore.setItemAsync('vc_pin_hash', hash);
  // Best-effort backend save so the user can verify PIN from any device later.
  try { await api('/user/pin', { method: 'POST', json: { pin } }); } catch {}
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync('vc_pin_hash');
  if (!stored) return false;
  const hash = await sha256(pin);
  return hash === stored;
}

export async function hasPIN(): Promise<boolean> {
  try { return !!(await SecureStore.getItemAsync('vc_pin_hash')); } catch { return false; }
}

// ─── Face enrollment (local-only, unchanged) ─────────────────
export async function enrollFace(uri: string, index: number) {
  if (index < 0 || index > 2) throw new Error('Face index must be 0-2');
  if (!uri) throw new Error('Face URI required');
  await AsyncStorage.setItem('vc_face_' + index, uri);
}

export async function getEnrolledFaceCount(): Promise<number> {
  let c = 0;
  for (let i = 0; i < 3; i++) {
    if (await AsyncStorage.getItem('vc_face_' + i)) c++;
  }
  return c;
}

export async function hasFaceEnrolled(): Promise<boolean> {
  try { return !!(await AsyncStorage.getItem('vc_face_0')); } catch { return false; }
}

// ─── Current user / setup state ──────────────────────────────
// The JWT model is fundamentally async (SecureStore I/O), so the old
// synchronous `getCurrentUser()` callers will need to migrate to the
// async version when their screens get touched in later phases. For now
// the sync version returns null so the legacy callers don't crash.

export function getCurrentUser(): any | null {
  return null;
}

export async function getCurrentUserAsync(): Promise<any | null> {
  return getCachedUser();
}

/**
 * Listen to auth state changes. The JWT model doesn't have a real
 * subscription — emit the current cached user once and return a no-op
 * unsubscribe. Screens that need reactive updates should re-fetch on
 * focus or use a custom event bus.
 */
export async function onAuthChange(cb: (u: any) => void): Promise<() => void> {
  cb(await getCachedUser());
  return () => {};
}

export async function isSetupComplete(): Promise<boolean> {
  const t = await getAccessToken();
  if (!t) return false;
  try {
    const u: any = await api('/user/profile');
    return !!u?.id;
  } catch {
    return false;
  }
}

// ─── Logout ─────────────────────────────────────────────────
export async function logoutUser() {
  try { await signOutGoogle(); } catch {}
  try {
    const refreshToken = await SecureStore.getItemAsync('vc_refresh_token');
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', json: { refreshToken }, auth: false });
    }
  } catch {}
  await clearTokens();
  await setCachedUser(null);
  for (let i = 0; i < 3; i++) {
    await AsyncStorage.removeItem('vc_face_' + i).catch(() => {});
  }
  await SecureStore.deleteItemAsync('vc_pin_hash').catch(() => {});
  await AsyncStorage.removeItem('vc_pending_signup').catch(() => {});
}

// ✅ Required by expo-router to suppress "no default export" route warning
export default {};
