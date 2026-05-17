import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApp } from "@react-native-firebase/app";
import { getAuth, GoogleAuthProvider, RecaptchaVerifier, signInWithCredential, signInWithPhoneNumber } from "@react-native-firebase/auth";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "@react-native-firebase/firestore";
import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const app  = getApp();
const auth = getAuth(app);
const db   = getFirestore(app);

// Web reCAPTCHA verifier (needed for phone auth on web)
let webRecaptchaVerifier: any = null;

// ─── Google Sign-In Configuration ─────────────────────────────
// Configure Google Sign-In (call once on app start)
export function configureGoogleSignIn() {
  GoogleSignin.configure({
    // Web Client ID from Firebase Console → Authentication → Sign-in method → Google
    // Go to: https://console.firebase.google.com → your project → Authentication → Sign-in method → Google → Web client ID
    webClientId: '207307621485-53m82dlcolfctpfagjnddnsq1euvvmpe.apps.googleusercontent.com',
    offlineAccess: true,
  });
}

/**
 * Sign in with Google — no OTP required
 * Returns { isNewUser, user } so caller can decide navigation
 */
export async function signInWithGoogle(): Promise<{
  isNewUser: boolean;
  user: any;
  displayName: string;
  email: string;
  photoURL: string | null;
}> {
  try {
    // Check Play Services availability
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

    // Trigger Google Sign-In UI
    const signInResult = await GoogleSignin.signIn();

    // Get the ID token
    const idToken = signInResult?.data?.idToken;
    if (!idToken) {
      throw new Error('Failed to get Google ID token');
    }

    // Create Firebase credential from Google token
    const googleCredential = GoogleAuthProvider.credential(idToken);

    // Sign in to Firebase with the Google credential
    const firebaseResult = await signInWithCredential(auth, googleCredential);
    const user = firebaseResult.user;

    // Check if user profile exists in Firestore
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const isNewUser = !userDoc.exists();

    // If new user, create a basic profile in Firestore
    if (isNewUser) {
      const phoneHash = user.phoneNumber
        ? await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, user.phoneNumber)
        : '';

      await setDoc(doc(db, "users", user.uid), {
        name: user.displayName ?? '',
        email: user.email ?? '',
        mobile: user.phoneNumber ?? '',
        phoneHash,
        photoURL: user.photoURL ?? '',
        authProvider: 'google',
        faceCount: 0,
        createdAt: serverTimestamp(),
      });
    }

    return {
      isNewUser,
      user,
      displayName: user.displayName ?? '',
      email: user.email ?? '',
      photoURL: user.photoURL ?? null,
    };
  } catch (error: any) {
    if (error?.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new Error('Google sign-in was cancelled');
    }
    if (error?.code === statusCodes.IN_PROGRESS) {
      throw new Error('Google sign-in already in progress');
    }
    if (error?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new Error('Google Play Services not available');
    }
    throw new Error(error?.message ?? 'Google sign-in failed');
  }
}

/**
 * Sign out from Google
 */
export async function signOutGoogle(): Promise<void> {
  try {
    await GoogleSignin.signOut();
  } catch {}
}

export interface SignupData {
  name: string; dob: string; email: string; mobile: string;
  securityQ1: string; securityA1: string;
  securityQ2: string; securityA2: string;
}

// ─── Configuration ──────────────────────────────────────────────
// Set to true for dev/web testing — OTP will be "123456" and no SMS sent
const IS_TEST_MODE = Platform.OS === 'web'; // Auto-enable test mode on web
const TEST_OTP = "123456";
const MAX_OTP_ATTEMPTS = 5;
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const RETRY_DELAY_MS = 1000; // 1 second initial delay for exponential backoff

// ─── State Management ────────────────────────────────────────────
interface OTPState {
  confirmationResult: any;
  phone: string;
  timestamp: number;
  attempts: number;
  testMode: boolean;
}

let otpState: OTPState | null = null;

// ────────────────────────────────────────────────────────────────

/**
 * Send OTP to phone number
 * @param phone - Phone number with country code (e.g., "+1234567890")
 * @throws {Error} If Firebase not initialized or phone number invalid
 */
