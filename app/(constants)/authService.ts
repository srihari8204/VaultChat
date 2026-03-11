import auth from "@react-native-firebase/auth";
import firestore from "@react-native-firebase/firestore";

let confirmationRef: any = null;

export async function sendOTP(phoneNumber: string): Promise<void> {
  confirmationRef = await auth().signInWithPhoneNumber(phoneNumber);
}
export async function verifyOTP(otp: string): Promise<boolean> {
  if (!confirmationRef) throw new Error("No OTP sent yet");
  const result = await confirmationRef.confirm(otp);
  return !!result?.user;
}
export async function checkVaultIdAvailable(vaultId: string): Promise<boolean> {
  const snap = await firestore().collection("vaultids").doc(vaultId.toLowerCase()).get();
  return !snap.exists;
}
export async function registerVaultId(vaultId: string): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) throw new Error("Not authenticated");
  await firestore().collection("vaultids").doc(vaultId.toLowerCase()).set({
    uid, createdAt: firestore.FieldValue.serverTimestamp(),
  });
  await firestore().collection("users").doc(uid).set({
    vaultId: vaultId.toLowerCase(),
    createdAt: firestore.FieldValue.serverTimestamp(),
    phone: auth().currentUser?.phoneNumber ?? "",
  }, { merge: true });
}
export async function updateUserProfile(displayName: string, photoUri: string): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) return;
  await firestore().collection("users").doc(uid).set({
    displayName, photoUri, updatedAt: firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
export function onAuthChange(callback: (user: any) => void) {
  return auth().onAuthStateChanged(callback);
}
export async function logoutUser(): Promise<void> {
  await auth().signOut();
}
export function getCurrentUser() {
  return auth().currentUser;
}
