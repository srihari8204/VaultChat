import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, sendEmailVerification, User } from 'firebase/auth';
import { auth } from './firebase';

export const registerUser = async (email: string, password: string, displayName: string, phone: string = '') => {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  await sendEmailVerification(cred.user);
  return cred.user;
};

export const loginUser = async (email: string, password: string) => {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  if (!cred.user.emailVerified) { await signOut(auth); throw { message: 'EMAIL_NOT_VERIFIED' }; }
  return cred.user;
};

export const logoutUser = async () => { await signOut(auth); };
export const onAuthChange = (callback: (user: User | null) => void) => onAuthStateChanged(auth, callback);
export const getCurrentUser = () => auth.currentUser;
