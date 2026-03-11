import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const KEYS = {
  PIN:"vc_backup_pin_hash", Q1:"vc_sq_1", Q2:"vc_sq_2", Q3:"vc_sq_3",
  A1:"vc_sa_1", A2:"vc_sa_2", A3:"vc_sa_3",
  SETUP_DONE:"vc_setup_complete", VAULT_ID:"vc_vault_id",
  DISPLAY_NAME:"vc_display_name", PHOTO_URI:"vc_photo_uri",
};

async function hashValue(value: string): Promise<string> {
  return await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    value.trim().toLowerCase()
  );
}
export async function savePIN(pin: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.PIN, await hashValue(pin));
}
export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(KEYS.PIN);
  return stored === await hashValue(pin);
}
export async function saveSecurityAnswers(q1:string,a1:string,q2:string,a2:string,q3:string,a3:string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.Q1,q1); await SecureStore.setItemAsync(KEYS.Q2,q2); await SecureStore.setItemAsync(KEYS.Q3,q3);
  await SecureStore.setItemAsync(KEYS.A1,await hashValue(a1));
  await SecureStore.setItemAsync(KEYS.A2,await hashValue(a2));
  await SecureStore.setItemAsync(KEYS.A3,await hashValue(a3));
}
export async function getSecurityQuestions(): Promise<string[]> {
  return [(await SecureStore.getItemAsync(KEYS.Q1))??"",(await SecureStore.getItemAsync(KEYS.Q2))??"",(await SecureStore.getItemAsync(KEYS.Q3))??""];
}
export async function verifySecurityAnswers(a1:string,a2:string,a3:string): Promise<boolean> {
  const s1=await SecureStore.getItemAsync(KEYS.A1);
  const s2=await SecureStore.getItemAsync(KEYS.A2);
  const s3=await SecureStore.getItemAsync(KEYS.A3);
  return s1===await hashValue(a1) && s2===await hashValue(a2) && s3===await hashValue(a3);
}
export async function saveProfile(vaultId:string,displayName:string,photoUri:string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.VAULT_ID,vaultId);
  await SecureStore.setItemAsync(KEYS.DISPLAY_NAME,displayName);
  await SecureStore.setItemAsync(KEYS.PHOTO_URI,photoUri);
}
export async function getProfile() {
  return {
    vaultId:(await SecureStore.getItemAsync(KEYS.VAULT_ID))??"",
    displayName:(await SecureStore.getItemAsync(KEYS.DISPLAY_NAME))??"",
    photoUri:(await SecureStore.getItemAsync(KEYS.PHOTO_URI))??"",
  };
}
export async function markSetupComplete(): Promise<void> {
  await SecureStore.setItemAsync(KEYS.SETUP_DONE,"true");
}
export async function isSetupComplete(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEYS.SETUP_DONE))==="true";
}
export async function clearAllSecureData(): Promise<void> {
  await Promise.all(Object.values(KEYS).map(k=>SecureStore.deleteItemAsync(k)));
}
