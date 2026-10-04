// lib/backupSecretSwitch.selftest.ts — run: npx tsx lib/backupSecretSwitch.selftest.ts
//
// State transitions of switching the e2ee backup secret (enableE2EEBackup):
// turn on, change password, switch password ↔ key — and what the device holds
// when the upload or the store write fails.
import assert from 'node:assert/strict';
import { switchBackupSecret, type SecretPair, type SecretSlot } from './backupSecretSwitch';

type H = { mode: 'password' | 'key'; salt: string };
const pw1: SecretPair<H> = { secret: 'S-pw1', header: { mode: 'password', salt: 'a' } };
const pw2: SecretPair<H> = { secret: 'S-pw2', header: { mode: 'password', salt: 'b' } };
const key: SecretPair<H> = { secret: 'S-key', header: { mode: 'key', salt: '' } };

function world(start: SecretPair<H> | null, opts: { failUploads?: number; failPut?: boolean; failGet?: boolean } = {}) {
  const st = { stored: start, server: start?.secret ?? 'ACCOUNT', uploads: [] as string[] };
  let uploadFailures = opts.failUploads ?? 0;
  let putFailures = opts.failPut ? 1 : 0;
  const slot: SecretSlot<H> = {
    get: async () => { if (opts.failGet) throw new Error('read'); return st.stored; },
    put: async (p) => { if (putFailures > 0) { putFailures--; throw new Error('store'); } st.stored = p; },
    clear: async () => { st.stored = null; },
  };
  const upload = async (u: SecretPair<H> | null) => {
    const k = u?.secret ?? 'ACCOUNT';
    st.uploads.push(k);
    if (uploadFailures > 0) { uploadFailures--; throw new Error('network'); }
    st.server = k;
  };
  return { st, slot, upload };
}

(async () => {
  // Turn on from account mode: upload first, then store.
  {
    const w = world(null);
    await switchBackupSecret(w.slot, pw1, w.upload);
    assert.deepEqual(w.st.stored, pw1);
    assert.equal(w.st.server, 'S-pw1');
  }
  // Change password while on: old secret kept until the new upload lands.
  {
    const w = world(pw1);
    await switchBackupSecret(w.slot, pw2, w.upload);
    assert.deepEqual(w.st.stored, pw2);
    assert.equal(w.st.server, 'S-pw2');
  }
  // Switch password → key while on.
  {
    const w = world(pw1);
    await switchBackupSecret(w.slot, key, w.upload);
    assert.equal(w.st.stored?.header.mode, 'key');
    assert.equal(w.st.server, 'S-key');
  }
  // Upload fails while on: still on, same password, server copy untouched.
  // (The old enableE2EEBackup deleted the secret here — "on" became "account".)
  {
    const w = world(pw1, { failUploads: 1 });
    await assert.rejects(switchBackupSecret(w.slot, pw2, w.upload), /network/);
    assert.deepEqual(w.st.stored, pw1, 'old secret kept');
    assert.equal(w.st.server, 'S-pw1');
  }
  // Upload fails from account mode: stays account mode.
  {
    const w = world(null, { failUploads: 1 });
    await assert.rejects(switchBackupSecret(w.slot, key, w.upload), /network/);
    assert.equal(w.st.stored, null);
    assert.equal(w.st.server, 'ACCOUNT');
  }
  // Store write fails after the upload: old pair restored, server re-uploaded under it.
  {
    const w = world(pw1, { failPut: true });
    await assert.rejects(switchBackupSecret(w.slot, key, w.upload), /store/);
    assert.deepEqual(w.st.stored, pw1);
    assert.equal(w.st.server, 'S-pw1', 'server copy readable with the secret the device holds');
    assert.deepEqual(w.st.uploads, ['S-key', 'S-pw1']);
  }
  {
    const w = world(null, { failPut: true });
    await assert.rejects(switchBackupSecret(w.slot, pw1, w.upload), /store/);
    assert.equal(w.st.stored, null);
    assert.equal(w.st.server, 'ACCOUNT');
  }
  // A failed read aborts before any upload.
  {
    const w = world(pw1, { failGet: true });
    await assert.rejects(switchBackupSecret(w.slot, pw2, w.upload), /read/);
    assert.deepEqual(w.st.uploads, []);
  }
  console.log('backupSecretSwitch selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
