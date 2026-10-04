// lib/backupTransfer.selftest.ts — run: npx tsx lib/backupTransfer.selftest.ts
//
// The deadlines that keep a dead link from holding lib/cloudBackup's backup
// lock forever (rerate5 regression 1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transferDeadlineMs, withDeadline, giveUpAfter, MAX_TRANSFER_MS, isTransferCancelled } from './backupTransfer';
import { backupErrorText } from './backupSecretSwitch';
import { userErrorText } from './userErrorText';

const HERE = dirname(fileURLToPath(import.meta.url));

(async () => {
  // Size-scaled, floored, capped; unknown size gets the cap.
  assert.equal(transferDeadlineMs(undefined), MAX_TRANSFER_MS);
  assert.equal(transferDeadlineMs(0), MAX_TRANSFER_MS);
  assert.equal(transferDeadlineMs(NaN), MAX_TRANSFER_MS);
  assert.equal(transferDeadlineMs(1), 61_000, 'a tiny body still gets the 60 s floor');
  assert.equal(transferDeadlineMs(64 * 1024 * 100), 160_000, '6.4 MB → 60 s + 100 s at 64 KB/s');
  assert.ok(transferDeadlineMs(10 * 1024 * 1024) > transferDeadlineMs(1024 * 1024), 'bigger bodies get longer');
  assert.equal(transferDeadlineMs(10 * 1024 ** 3), MAX_TRANSFER_MS, 'capped');

  // Work that finishes in time resolves with its value, and the timer is cleared.
  assert.equal(await withDeadline(50, async () => 'ok'), 'ok');

  // The deadline aborts and then WAITS for the work to settle, so the lock is
  // never released under a transfer that is still running (rerate7 regression 3).
  let aborted = false;
  let settled = false;
  const started = Date.now();
  await assert.rejects(
    withDeadline(20, (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        // An abortable fetch settles on abort; this one takes a little longer.
        setTimeout(() => { settled = true; reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }, 30);
      });
    })),
    (e: any) => e?.name === 'TimeoutError',
  );
  assert.ok(aborted, 'the signal fired, so an abortable fetch is cancelled');
  assert.ok(settled, 'withDeadline rejected only after the work itself settled');
  assert.ok(Date.now() - started < 1000, 'and promptly once it did');
  // A transfer that completed just as the deadline fired is reported as done.
  assert.equal(await withDeadline(5, (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('landed'));
  })), 'landed');
  // Work that ignores the signal keeps the caller waiting: it is never cut loose.
  let ignoredSettled = false;
  const ignored = withDeadline(5, () => new Promise((r) => setTimeout(() => { ignoredSettled = true; r('late'); }, 60)));
  assert.equal(await ignored, 'late');
  assert.ok(ignoredSettled, 'withDeadline did not resolve before the work did');

  // giveUpAfter (a token refresh: writes nothing) stops waiting at the deadline.
  const t0 = Date.now();
  await assert.rejects(giveUpAfter(20, () => new Promise(() => {})), (e: any) => e?.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 1000, 'gave up promptly');
  assert.equal(await giveUpAfter(50, async () => 'tok'), 'tok');
  // Only token refreshes are given up on; every transfer waits.
  const drive = readFileSync(join(HERE, 'googleDrive.ts'), 'utf8');
  assert.equal((drive.match(/giveUpAfter\(/g) ?? []).length, 1, 'giveUpAfter is used once in googleDrive (the silent token)');
  assert.match(drive, /giveUpAfter\(SMALL_REQUEST_MS, \(\) => getDriveToken\(false\)\)/);
  const cb = readFileSync(join(HERE, 'cloudBackup.ts'), 'utf8');
  assert.ok(!cb.includes('giveUpAfter'), 'no cloudBackup transfer is given up on');

  // A failure inside the work passes through unchanged.
  await assert.rejects(withDeadline(50, async () => { throw new Error('backup upload failed (500)'); }), /\(500\)/);

  // The timeout reads as connection copy, never raw text.
  try { await withDeadline(5, (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted'))))); } catch (e) {
    assert.equal(userErrorText(e, 'F'), 'Check your connection and try again.');
  }

  // A person's Stop (backup-e2ee): aborts the work, waits for it, rejects BACKUP_CANCELLED.
  const stop = new AbortController();
  let workAborted = false;
  const stopped = withDeadline(10_000, (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { workAborted = true; reject(new Error('Aborted')); });
  }), stop.signal);
  stop.abort();
  await assert.rejects(stopped, (e: any) => isTransferCancelled(e));
  assert.ok(workAborted, 'Stop aborted the transfer itself');
  let ran = false;
  await assert.rejects(withDeadline(10_000, async () => { ran = true; return 1; }, stop.signal), (e: any) => isTransferCancelled(e));
  assert.ok(!ran, 'an already-stopped transfer never starts');
  assert.equal(backupErrorText(Object.assign(new Error('x'), { code: 'BACKUP_CANCELLED' })), 'You stopped the upload.');
  // Only the upload under the NEW pair is stoppable; the roll-back never is.
  const cbSrc = readFileSync(join(HERE, 'cloudBackup.ts'), 'utf8');
  assert.equal((cbSrc.match(/uploadCloudBackupUsing\(using, stoppable\(using, (next|null), opts\.signal\)\)/g) ?? []).length, 2, 'both switches pass Stop through stoppable()');
  assert.match(cbSrc, /return using === next \? signal : undefined;/);
  assert.equal((cbSrc.match(/\}\), cancel\);|signal \}\), cancel\);/g) ?? []).length, 2, 'both PUTs honour Stop');

  console.log('backupTransfer selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
