// Shim: replaces @react-native-firebase/storage with JS Firebase SDK
import { getStorage as _getStorage, ref, uploadBytesResumable, uploadString, getDownloadURL, deleteObject } from 'firebase/storage';
import './firebase-app'; // ensure app is initialized first

let _storage = null;
function getStorageInstance() {
  if (!_storage) {
    const { getApp } = require('firebase/app');
    _storage = _getStorage(getApp());
  }
  return _storage;
}

// Create a task-like wrapper around uploadBytesResumable for compat API
function createUploadTask(storageRef, data, metadata) {
  const task = uploadBytesResumable(storageRef, data, metadata);
  const listeners = [];

  const wrapper = new Promise((resolve, reject) => {
    task.on(
      'state_changed',
      (snapshot) => {
        listeners.forEach(({ callback }) => callback(snapshot));
      },
      (error) => reject(error),
      () => resolve(task.snapshot)
    );
  });

  // Attach .on() for compat usage: task.on('state_changed', cb)
  wrapper.on = (event, callback) => {
    if (event === 'state_changed' && callback) {
      listeners.push({ callback });
    }
    return wrapper;
  };

  // Expose cancel/pause/resume
  wrapper.cancel = () => task.cancel();
  wrapper.pause = () => task.pause();
  wrapper.resume = () => task.resume();

  return wrapper;
}

function wrapRef(storageRef) {
  return {
    put: (data, metadata) => createUploadTask(storageRef, data, metadata),
    putString: (data, format, metadata) => uploadString(storageRef, data, format, metadata),
    putFile: (localPath) => {
      // putFile is RN-specific; for JS SDK we fetch the file as blob
      // Return a task-like object that supports .on('state_changed')
      const blobPromise = fetch(localPath).then(r => r.blob());

      let listeners = [];
      let innerTask = null;

      const wrapper = new Promise((resolve, reject) => {
        blobPromise
          .then((blob) => {
            innerTask = uploadBytesResumable(storageRef, blob);
            innerTask.on(
              'state_changed',
              (snapshot) => {
                listeners.forEach(({ callback }) => callback(snapshot));
              },
              (error) => reject(error),
              () => resolve(innerTask.snapshot)
            );
          })
          .catch(reject);
      });

      wrapper.on = (event, callback) => {
        if (event === 'state_changed' && callback) {
          listeners.push({ callback });
        }
        return wrapper;
      };
      wrapper.cancel = () => innerTask?.cancel();
      wrapper.pause = () => innerTask?.pause();
      wrapper.resume = () => innerTask?.resume();

      return wrapper;
    },
    getDownloadURL: () => getDownloadURL(storageRef),
    delete: () => deleteObject(storageRef),
    child: (path) => wrapRef(ref(storageRef, path)),
    fullPath: storageRef.fullPath,
    name: storageRef.name,
    _raw: storageRef,
  };
}

function storage() {
  const s = getStorageInstance();
  return {
    ref: (path) => wrapRef(path ? ref(s, path) : ref(s)),
  };
}

export function getStorage(app) {
  return app ? _getStorage(app) : getStorageInstance();
}

export default storage;