export async function sendOTP(phone: string) {
  try {
    // Validate phone format
    if (!phone || !phone.match(/^\+\d{10,15}$/)) {
      throw new Error("Invalid phone number. Use format: +1234567890");
    }


    // Test mode for development
    if (IS_TEST_MODE) {
      otpState = {
        confirmationResult: null,
        phone,
        timestamp: Date.now(),
        attempts: 0,
        testMode: true,
      };
      return;
    }

    // Production: Use Firebase Phone Authentication
    if (!auth) throw new Error("Firebase Auth not initialized");

    let confirmationResult;

    if (Platform.OS === 'web') {
      // Web requires RecaptchaVerifier for phone auth
      // Create invisible reCAPTCHA on a container div
      try {
        // Clean up previous verifier if exists
        if (webRecaptchaVerifier) {
          try { webRecaptchaVerifier.clear(); } catch {}
        }

        // Ensure container div exists
        let container = document.getElementById('recaptcha-container');
        if (!container) {
          container = document.createElement('div');
          container.id = 'recaptcha-container';
          document.body.appendChild(container);
        }

        webRecaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
          size: 'invisible',
          callback: () => {
            // reCAPTCHA solved — will proceed with signInWithPhoneNumber
          },
        });

        confirmationResult = await signInWithPhoneNumber(auth, phone, webRecaptchaVerifier);
      } catch (webErr: any) {
        // If RecaptchaVerifier fails (e.g. import issue), try without it
        console.warn('RecaptchaVerifier failed, trying direct:', webErr.message);
        confirmationResult = await signInWithPhoneNumber(auth, phone);
      }
    } else {
      // Native (iOS/Android) — reCAPTCHA is handled automatically
      confirmationResult = await signInWithPhoneNumber(auth, phone);
    }

    otpState = {
      confirmationResult,
      phone,
      timestamp: Date.now(),
      attempts: 0,
      testMode: false,
    };

  } catch (error: any) {
    throw new Error(
      error?.message?.includes("too-many-requests")
        ? "Too many attempts. Please try again later."
        : error?.message || "Failed to send OTP"
    );
  }
}

/**
 * Verify OTP code
 * @param code - 6-digit OTP code
 * @returns {boolean} True if verification successful
 * @throws {Error} If OTP invalid, expired, or no pending OTP
 */
export async function verifyOTP(code: string): Promise<boolean> {
  try {
    // Validate input
    if (!code || !code.match(/^\d{6}$/)) {
      throw new Error("OTP must be 6 digits");
    }

    if (!otpState) {
      throw new Error("No pending OTP. Please request a new one.");
    }

    // Check expiry (10 minutes)
    if (Date.now() - otpState.timestamp > OTP_EXPIRY_MS) {
      otpState = null;
      throw new Error("OTP expired. Please request a new one.");
    }

    // Check max attempts
    if (otpState.attempts >= MAX_OTP_ATTEMPTS) {
      otpState = null;
      throw new Error(`Too many attempts. Please request a new OTP.`);
    }

    otpState.attempts++;

    // Test mode verification
    if (otpState.testMode) {
      if (code === TEST_OTP) {
        // In test mode, sign in anonymously so auth().currentUser is set
        // This allows subsequent Firestore queries to work
        if (!auth.currentUser) {
          try {
            const { signInAnonymously } = await import('@react-native-firebase/auth');
            await signInAnonymously(auth);
          } catch (e: any) {
            console.warn('Test mode: anonymous sign-in failed, trying without auth:', e.message);
          }
        }
        otpState = null;
        return true;
      } else {
        throw new Error(`Invalid OTP. Test OTP is ${TEST_OTP}`);
      }
    }

    // Production verification
    if (!otpState.confirmationResult) {
      throw new Error("No confirmation pending. Please request OTP again.");
    }

    const result = await otpState.confirmationResult.confirm(code);
    
    if (!result?.user) {
      throw new Error("Verification failed. User not created.");
    }

    otpState = null;
    return true;
  } catch (error: any) {
    throw new Error(
      error?.message?.includes("invalid-verification-code")
        ? "Invalid OTP. Please try again."
        : error?.message || "OTP verification failed"
    );
  }
}

/**
 * Clear any pending OTP state (e.g., when user cancels)
 */
export function clearOTPState() {
  otpState = null;
}


async function sha256(s: string): Promise<string> {
  if (!s) throw new Error("Cannot hash empty string");
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);
}

/**
 * Save PIN securely to device storage
 * @param pin - User's 4-6 digit PIN
 */
export async function savePIN(pin: string) {
  try {
    if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
      throw new Error("PIN must be 4-6 digits");
    }
    const hash = await sha256(pin);
    await SecureStore.setItemAsync("vc_pin_hash", hash);
  } catch (error: any) {
    throw new Error(error?.message || "Failed to save PIN");
  }
}

/**
 * Verify PIN against stored hash
 * @param pin - User-entered PIN
 * @returns {boolean} True if PIN matches
 */
export async function verifyPIN(pin: string): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync("vc_pin_hash");
    if (!stored) return false;
    const hash = await sha256(pin);
    return hash === stored;
  } catch (error: any) {
    return false;
  }
}

/**
 * Check if PIN is set
 */
export async function hasPIN(): Promise<boolean> {
  try {
    return !!(await SecureStore.getItemAsync("vc_pin_hash"));
  } catch {
    return false;
  }
}

/**
 * Save pending signup data to AsyncStorage
 * Used for multi-step signup flows
 */
