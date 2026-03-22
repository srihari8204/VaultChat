// Shim: replaces @react-native-firebase/auth with JS Firebase SDK
import { getAuth as _getAuth, signInWithPhoneNumber as _signIn, onAuthStateChanged as _onAuthStateChanged } from 'firebase/auth';
import './firebase-app'; // ensure app is initialized first

let _auth = null;
function getAuthInstance() {
  if (!_auth) {
    const { getApp } = require('firebase/app');
    _auth = _getAuth(getApp());
  }
  return _auth;
}

// Compat default export: auth() returns the auth instance
function auth() {
  return getAuthInstance();
}

// Attach compat properties so auth.currentUser, auth.onAuthStateChanged, auth.signOut work
Object.defineProperty(auth, 'currentUser', {
  get: () => getAuthInstance().currentUser,
});
Object.defineProperty(auth, 'onAuthStateChanged', {
  value: (callback) => _onAuthStateChanged(getAuthInstance(), callback),
});
Object.defineProperty(auth, 'signOut', {
  value: () => getAuthInstance().signOut(),
});

export function getAuth(app) {
  return app ? _getAuth(app) : getAuthInstance();
}

export function onAuthStateChanged(authOrCb, cbOrUndefined) {
  if (cbOrUndefined !== undefined) {
    return _onAuthStateChanged(authOrCb, cbOrUndefined);
  }
  return _onAuthStateChanged(getAuthInstance(), authOrCb);
}

export function signInWithPhoneNumber(authOrPhone, phoneOrUndefined) {
  // Handle both modular: signInWithPhoneNumber(auth, phone)
  // and compat: signInWithPhoneNumber(phone) patterns
  if (phoneOrUndefined !== undefined) {
    return _signIn(authOrPhone, phoneOrUndefined);
  }
  return _signIn(getAuthInstance(), authOrPhone);
}

export default auth;
