import { getApp } from "@react-native-firebase/app";
import { getAuth } from "@react-native-firebase/auth";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from "@react-native-firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const app  = getApp();
const auth = getAuth(app);
const db   = getFirestore(app);

export interface SignupData {
  name: string; dob: string; email: string; mobile: string;
  securityQ1: string; securityA1: string;
  securityQ2: string; securityA2: string;
}

// ─── TEST MODE — remove this block when real OTP is ready ───────
// All phone numbers use OTP: 123456
const TEST_OTP = "123456";
let _testMode   = false;
let _confirmRef: any = null;
// ────────────────────────────────────────────────────────────────

export async function sendOTP(phone: string) {
  // 🔧 TEST MODE: always use 123456 — swap this block for real OTP later
  _testMode = true;
  console.log("[AUTH] TEST MODE — Enter 123456 as OTP");
  return;

  // ── REAL OTP (uncomment when ready) ──────────────────────────
  // _testMode = false;
  // _confirmRef = await signInWithPhoneNumber(auth, phone);
}

export async function verifyOTP(code: string) {
  if (_testMode && code === TEST_OTP) { _testMode = false; return true; }
  if (_testMode && code !== TEST_OTP) throw new Error("Wrong OTP. Test OTP is 123456");
  if (!_confirmRef) throw new Error("No pending OTP — please resend");
  const result = await _confirmRef.confirm(code);
  _confirmRef = null;
  return !!result?.user;
}

async function sha256(s: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);
}

export async function savePIN(pin: string) {
  await SecureStore.setItemAsync("vc_pin_hash", await sha256(pin));
}

export async function verifyPIN(pin: string) {
  const s = await SecureStore.getItemAsync("vc_pin_hash");
  if (!s) return false;
  return (await sha256(pin)) === s;
}

export async function hasPIN() {
  return !!(await SecureStore.getItemAsync("vc_pin_hash"));
}

export async function savePendingSignup(d: SignupData) {
  await AsyncStorage.setItem("vc_pending_signup", JSON.stringify(d));
}

export async function getPendingSignup(): Promise<SignupData | null> {
  const r = await AsyncStorage.getItem("vc_pending_signup");
  return r ? JSON.parse(r) : null;
}

export async function clearPendingSignup() {
  await AsyncStorage.removeItem("vc_pending_signup");
}

export async function saveUserProfile(d: SignupData) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Not authenticated");
  // Hash phone for privacy-safe contact matching
  const phoneHash = await sha256(d.mobile);
  await setDoc(doc(db, "users", uid), {
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
  });
}

export async function isSetupComplete() {
  const uid = auth.currentUser?.uid;
  if (!uid) return false;
  try { return (await getDoc(doc(db, "users", uid))).exists(); }
  catch { return false; }
}

export async function enrollFace(uri: string, index: number) {
  await AsyncStorage.setItem("vc_face_" + index, uri);
}

export async function getEnrolledFaceCount() {
  let c = 0;
  for (let i = 0; i < 3; i++)
    if (await AsyncStorage.getItem("vc_face_" + i)) c++;
  return c;
}

export async function hasFaceEnrolled() {
  return !!(await AsyncStorage.getItem("vc_face_0"));
}

export function getCurrentUser() { return auth.currentUser; }

export function onAuthChange(cb: (u: any) => void) {
  return auth.onAuthStateChanged(cb);
}

export async function logoutUser() {
  await auth.signOut();
  for (let i = 0; i < 3; i++) await AsyncStorage.removeItem("vc_face_" + i);
  await SecureStore.deleteItemAsync("vc_pin_hash").catch(() => {});
}

// ✅ Required: default export to suppress expo-router route warning
export default {};