export async function savePendingSignup(d: SignupData) {
  try {
    validateSignupData(d);
    await AsyncStorage.setItem("vc_pending_signup", JSON.stringify(d));
  } catch (error: any) {
    throw new Error(error?.message || "Failed to save signup data");
  }
}

/**
 * Retrieve pending signup data
 */
export async function getPendingSignup(): Promise<SignupData | null> {
  try {
    const r = await AsyncStorage.getItem("vc_pending_signup");
    return r ? JSON.parse(r) : null;
  } catch (error: any) {
    return null;
  }
}

/**
 * Clear pending signup data
 */
export async function clearPendingSignup() {
  try {
    await AsyncStorage.removeItem("vc_pending_signup");
  } catch (error: any) {
  }
}

/**
 * Validate signup data
 */
function validateSignupData(d: SignupData) {
  if (!d.name?.trim()) throw new Error("Name required");
  if (!d.dob) throw new Error("Date of birth required");
  if (!d.email?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) throw new Error("Invalid email");
  if (!d.mobile?.match(/^\+?\d{10,15}$/)) throw new Error("Invalid phone number");
  if (!d.securityQ1 || !d.securityA1) throw new Error("Security question 1 required");
  if (!d.securityQ2 || !d.securityA2) throw new Error("Security question 2 required");
}

/**
 * Save user profile to Firestore
 * Called after successful OTP verification
 */
export async function saveUserProfile(d: SignupData) {
  try {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error("User not authenticated. Complete OTP verification first.");

    validateSignupData(d);

    // Hash phone for privacy-safe contact matching
    const phoneHash = await sha256(d.mobile);
    
    const userData = {
      name:       d.name.trim(),
      dob:        d.dob,
      email:      d.email.trim().toLowerCase(),
      mobile:     d.mobile,
      phoneHash:  phoneHash,
      securityQ1: d.securityQ1,
      securityA1: await sha256(d.securityA1.toLowerCase().trim()),
      securityQ2: d.securityQ2,
      securityA2: await sha256(d.securityA2.toLowerCase().trim()),
      faceCount:  0,
      createdAt:  serverTimestamp(),
    };

    await setDoc(doc(db, "users", uid), userData);
  } catch (error: any) {
    throw new Error(error?.message || "Failed to save user profile");
  }
}

/**
 * Check if user setup is complete
 */
export async function isSetupComplete(): Promise<boolean> {
  try {
    const uid = auth.currentUser?.uid;
    if (!uid) return false;
    const doc_ref = doc(db, "users", uid);
    const docSnap = await getDoc(doc_ref);
    return docSnap.exists();
  } catch (error: any) {
    return false;
  }
}

/**
 * Enroll face for biometric authentication
 * @param uri - Face image URI from camera
 * @param index - Face index (0-2 for up to 3 faces)
 */
export async function enrollFace(uri: string, index: number) {
  try {
    if (index < 0 || index > 2) throw new Error("Face index must be 0-2");
    if (!uri) throw new Error("Face URI required");
    await AsyncStorage.setItem("vc_face_" + index, uri);
  } catch (error: any) {
    throw new Error(error?.message || "Failed to enroll face");
  }
}

/**
 * Get count of enrolled faces
 */
export async function getEnrolledFaceCount(): Promise<number> {
  try {
    let c = 0;
    for (let i = 0; i < 3; i++) {
      if (await AsyncStorage.getItem("vc_face_" + i)) c++;
    }
    return c;
  } catch (error: any) {
    return 0;
  }
}

/**
 * Check if any face is enrolled
 */
export async function hasFaceEnrolled(): Promise<boolean> {
  try {
    return !!(await AsyncStorage.getItem("vc_face_0"));
  } catch {
    return false;
  }
}

/**
 * Get current authenticated user
 */
export function getCurrentUser() {
  return auth.currentUser;
}

/**
 * Listen to authentication state changes
 * @param cb - Callback with user object
 * @returns Unsubscribe function
 */
export function onAuthChange(cb: (u: any) => void) {
  return auth.onAuthStateChanged(cb);
}

/**
 * Logout user and clear all local data
 */
export async function logoutUser() {
  try {
    // Sign out from Google if signed in
    await signOutGoogle();

    await auth.signOut();

    // Clear enrolled faces
    for (let i = 0; i < 3; i++) {
      await AsyncStorage.removeItem("vc_face_" + i).catch(() => {});
    }

    // Clear PIN
    await SecureStore.deleteItemAsync("vc_pin_hash").catch(() => {});

    // Clear pending data
    await AsyncStorage.removeItem("vc_pending_signup").catch(() => {});

    // Clear OTP state
    clearOTPState();
    
  } catch (error: any) {
    throw new Error(error?.message || "Failed to logout");
  }
}

// ✅ Required: default export to suppress expo-router route warning
export default {};