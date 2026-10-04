// lib/backupTransfer.selftest.ts — run: npx tsx lib/backupTransfer.selftest.ts
//
// The deadlines that keep a dead link from holding lib/cloudBackup's backup
// lock forever (rerate5 regression 1).
import assert from 'node:assert/strict';
import { transferDeadlineMs, withDeadline, MAX_TRANSFER_MS } from './backupTransfer';
import { userErrorText } from './userErrorText';

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

  // Work that ignores the signal still rejects at the deadline (a native call).
  let aborted = false;
  const started = Date.now();
  await assert.rejects(
    withDeadline(20, (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }),
    (e: any) => e?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 1000, 'rejected promptly');
  assert.ok(aborted, 'the signal fired, so an abortable fetch is cancelled too');

  // A failure inside the work passes through unchanged.
  await assert.rejects(withDeadline(50, async () => { throw new Error('backup upload failed (500)'); }), /\(500\)/);

  // The timeout reads as connection copy, never raw text.
  try { await withDeadline(5, () => new Promise(() => {})); } catch (e) {
    assert.equal(userErrorText(e, 'F'), 'Check your connection and try again.');
  }

  console.log('backupTransfer selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
