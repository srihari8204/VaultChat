import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyDKic9s-_fyg4OeAttQgZVBj4mT-4UkGSc",
  authDomain: "vaultchat-ce9e3.firebaseapp.com",
  projectId: "vaultchat-ce9e3",
  storageBucket: "vaultchat-ce9e3.firebasestorage.app",
  messagingSenderId: "207307621485",
  appId: "1:207307621485:android:56aa1a7927a5a77bdeab64",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
