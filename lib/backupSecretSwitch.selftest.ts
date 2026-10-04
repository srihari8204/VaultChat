// lib/backupSecretSwitch.selftest.ts — run: npx tsx lib/backupSecretSwitch.selftest.ts
//
// Every path of switching the e2ee backup secret (lib/cloudBackup's
// enableE2EEBackup / disableE2EEBackup): turn on, change password, password ↔
// key, a new key, turn off — and what the device and the server copy hold when
// the upload, the store write, the read-back or the rollback upload fails, when
// the app dies mid-switch, and when a scheduled backup races the switch.
// Plus the key id that lets a restore tell an older key's copy from the current
// one (lib/backupCrypto), and the wiring in cloudBackup / backupScheduler.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  switchBackupSecret, createLock, isBackupSwitchError, backupErrorText, isBackupBusy, adoptRestoredSecret,
  type SecretPair, type SecretSlot, type PendingMarker, type BackupSwitchError,
} from './backupSecretSwitch';

const HERE = dirname(fileURLToPath(import.meta.url));

type H = { mode: 'password' | 'key'; salt: string };
const pw1: SecretPair<H> = { secret: 'S-pw1', header: { mode: 'password', salt: 'a' } };
const pw2: SecretPair<H> = { secret: 'S-pw2', header: { mode: 'password', salt: 'b' } };
const key: SecretPair<H> = { secret: 'S-key', header: { mode: 'key', salt: '' } };
const key2: SecretPair<H> = { secret: 'S-key2', header: { mode: 'key', salt: '' } };

interface Opts {
  failUploads?: number;          // the first N uploads throw
  /** 'before': the write never lands; 'after': it lands, then the call throws. */
  failPut?: 'before' | 'after';
  failGetAt?: number[];          // 1-based get() calls that throw
  failMarker?: boolean;
  hangPut?: boolean;             // the app dies while storing
}

function world(start: SecretPair<H> | null, o: Opts = {}) {
  const st = { stored: start, server: start?.secret ?? 'ACCOUNT', uploads: [] as string[], marker: false };
  let uploadFailures = o.failUploads ?? 0;
  let gets = 0;
  const write = (p: SecretPair<H> | null) => { st.stored = p ? { ...p } : null; };
  const store = (p: SecretPair<H> | null) => {
    if (o.hangPut) return new Promise<void>(() => {});
    if (o.failPut === 'before') return Promise.reject(new Error('store'));
    write(p);
    return o.failPut === 'after' ? Promise.reject(new Error('store')) : Promise.resolve();
  };
  const slot: SecretSlot<H> = {
    get: async () => { gets++; if (o.failGetAt?.includes(gets)) throw new Error('read'); return st.stored; },
    put: (p) => store(p),
    clear: () => store(null),
  };
  const pending: PendingMarker = {
    set: async () => { if (o.failMarker) throw new Error('marker'); st.marker = true; },
    clear: async () => { st.marker = false; },
  };
  const upload = async (u: SecretPair<H> | null) => {
    const k = u?.secret ?? 'ACCOUNT';
    st.uploads.push(k);
    if (uploadFailures > 0) { uploadFailures--; throw new Error('network'); }
    st.server = k;
  };
  // What lib/cloudBackup's uploadCloudBackup does on the next run: upload under
  // the pair the device holds, then clear the marker.
  const backupRun = async () => { await upload(await slot.get()); st.marker = false; };
  return { st, slot, pending, upload, backupRun };
}

async function switchErr(p: Promise<void>): Promise<BackupSwitchError> {
  try { await p; } catch (e) { assert.ok(isBackupSwitchError(e), `expected a BackupSwitchError, got ${e}`); return e as BackupSwitchError; }
  throw new Error('expected the switch to fail');
}

