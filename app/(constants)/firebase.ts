import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDKic9s-_fyg4OeAttQgZVBj4mT-4UkGSc",
  authDomain: "vaultchat-ce9e3.firebaseapp.com",
  projectId: "vaultchat-ce9e3",
  storageBucket: "vaultchat-ce9e3.appspot.com",
  messagingSenderId: "207307621485",
  appId: "1:207307621485:android:56aa1a7927a5a77bdeab64"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage)
});

const db = getFirestore(app);

export { auth, db };
export default app;
