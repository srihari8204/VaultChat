// crazzychat auth service — Phase 2.
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
import { lockSession } from '../../lib/sessionLock';
import * as pinStore from '../../services/security/pinStore';

// Web Client ID from Firebase Console → Auth → Sign-in method → Google.
// (Google Sign-In SDK still talks to Google's OAuth — the resulting
//  idToken gets exchanged for OUR JWT via the backend /auth/google route.)
// Web OAuth client (type 3) from google-services.json of the FINAL project
// vaultchatprod01. It MUST match the project in google-services.json — a client
// id from a different project makes GoogleSignin.signIn() throw DEVELOPER_ERROR
// (the account picker "throws an error"). Was the old vaultchat-ce9e3 client.
const WEB_CLIENT_ID = '553821750020-2v6ul3cu0tr4o76uvtabjubgnbk2m40u.apps.googleusercontent.com';

// ─── Google Sign-In configuration ─────────────────────────────
//
// CALLED BY EVERY ENTRY POINT THAT TOUCHES THE SDK, not once at boot.
//
// app/_layout.tsx used to call this inside the root mount effect, which put
// @react-native-google-signin on the cold-start path for every user including
// the ones who never sign in with Google. Configure is a cheap synchronous
// native call, so each caller asserting it costs nothing and removes the
// ordering assumption entirely.
//
// Repeating it is also the CORRECT thing here: lib/googleDrive.ts configures
// the same global client with the Drive appdata scope, so after a Drive backup
// a single boot-time configuration had already been overwritten.
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
  configureGoogleSignIn();
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
  // signOut() needs a configured client too — on Android it resolves the
  // GoogleSignInClient that configure() built. This is reached from logoutUser,
  // which can run on a session that never opened a sign-in screen.
  try { configureGoogleSignIn(); } catch {}
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

// ─── Phone OTP (Day 17) ─────────────────────────────────────
// Same shape as email OTP. The backend either issues tokens (signup) or
// stamps the verified phone onto the currently-authenticated user (link).
export async function sendPhoneOTP(phone: string): Promise<{ dev?: boolean }> {
  const p = (phone ?? '').trim();
  if (!p) throw new Error('Enter a phone number');
  return api<{ ok: true; dev?: boolean }>('/auth/send-otp-phone', {
    method: 'POST',
    json: { phone: p },
    auth: false,
  });
}

export async function verifyPhoneOTP(
  phone: string,
  code: string,
  opts: { link?: boolean; name?: string } = {},
): Promise<{ isNewUser?: boolean; linked?: boolean; user?: any }> {
  const p = (phone ?? '').trim();
  if (!/^\d{6}$/.test(code ?? '')) throw new Error('OTP must be 6 digits');

  // When `link` is true, the call is authenticated so the backend stamps
  // the phone onto the existing user. Otherwise it's signup-by-phone.
  const r = await api<{
    accessToken?: string; refreshToken?: string;
    user?: any; isNewUser?: boolean; linked?: boolean;
  }>('/auth/verify-otp-phone', {
    method: 'POST',
    json: { phone: p, otp: code, name: opts.name?.trim() || undefined },
    auth: !!opts.link,
  });
  if (r.accessToken && r.refreshToken) {
    await setTokens(r.accessToken, r.refreshToken);
  }
  if (r.user) await setCachedUser(r.user);
  return { isNewUser: r.isNewUser, linked: r.linked, user: r.user };
}

// ─── Signup pending data (multi-step UI) ─────────────────────
export interface SignupData {
  name: string; dob: string; email: string; mobile: string;
  securityQ1: string; securityA1: string;
  securityQ2: string; securityA2: string;
}

