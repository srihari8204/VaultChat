// Shim: replaces @react-native-firebase/firestore with JS Firebase SDK
import {
  getFirestore as _getFirestore,
  collection as _collection,
  doc as _doc,
  getDoc as _getDoc,
  getDocs as _getDocs,
  setDoc as _setDoc,
  updateDoc as _updateDoc,
  deleteDoc as _deleteDoc,
  addDoc as _addDoc,
  onSnapshot as _onSnapshot,
  query as _query,
  where as _where,
  orderBy as _orderBy,
  limit as _limit,
  serverTimestamp as _serverTimestamp,
  arrayUnion as _arrayUnion,
  arrayRemove as _arrayRemove,
  deleteField as _deleteField,
  Timestamp,
} from 'firebase/firestore';
import './firebase-app'; // ensure app is initialized first

let _db = null;
function getDb() {
  if (!_db) {
    const { getApp } = require('firebase/app');
    _db = _getFirestore(getApp());
  }
  return _db;
}

// ─── Compat wrappers ───────────────────────────────────────────────

/** Wrap a JS SDK DocumentSnapshot to match RN Firebase compat API */
function wrapDocSnap(snap) {
  return {
    exists: snap.exists(),
    id: snap.id,
    ref: wrapDocRef(snap.ref),
    data: () => snap.data(),
    get: (field) => snap.get(field),
    _raw: snap,
  };
}

/** Wrap a JS SDK QuerySnapshot to match RN Firebase compat API */
function wrapQuerySnap(snap) {
  return {
    docs: snap.docs.map(wrapDocSnap),
    empty: snap.empty,
    size: snap.size,
    forEach: (cb) => snap.docs.forEach((d) => cb(wrapDocSnap(d))),
    _raw: snap,
  };
}

/** Wrap a JS SDK DocumentReference to match RN Firebase compat API */
function wrapDocRef(ref) {
  return {
    id: ref.id,
    path: ref.path,
    get: () => _getDoc(ref).then(wrapDocSnap),
    set: (data, opts) => _setDoc(ref, data, opts || {}),
    update: (data) => _updateDoc(ref, data),
    delete: () => _deleteDoc(ref),
    onSnapshot: (cbOrOpts, cbOrError, errorCb) => {
      // Handle onSnapshot(callback), onSnapshot(options, callback, error)
      const callback = typeof cbOrOpts === 'function' ? cbOrOpts : cbOrError;
      const onError = typeof cbOrOpts === 'function' ? cbOrError : errorCb;
      return _onSnapshot(ref, (snap) => callback(wrapDocSnap(snap)), onError || undefined);
    },
    collection: (name) => wrapCollectionRef(_collection(ref, name)),
    _raw: ref,
  };
}

/** Wrap a JS SDK Query with compat chaining API */
function wrapQuery(q, colRef) {
  return {
    where: (field, op, value) => wrapQuery(_query(q, _where(field, op, value)), colRef),
    orderBy: (field, dir) => wrapQuery(_query(q, _orderBy(field, dir || 'asc')), colRef),
    limit: (n) => wrapQuery(_query(q, _limit(n)), colRef),
    get: () => _getDocs(q).then(wrapQuerySnap),
    onSnapshot: (cbOrOpts, cbOrError, errorCb) => {
      const callback = typeof cbOrOpts === 'function' ? cbOrOpts : cbOrError;
      const onError = typeof cbOrOpts === 'function' ? cbOrError : errorCb;
      return _onSnapshot(q, (snap) => callback(wrapQuerySnap(snap)), onError || undefined);
    },
    _raw: q,
  };
}

/** Wrap a JS SDK CollectionReference to match RN Firebase compat API */
function wrapCollectionRef(colRef) {
  const wrapped = wrapQuery(colRef, colRef);
  wrapped.id = colRef.id;
  wrapped.path = colRef.path;
  wrapped.doc = (id) => {
    const ref = id ? _doc(colRef, id) : _doc(colRef);
    return wrapDocRef(ref);
  };
  wrapped.add = (data) => _addDoc(colRef, data).then((ref) => wrapDocRef(ref));
  wrapped._raw = colRef;
  return wrapped;
}

// ─── Default export: firestore() compat function ──────────────────

function firestore() {
  const db = getDb();
  return {
    collection: (name) => wrapCollectionRef(_collection(db, name)),
    doc: (path) => wrapDocRef(_doc(db, path)),
    batch: () => {
      // Basic batch shim – import writeBatch lazily
      const { writeBatch } = require('firebase/firestore');
      const batch = writeBatch(db);
      return {
        set: (ref, data, opts) => batch.set(ref._raw || ref, data, opts || {}),
        update: (ref, data) => batch.update(ref._raw || ref, data),
        delete: (ref) => batch.delete(ref._raw || ref),
        commit: () => batch.commit(),
      };
    },
  };
}

// Attach FieldValue and Timestamp as static properties (compat pattern)
firestore.FieldValue = {
  serverTimestamp: () => _serverTimestamp(),
  arrayUnion: (...args) => _arrayUnion(...args),
  arrayRemove: (...args) => _arrayRemove(...args),
  delete: () => _deleteField(),
};

firestore.Timestamp = {
  now: () => Timestamp.now(),
  fromDate: (date) => Timestamp.fromDate(date),
  fromMillis: (ms) => Timestamp.fromMillis(ms),
};

// ─── Named modular exports (for files using modular API) ──────────

export function getFirestore(app) {
  if (app) return _getFirestore(app);
  return getDb();
}

export function collection(dbOrRef, path) {
  return _collection(dbOrRef, path);
}

export function doc(dbOrRef, ...pathSegments) {
  return _doc(dbOrRef, ...pathSegments);
}

export function getDoc(ref) {
  return _getDoc(ref);
}

export function getDocs(q) {
  return _getDocs(q);
}

export function setDoc(ref, data, opts) {
  return _setDoc(ref, data, opts || {});
}

export function updateDoc(ref, data) {
  return _updateDoc(ref, data);
}

export function deleteDoc(ref) {
  return _deleteDoc(ref);
}

export function addDoc(colRef, data) {
  return _addDoc(colRef, data);
}

export function onSnapshot(ref, cbOrOpts, cbOrError, errorCb) {
  const callback = typeof cbOrOpts === 'function' ? cbOrOpts : cbOrError;
  const onError = typeof cbOrOpts === 'function' ? cbOrError : errorCb;
  return _onSnapshot(ref, callback, onError || undefined);
}

export function query(ref, ...constraints) {
  return _query(ref, ...constraints);
}

export function where(field, op, value) {
  return _where(field, op, value);
}

export function orderBy(field, dir) {
  return _orderBy(field, dir || 'asc');
}

export function limit(n) {
  return _limit(n);
}

export function serverTimestamp() {
  return _serverTimestamp();
}

export { Timestamp };

export default firestore;
