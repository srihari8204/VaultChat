// @ts-nocheck
import auth from '@react-native-firebase/auth';

export const registerUser = async (email: string, password: string, displayName: string, phone: string = '') => {
  const cred = await auth().createUserWithEmailAndPassword(email, password);
  await cred.user.updateProfile({ displayName });
  await cred.user.sendEmailVerification();
  return cred.user;
};

export const loginUser = async (email: string, password: string) => {
  const cred = await auth().signInWithEmailAndPassword(email, password);
  if (!cred.user.emailVerified) { await auth().signOut(); throw { message: 'EMAIL_NOT_VERIFIED' }; }
  return cred.user;
};

export const logoutUser = async () => { await auth().signOut(); };
export const onAuthChange = (callback: (user: any) => void) => auth().onAuthStateChanged(callback);
export const getCurrentUser = () => auth().currentUser;