// SecureStore, not AsyncStorage. securityA1/A2 are ACCOUNT-RECOVERY CREDENTIALS
// — answering them is how someone proves they are you — and they were being
// written to AsyncStorage, which is an unencrypted SQLite file in the app
// sandbox. They also survive an abandoned signup: the key is only cleared on
// success, so a user who quit at the OTP step left their answers on disk
// indefinitely.
//
// The whole blob moves rather than just the answers: the name/dob/email/mobile
// beside them are the exact fields a recovery flow asks to corroborate, so
// splitting the record would protect the answer and leak the check.
const PENDING_SIGNUP_KEY = 'vc_pending_signup';

export async function savePendingSignup(d: SignupData) {
  await SecureStore.setItemAsync(PENDING_SIGNUP_KEY, JSON.stringify(d));
}

export async function getPendingSignup(): Promise<SignupData | null> {
  try {
    const r = await SecureStore.getItemAsync(PENDING_SIGNUP_KEY);
    if (r) return JSON.parse(r);
  } catch {}
  // Migration: an install that started signup on an older build still has the
  // cleartext copy. Read it once, re-seal it, and delete the plaintext.
  try {
    const legacy = await AsyncStorage.getItem(PENDING_SIGNUP_KEY);
    if (!legacy) return null;
    await SecureStore.setItemAsync(PENDING_SIGNUP_KEY, legacy).catch(() => {});
    await AsyncStorage.removeItem(PENDING_SIGNUP_KEY).catch(() => {});
    return JSON.parse(legacy);
  } catch { return null; }
}

export async function clearPendingSignup() {
  await SecureStore.deleteItemAsync(PENDING_SIGNUP_KEY).catch(() => {});
  // Clear the legacy key too, even on installs that never read it back —
  // otherwise an abandoned signup keeps its answers in the clear forever.
  await AsyncStorage.removeItem(PENDING_SIGNUP_KEY).catch(() => {});
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

// ─── PIN (one store: services/security/pinStore) ─────────────
// Was an unsalted SHA-256 under 'vc_pin_hash' — a 4-8 digit PIN is ~10^8
// candidates, so that hash was a formality. pinStore derives with scrypt over a
// per-install salt (the same KDF the vault headers use) and migrates the old
// value on the next successful unlock.

export async function savePIN(pin: string) {
  await pinStore.setPin(pin);              // validates 4-8 digits
  // Best-effort backend save so the user can verify their PIN from a new device
  // (POST /user/pin bcrypts it server-side). Note this is the one moment the PIN
  // leaves the device — drop this call if that trade isn't wanted.
  try { await api('/user/pin', { method: 'POST', json: { pin } }); } catch {}
}

export async function verifyPIN(pin: string): Promise<boolean> {
  return pinStore.verifyPin(pin);
}

export async function hasPIN(): Promise<boolean> {
  return pinStore.hasPin();
}

// ─── Face enrollment (local-only) ────────────────────────────
// The stored value is a path to a photo of the user's face, used as an
// authentication factor. A path is not the image, but it is a direct pointer to
// it, and in AsyncStorage it sat in the clear alongside everything else — so
// anything that could read the app's unencrypted store learned exactly where
// the biometric samples live. SecureStore is where the other authentication
// material (the PIN record, tokens) already is.
const faceKey = (i: number) => 'vc_face_' + i;

export async function enrollFace(uri: string, index: number) {
  if (index < 0 || index > 2) throw new Error('Face index must be 0-2');
  if (!uri) throw new Error('Face URI required');
  await SecureStore.setItemAsync(faceKey(index), uri);
  // Drop any cleartext copy this slot had from an older build.
  await AsyncStorage.removeItem(faceKey(index)).catch(() => {});
}

/** Sealed value, falling back to a legacy cleartext one and upgrading it. */
async function readFace(i: number): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(faceKey(i));
    if (v) return v;
  } catch {}
  try {
    const legacy = await AsyncStorage.getItem(faceKey(i));
    if (!legacy) return null;
    await SecureStore.setItemAsync(faceKey(i), legacy).catch(() => {});
    await AsyncStorage.removeItem(faceKey(i)).catch(() => {});
    return legacy;
  } catch { return null; }
}