const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  // ── Successful switches ────────────────────────────────────────────────
  {
    const w = world(null);
    await switchBackupSecret(w.slot, w.pending, pw1, w.upload);
    assert.deepEqual(w.st.stored, pw1, 'turn on: stored');
    assert.equal(w.st.server, 'S-pw1');
    assert.equal(w.st.marker, false, 'a finished switch clears the marker');
  }
  {
    const w = world(pw1);
    await switchBackupSecret(w.slot, w.pending, pw2, w.upload);
    assert.deepEqual(w.st.stored, pw2, 'change password');
    assert.equal(w.st.server, 'S-pw2');
  }
  {
    const w = world(pw1);
    await switchBackupSecret(w.slot, w.pending, key, w.upload);
    assert.equal(w.st.stored?.header.mode, 'key', 'password → key');
    assert.equal(w.st.server, 'S-key');
  }
  {
    const w = world(key);
    await switchBackupSecret(w.slot, w.pending, key2, w.upload);
    assert.equal(w.st.stored?.secret, 'S-key2', 'make a new key');
    assert.equal(w.st.server, 'S-key2');
  }
  {
    const w = world(pw1);
    await switchBackupSecret(w.slot, w.pending, null, w.upload);
    assert.equal(w.st.stored, null, 'turn off');
    assert.equal(w.st.server, 'ACCOUNT');
    assert.equal(w.st.marker, false);
  }

  // ── Nothing starts when the first steps fail ───────────────────────────
  {
    const w = world(pw1, { failGetAt: [1] });
    await assert.rejects(switchBackupSecret(w.slot, w.pending, pw2, w.upload), /read/);
    assert.deepEqual(w.st.uploads, [], 'a failed read aborts before any upload');
    assert.equal(w.st.marker, false);
  }
  {
    const w = world(pw1, { failMarker: true });
    await assert.rejects(switchBackupSecret(w.slot, w.pending, pw2, w.upload), /marker/);
    assert.deepEqual(w.st.uploads, [], 'no marker, no upload');
    assert.deepEqual(w.st.stored, pw1);
  }

  // ── The upload fails: device unchanged, marker left for the next run ───
  {
    const w = world(pw1, { failUploads: 1 });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, pw2, w.upload));
    assert.equal(e.device, 'prev');
    assert.equal(e.server, 'unknown');
    assert.deepEqual(w.st.stored, pw1, 'old secret kept (the pre-round-4 code deleted it here)');
    assert.equal(w.st.marker, true, 'next run re-uploads under the old secret, in case the upload landed');
    await w.backupRun();
    assert.equal(w.st.server, 'S-pw1');
    assert.equal(w.st.marker, false);
  }
  {
    const w = world(null, { failUploads: 1 });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, key, w.upload));
    assert.equal(e.device, 'prev');
    assert.equal(w.st.stored, null, 'still account mode');
    assert.equal(w.st.server, 'ACCOUNT');
  }
  {
    const w = world(pw1, { failUploads: 1 });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, null, w.upload));
    assert.equal(e.device, 'prev', 'turn off with a failed upload: still on');
    assert.deepEqual(w.st.stored, pw1);
  }

  // ── The store write fails ──────────────────────────────────────────────
  // (a) It throws but the record landed (read-back says so): that IS the switch.
  {
    const w = world(pw1, { failPut: 'after' });
    await switchBackupSecret(w.slot, w.pending, key, w.upload);
    assert.deepEqual(w.st.stored, key, 'a write that threw after landing counts');
    assert.equal(w.st.server, 'S-key', 'server and device agree');
    assert.deepEqual(w.st.uploads, ['S-key'], 'no needless rollback upload');
  }
  // (b) It never landed: the device kept the old pair; re-upload under it.
  {
    const w = world(pw1, { failPut: 'before' });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, key, w.upload));
    assert.equal(e.device, 'prev');
    assert.equal(e.server, 'prev', '"Nothing was changed" is true only here');
    assert.deepEqual(w.st.stored, pw1);
    assert.equal(w.st.server, 'S-pw1');
    assert.deepEqual(w.st.uploads, ['S-key', 'S-pw1']);
    assert.equal(w.st.marker, false);
  }
  {
    const w = world(null, { failPut: 'before' });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, pw1, w.upload));
    assert.equal(e.server, 'prev');
    assert.equal(w.st.stored, null);
    assert.equal(w.st.server, 'ACCOUNT');
  }
  // (c) Double failure: the store and the rollback upload both fail. The
  //     server copy is under the NEW secret and the error says so (the screen
  //     then shows the new key); the marker stays so the next run fixes it.
  {
    const w = world(key, { failPut: 'before' });
    let uploads = 0;
    const upload = async (u: SecretPair<H> | null) => { uploads++; if (uploads === 2) throw new Error('network'); await w.upload(u); };
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, key2, upload));
    assert.equal(e.device, 'prev');
    assert.equal(e.server, 'next', 'not "Nothing was changed"');
    assert.match(e.message, /store/, 'reports the store failure');
    assert.deepEqual(w.st.stored, key);
    assert.equal(w.st.server, 'S-key2');
    assert.equal(w.st.marker, true);
    await w.backupRun();
    assert.equal(w.st.server, 'S-key', 'the next run puts the server back under the key the device holds');
  }
  // (d) The store fails and the device cannot even be read back: backups stay
  //     blocked (reads fail closed) and the server copy is reported as new.
  {
    const w = world(pw1, { failPut: 'before', failGetAt: [2] });
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, key, w.upload));
    assert.equal(e.device, 'unknown');
    assert.equal(e.server, 'next');
    assert.deepEqual(w.st.uploads, ['S-key'], 'no upload under a guess');
    assert.equal(w.st.marker, true);
  }
  // Turning off: the clear fails and so does the rollback upload — the server
  // copy is account-readable while the device is still on. Reported as such.
  {
    const w = world(pw1, { failPut: 'before' });
    let uploads = 0;
    const upload = async (u: SecretPair<H> | null) => { uploads++; if (uploads === 2) throw new Error('network'); await w.upload(u); };
    const e = await switchErr(switchBackupSecret(w.slot, w.pending, null, upload));
    assert.equal(e.device, 'prev');
    assert.equal(e.server, 'next');
    assert.equal(w.st.server, 'ACCOUNT');
  }

  // ── The app dies mid-switch ────────────────────────────────────────────
  // After the upload under the new key, before it is stored: the marker makes
  // the next start re-upload under the key the device (and the user) still has.
  {
    const w = world(key, { hangPut: true });
    void switchBackupSecret(w.slot, w.pending, key2, w.upload);
    await tick();
    assert.equal(w.st.server, 'S-key2', 'server under a key never shown');
    assert.deepEqual(w.st.stored, key);
    assert.equal(w.st.marker, true, 'the crash leaves the marker');
    await w.backupRun();                               // next start (scheduler bypasses its timer)
    assert.equal(w.st.server, 'S-key');
    assert.equal(w.st.marker, false);
  }

  // ── A scheduled backup racing the switch ───────────────────────────────
  // The scheduled run resolves the secret, waits on the network, then uploads.
  // Without the lock its upload lands last, under the OLD secret.
  {
    const raceWith = async (lock: <T>(fn: () => Promise<T>) => Promise<T>) => {
      const w = world(pw1);
      const scheduled = lock(async () => { const using = await w.slot.get(); await tick(); await w.upload(using); });
      const sw = lock(() => switchBackupSecret(w.slot, w.pending, key, w.upload));
      await Promise.all([scheduled, sw]);
      return w.st;
    };
    const unlocked = await raceWith((fn) => fn());
    assert.equal(unlocked.server, 'S-pw1', 'the race is real without the lock');
    assert.equal(unlocked.stored?.secret, 'S-key');
    const locked = await raceWith(createLock());
    assert.equal(locked.server, 'S-key', 'with the lock the server copy matches the device');
    assert.equal(locked.stored?.secret, 'S-key');
  }
  // The lock keeps going after a failure.
  {
    const lock = createLock();
    await assert.rejects(lock(async () => { throw new Error('x'); }));
    assert.equal(await lock(async () => 7), 7);
  }
  // A watched call gives up waiting behind a long holder, and never runs late.
  {
    const lock = createLock();
    let release!: () => void;
    const holder = lock(() => new Promise<void>((r) => { release = r; }));
    let ran = false;
    const waiter = lock(async () => { ran = true; }, 20);
    await assert.rejects(waiter, (e: unknown) => isBackupBusy(e), 'BACKUP_BUSY after waitMs');
    release();
    await holder;
    await tick();
    assert.equal(ran, false, 'a call that gave up never runs once the lock frees');
    assert.equal(await lock(async () => 8, 20), 8, 'the queue moves on past it');
    // A waitMs call that gets the lock in time runs to completion, however long.
    const slow = await lock(async () => { await new Promise((r) => setTimeout(r, 40)); return 9; }, 20);
    assert.equal(slow, 9, 'waitMs bounds the WAIT, not the work');
  }

  // ── A restore that opened an end-to-end encrypted copy (rerate5 N2) ─────
  {
    const w = world(null);
    assert.equal(await adoptRestoredSecret(w.slot, pw1), 'adopted');
    assert.deepEqual(w.st.stored, pw1, 'an account-mode phone stays end-to-end encrypted after the restore');
  }
  {
    const w = world(key2);
    assert.equal(await adoptRestoredSecret(w.slot, key), 'kept');
    assert.deepEqual(w.st.stored, key2, 'restoring an older copy never brings back a replaced key');
  }
  {
    const w = world(null, { failPut: 'after' });
    assert.equal(await adoptRestoredSecret(w.slot, pw1), 'adopted', 'a put that threw after landing counts');
  }
  {
    const w = world(null, { failPut: 'before' });
    await assert.rejects(adoptRestoredSecret(w.slot, pw1), (e: any) => e?.code === 'BACKUP_ADOPT_FAILED',
      'not stored: the restore stops before writing anything');
    assert.equal(w.st.stored, null);
  }
  {
    const w = world(null, { failGetAt: [2] });
    await assert.rejects(adoptRestoredSecret(w.slot, pw1), (e: any) => e?.code === 'BACKUP_ADOPT_FAILED',
      'cannot read it back: refuse rather than guess');
  }
  {
    const w = world(null, { failGetAt: [1] });
    assert.equal(await adoptRestoredSecret(w.slot, pw1), 'adopted', 'an unreadable first read still stores and verifies');
  }

  // ── User copy for failures ─────────────────────────────────────────────
  assert.equal(backupErrorText(new TypeError('Network request failed')), 'Check your connection and try again.');
  assert.match(backupErrorText(new Error('backup upload failed (503)')), /storage server/);
  assert.equal(backupErrorText(Object.assign(new Error('Your session has expired. Please sign in again.'), { status: 401 })),
    'Your session has expired. Please sign in again.', 'lib/api copy passes through');
  assert.match(backupErrorText({ code: 'BACKUP_SETTINGS_UNREADABLE', message: 'x' }), /couldn't read your backup encryption settings/);
  assert.equal(backupErrorText(new Error('aes/gcm: invalid ghash tag'), 'F'), 'F', 'no raw crypto text');
  assert.match(backupErrorText({ code: 'BACKUP_BUSY' }), /still running/);
  assert.match(backupErrorText({ code: 'BACKUP_RESTORE_PENDING' }), /replace it/);
  assert.match(backupErrorText({ code: 'BACKUP_ADOPT_FAILED' }), /nothing was restored/);
  assert.match(backupErrorText(Object.assign(new Error('The backup transfer timed out.'), { name: 'TimeoutError' })), /connection/,
    'a transfer deadline reads as a connection problem');

  // ── Wiring that cannot run under Node (react-native imports) ───────────
  {
    const cb = readFileSync(join(HERE, 'cloudBackup.ts'), 'utf8');
    const sched = readFileSync(join(HERE, 'backupScheduler.ts'), 'utf8');
    const keyOf = (src: string) => /const SWITCH_PENDING_KEY = '([^']+)'/.exec(src)?.[1];
    assert.ok(keyOf(cb) && keyOf(cb) === keyOf(sched), 'scheduler reads the same pending marker');
    assert.match(sched, /if \(s\.frequency === 'manual' && !switchPending\) return;/, 'a pending switch runs even on manual');
    assert.match(sched, /if \(!switchPending && Date\.now\(\)/, 'and without waiting for the interval');
    const slotSrc = cb.slice(cb.indexOf('const e2eeSlot'), cb.indexOf('const pendingMarker'));
    assert.match(slotSrc, /async put\(pair\) \{\s*await SecureStore\.setItemAsync\(E2EE_STORE, JSON\.stringify\(pair\)\);/, 'secret and header are ONE write');
    const stored = cb.slice(cb.indexOf('async function storedE2EE'), cb.indexOf('const e2eeSlot'));
    assert.match(stored, /catch \(e\) \{ throw unreadable\(e\); \}/, 'a failed read is an error, never "account mode"');
    assert.ok(!/catch\s*\{\s*return null;?\s*\}/.test(stored), 'no read failure returns null');
    const upload = cb.slice(cb.indexOf('export function uploadCloudBackup'), cb.indexOf('async function uploadCloudBackupUsing'));
    assert.match(upload, /backupLock\(/, 'uploads share the switch lock');
    assert.match(upload, /pendingMarker\.clear\(\)/, 'a successful upload settles an unfinished switch');
    const bodyOf = (fn: string) => {
      const at = cb.search(new RegExp(`export (async )?function ${fn}\\b`));
      assert.ok(at >= 0, `${fn} exists`);
      return cb.slice(at, cb.indexOf('\n}\n', at));
    };
    for (const fn of ['backupToGoogleDrive', 'writeLocalBackup', 'enableE2EEBackup', 'disableE2EEBackup',
      'restoreCloudBackup', 'restoreFromGoogleDrive', 'restoreLocalBackup', 'confirmRecoveryKey']) {
      assert.ok(bodyOf(fn).includes('backupLock('), `${fn} runs under the lock`);
    }
    // N1: nothing that can replace an online copy runs before the decision.
    for (const fn of ['uploadCloudBackup', 'backupToGoogleDrive', 'enableE2EEBackup', 'disableE2EEBackup']) {
      const b = bodyOf(fn);
      assert.ok(b.includes('assertRestoreDecided()'), `${fn} refuses on an undecided phone`);
      if (fn.endsWith('E2EEBackup')) {
        assert.ok(b.indexOf('assertRestoreDecided') < b.indexOf('switchBackupSecret'), `${fn} checks before the switch sets its marker`);
      }
    }
    assert.ok(!bodyOf('writeLocalBackup').includes('assertRestoreDecided'), 'a local file replaces nothing, so it is allowed');
    // The interactive Google sign-in happens before the lock is taken.
    const drive = bodyOf('backupToGoogleDrive');
    assert.ok(drive.indexOf('getDriveToken(true)') < drive.indexOf('backupLock('), 'sign in outside the lock');
    assert.match(drive, /driveUpload\(blob, false\)/, 'and only silently under it');
    // N2: the pair is adopted before the restore writes anything, and a restore clears the decision.
    const apply = cb.slice(cb.indexOf('async function applyEncryptedBackup'), cb.indexOf('// ── Cloud (zero-knowledge'));
    assert.ok(apply.indexOf('adoptRestoredSecret(e2eeSlot, pair)') > 0
      && apply.indexOf('adoptRestoredSecret') < apply.indexOf('AsyncStorage.multiSet'), 'adopt before any write');
    assert.ok(apply.includes('resolveRestoreDecision()'), 'a successful restore settles the decision');
    // R1: the transfers under the lock have deadlines.
    const using = cb.slice(cb.indexOf('async function uploadCloudBackupUsing'), cb.indexOf('export function restoreCloudBackup'));
    assert.equal((using.match(/withDeadline\(/g) ?? []).length, 2, 'presigned PUT and inline PUT are bounded');
    assert.ok(!/await fetch\(/.test(using), 'no bare fetch under the lock');
    assert.ok(!/vaultEncrypt\(|vaultDecrypt\(/.test(cb), 'backups derive keys with the async KDF');
    assert.ok(cb.includes('SWITCH_PENDING_KEY, RESTORE_PENDING_KEY]);'), 'neither marker ever rides along in a bundle');
  }

  // ── Key ids (the real lib/backupCrypto + lib/vaultCrypto) ──────────────
  // Copied in-repo with only the RN random-values polyfill stripped, as
  // backupCrypto.selftest does.
  const WORK = join(HERE, '..', `.selftest-backupswitch-${process.pid}`);
  mkdirSync(WORK, { recursive: true });
  try {
    writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');
    for (const f of ['vaultCrypto.ts', 'backupCrypto.ts']) {
      const src = readFileSync(join(HERE, f), 'utf8').replace(/^import 'react-native-get-random-values';$/m, '');
      writeFileSync(join(WORK, f), src);
    }
    const BC = await import(pathToFileURL(join(WORK, 'backupCrypto.ts')).href);
    const VC = await import(pathToFileURL(join(WORK, 'vaultCrypto.ts')).href);
    const k1 = BC.generateRecoveryKey(), k2 = BC.generateRecoveryKey();
    const h1 = BC.newHeader('key', k1), h2 = BC.newHeader('key', k2);
    assert.equal(h1.salt, '');
    assert.match(h1.kid, /^[0-9a-f]{16}$/, 'key headers carry a 16-hex key id');
    assert.notEqual(h1.kid, h2.kid, 'a new key gets a new id');
    assert.equal(BC.recoveryKeyId(BC.formatRecoveryKey(k1).toUpperCase()), h1.kid, 'id ignores display spacing and case');
    assert.ok(!k1.includes(h1.kid), 'the id is not a slice of the key');
    assert.equal(BC.newHeader('password').kid, undefined);

    // "Make a new key", then restore an older copy: the device's new key is
    // NOT offered to it — the user is asked for the old one.
    assert.equal(BC.heldSecretMayOpen(h2, h1), false, 'old copy, new key: ask');
    assert.equal(BC.heldSecretMayOpen(h1, h1), true);
    const legacy = { ...h1 }; delete legacy.kid;
    assert.equal(BC.heldSecretMayOpen(h2, legacy), true, 'a pre-id copy is tried…');
    const blob = BC.stampE2EEHeader(VC.vaultEncrypt(BC.backupSecret(legacy, k1), 'bundle'), legacy);
    assert.throws(() => VC.vaultDecrypt(BC.backupSecret(h2, k2), JSON.parse(blob)), '…and the wrong key fails to decrypt (cloudBackup then asks)');
    assert.equal(VC.vaultDecrypt(BC.backupSecret(legacy, k1), JSON.parse(blob)), 'bundle', 'the old key still opens it');
    // Passwords: the salt decides.
    const p1 = BC.newHeader('password'), p2 = BC.newHeader('password');
    assert.equal(BC.heldSecretMayOpen(p1, p2), false);
    assert.equal(BC.heldSecretMayOpen(p1, p1), true);
    assert.equal(BC.heldSecretMayOpen(p1, h1), false, 'mode mismatch: ask');
  } finally {
    rmSync(WORK, { recursive: true, force: true });
  }

  console.log('backupSecretSwitch selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
