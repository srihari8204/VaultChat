import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApp } from "@react-native-firebase/app";
import { getAuth, signInWithPhoneNumber } from "@react-native-firebase/auth";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "@react-native-firebase/firestore";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const app  = getApp();
const auth = getAuth(app);
const db   = getFirestore(app);

export interface SignupData {
  name: string; dob: string; email: string; mobile: string;
  securityQ1: string; securityA1: string;
  securityQ2: string; securityA2: string;
}

// ─── Configuration ──────────────────────────────────────────────
const IS_TEST_MODE = __DEV__; // Set to false for production
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

    console.log("[AUTH] Sending OTP to", phone);

    // Test mode for development
    if (IS_TEST_MODE) {
      console.warn(
        "[AUTH] ⚠️  TEST MODE ACTIVE — Enter 123456 as OTP\n" +
        "To disable, set IS_TEST_MODE = false in authService.ts"
      );
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

    const confirmationResult = await signInWithPhoneNumber(auth, phone);
    
    otpState = {
      confirmationResult,
      phone,
      timestamp: Date.now(),
      attempts: 0,
      testMode: false,
    };

    console.log("[AUTH] OTP sent successfully to", phone);
  } catch (error: any) {
    console.error("[AUTH] sendOTP failed:", error?.message);
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
        console.log("[AUTH] ✓ Test OTP verified");
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

    console.log("[AUTH] ✓ OTP verified successfully for user:", result.user.uid);
    otpState = null;
    return true;
  } catch (error: any) {
    console.error("[AUTH] verifyOTP failed:", error?.message);
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
  console.log("[AUTH] OTP state cleared");
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
    console.log("[AUTH] PIN saved securely");
  } catch (error: any) {
    console.error("[AUTH] savePIN failed:", error?.message);
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
    console.error("[AUTH] verifyPIN failed:", error?.message);
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
    console.log("[AUTH] Pending signup saved");
  } catch (error: any) {
    console.error("[AUTH] savePendingSignup failed:", error?.message);
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
    console.error("[AUTH] getPendingSignup failed:", error?.message);
    return null;
  }
}

/**
 * Clear pending signup data
 */
export async function clearPendingSignup() {
  try {
    await AsyncStorage.removeItem("vc_pending_signup");
    console.log("[AUTH] Pending signup cleared");
  } catch (error: any) {
    console.error("[AUTH] clearPendingSignup failed:", error?.message);
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
    console.log("[AUTH] User profile saved for", uid);
  } catch (error: any) {
    console.error("[AUTH] saveUserProfile failed:", error?.message);
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
    console.error("[AUTH] isSetupComplete check failed:", error?.message);
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
    console.log("[AUTH] Face enrolled at index", index);
  } catch (error: any) {
    console.error("[AUTH] enrollFace failed:", error?.message);
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
    console.error("[AUTH] getEnrolledFaceCount failed:", error?.message);
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
    
    console.log("[AUTH] User logged out and local data cleared");
  } catch (error: any) {
    console.error("[AUTH] logoutUser failed:", error?.message);
    throw new Error(error?.message || "Failed to logout");
  }
}

// ✅ Required: default export to suppress expo-router route warning
export default {};