export async function getEnrolledFaceCount(): Promise<number> {
  let c = 0;
  for (let i = 0; i < 3; i++) {
    if (await readFace(i)) c++;
  }
  return c;
}

export async function hasFaceEnrolled(): Promise<boolean> {
  try { return !!(await readFace(0)); } catch { return false; }
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
//
// Signing out clears this account's DATA, not just its credentials. It used to
// drop only tokens, the PIN hash and face templates, which left the previous
// user's cached messages, photos, videos, documents and full encrypted chat
// backups on disk for whoever signed in next (audit F-6).
//
// Both confirmation dialogs (profile "Sign out", settings "Delete account") say
// that on-device chats and media are removed, so this is not a surprise.
export async function logoutUser() {
  lockSession();
  try { await signOutGoogle(); } catch {}
  try {
    const refreshToken = await SecureStore.getItemAsync('vc_refresh_token');
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', json: { refreshToken }, auth: false });
    }
  } catch {}
  await clearTokens();
  await setCachedUser(null);
  // Clear cache on logout when the user enabled that setting (cache only — the
  // user-content purge below handles saved data). Read before the vc_cache_*
  // keys are removed further down. Best-effort.
  try { await require('../../services/cache/cacheManager').clearCacheOnLogout(); } catch {}
  // TURN credentials are minted per user id ("<expiry>:<uid>"), so they must not
  // survive into the next account signed in on this device.
  try { require('../../lib/iceConfig').invalidateIceCache(); } catch {}
  for (let i = 0; i < 3; i++) {
    // Both stores: the sealed value and any legacy cleartext copy.
    await SecureStore.deleteItemAsync(faceKey(i)).catch(() => {});
    await AsyncStorage.removeItem(faceKey(i)).catch(() => {});
  }
  await pinStore.clearPin().catch(() => {});   // v1 record + both legacy keys
  await clearPendingSignup().catch(() => {});   // sealed record + legacy plaintext

  // Cached chats/messages + the sealed cache DEK.
  try { await require('../../lib/localDb').clearLocalDb(); } catch {}

  // Every on-disk user-content root: media, thumbnails, local .vcbak backups,
  // note attachments, completed VaultBeam transfers. Enumerated from the single
  // storage-roots authority so a newly added root can't be missed here.
  try { await require('../../lib/storageRoots').purgeUserContent(); } catch {}
  // S2: purgeUserContent deliberately skips the CACHE dir (storageRoots.ts says
  // so in its own comment), and document plaintext staged for a viewer or an
  // external hand-off lives exactly there. So signing out left every document
  // this account had opened readable on disk for whoever signs in next.
  // Sweeps only dc_ document staging plus the vo_/vv_ protected-media temps —
  // never the cache at large, which is not ours to clear.
  try {
    const gc = require('../../lib/mediaCacheGC');
    await gc.purgeDocumentCache();
    await gc.purgeEphemeralMedia();
  } catch {}

  // Per-attachment media keys and the local revoke list are scoped to the
  // account that received them; the files they unlock are gone above.
  try {
    const keys = await AsyncStorage.getAllKeys();
    // vc_restore_prompted is the ONE-SHOT gate on the "Restore your chats?"
    // offer. Logout wipes the local message cache, and E2EE means the server's
    // ciphertext cannot be re-decrypted afterwards — the ratchet has already
    // destroyed those message keys. So the backup restore is the only route
    // back to that history, and leaving this flag set suppressed the offer at
    // exactly the moment it mattered: the user logged in again to an empty app
    // and was never asked.
    const scoped = keys.filter(k => k.startsWith('vc_mk_') || k.startsWith('vc_cache_')
      || k === 'vc_revoked_media' || k === 'vc_restore_prompted');
    if (scoped.length) await AsyncStorage.multiRemove(scoped);
  } catch {}
}

// ✅ Required by expo-router to suppress "no default export" route warning
export default {};
