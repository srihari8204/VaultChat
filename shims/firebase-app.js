// Shim: replaces @react-native-firebase/app with JS Firebase SDK
import { initializeApp, getApps, getApp } from 'firebase/app';

const firebaseConfig = {
  apiKey: "AIzaSyBKL2HIzv5NGeRPJBLj1AZGKZ5JCzxzjPc",
  authDomain: "vaultchatprod01.firebaseapp.com",
  projectId: "vaultchatprod01",
  storageBucket: "vaultchatprod01.firebasestorage.app",
  messagingSenderId: "553821750020",
  appId: "1:553821750020:android:537c9dc1496e9c40350651",
};

// Initialize once — same config as constants/firebase.ts
if (getApps().length === 0) {
  initializeApp(firebaseConfig);
}

export { getApp, getApps, initializeApp };
export default function firebase() {
  return getApp();
}
