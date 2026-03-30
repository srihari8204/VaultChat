// constants/firebase.ts
// Re-export React Native Firebase instances
// Config is auto-loaded from google-services.json (Android) / GoogleService-Info.plist (iOS)

import { getApp } from '@react-native-firebase/app';
import { getAuth } from '@react-native-firebase/auth';
import { getFirestore } from '@react-native-firebase/firestore';

const app = getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;
