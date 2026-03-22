// Shim: replaces @react-native-firebase/app with JS Firebase SDK
import { initializeApp, getApps, getApp } from 'firebase/app';

const firebaseConfig = {
  apiKey: "AIzaSyDKic9s-_fyg4OeAttQgZVBj4mT-4UkGSc",
  authDomain: "vaultchat-ce9e3.firebaseapp.com",
  projectId: "vaultchat-ce9e3",
  storageBucket: "vaultchat-ce9e3.firebasestorage.app",
  messagingSenderId: "207307621485",
  appId: "1:207307621485:android:56aa1a7927a5a77bdeab64",
};

// Initialize once — same config as constants/firebase.ts
if (getApps().length === 0) {
  initializeApp(firebaseConfig);
}

export { getApp, getApps, initializeApp };
export default function firebase() {
  return getApp();
}
