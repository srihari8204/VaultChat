// lib/restoreDecision.selftest.ts — run: npx tsx lib/restoreDecision.selftest.ts
//
// "May this phone's backups replace the online copies yet?" (lib/restoreDecision),
// with the three holes rerate7 found in the first version: D1 (pending only when
// the restore screen was shown), D2 (a fallback restore settled it), D3 (a
// Drive-only copy was never asked about).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  restoreDecision, RESTORE_PENDING_KEY, RESTORE_SETTLED_KEY, BACKUP_SETTINGS_KEY, type CopyState,
} from './restoreDecision';

const HERE = dirname(fileURLToPath(import.meta.url));

function rig(init: Record<string, string> = {}) {
  const store: Record<string, string> = { ...init };
  const st = {
    store,
    account: { exists: false } as CopyState,
    drive: { exists: false } as CopyState,
    asked: [] as string[],
    failReads: false,
    failWrites: false,
  };
  const d = restoreDecision({
    storage: {
      async getItem(k) { if (st.failReads) throw new Error('read'); return store[k] ?? null; },
      async setItem(k, v) { if (st.failWrites) throw new Error('write'); store[k] = v; },
      async removeItem(k) { if (st.failWrites) throw new Error('write'); delete store[k]; },
    },
    async accountCopy() { st.asked.push('account'); return st.account; },
    async driveCopy() { st.asked.push('drive'); return st.drive; },
  });
  return { st, d };
}
const settings = (lastBackupAt: number) => ({ [BACKUP_SETTINGS_KEY]: JSON.stringify({ frequency: 'daily', lastBackupAt }) });

(async () => {
  // ── D1: no screen needed. A fresh install (nothing stored) is undecided. ──
  {
    const { st, d } = rig();
    assert.equal(await d.undecided(), true, 'fresh install: undecided without any flag');
    st.account = { exists: true };
    assert.equal(await d.pending(), true, 'fresh install + account copy: uploads wait');
    assert.ok(st.store[RESTORE_PENDING_KEY], 'and the flag is now set, so screens show the pause');
  }
  {
    const { st, d } = rig();
    st.account = { exists: false, unavailable: true };
    assert.equal(await d.pending(), true, 'fresh install, server unreachable: uploads wait');
    assert.deepEqual(st.asked, ['account'], 'a failed account lookup already decides; Drive is not needed');
  }
  {
    const { st, d } = rig({ ...settings(0) });
    assert.equal(await d.pending(), false, 'fresh install, no copy anywhere: uploads may run');
    assert.deepEqual(st.asked, ['account', 'drive']);
    assert.equal(st.store[RESTORE_PENDING_KEY], undefined);
    await d.uploaded();
    st.asked = []; st.account = { exists: true };
    assert.equal(await d.pending(), false, 'after its first upload the install is established');
    assert.deepEqual(st.asked, [], 'and is never asked again (no network on every run)');
  }
  {
    const { st, d } = rig({ ...settings(Date.now() - 3600e3) });
    st.account = { exists: true };
    assert.equal(await d.undecided(), false, 'an install from before this rule that has backed up is established');
    assert.equal(await d.pending(), false);
    assert.deepEqual(st.asked, []);
  }
  {
    const { st, d } = rig({ [BACKUP_SETTINGS_KEY]: '{not json' });
    st.account = { exists: true };
    assert.equal(await d.pending(), true, 'unreadable settings: undecided (fail closed)');
  }
  {
    const { st, d } = rig({ [RESTORE_SETTLED_KEY]: 'account' });
    st.failReads = true;
    assert.equal(await d.undecided(), true, 'unreadable storage: undecided (fail closed)');
    st.account = { exists: true };
    assert.equal(await d.pending(), true);
  }

  // ── Explicit choices settle it; a failed write to settle throws. ──
  {
    const { st, d } = rig();
    await d.markPending();
    await d.settleAccount();
    assert.equal(st.store[RESTORE_SETTLED_KEY], 'account');
    assert.equal(st.store[RESTORE_PENDING_KEY], undefined);
    st.account = { exists: true };
    assert.equal(await d.pending(), false, '"Start fresh" / "Replace": uploads may replace the online copy');
  }
  {
    const { st, d } = rig();
    await d.markPending();
    st.failWrites = true;
    await assert.rejects(d.settleAccount(), /write/, 'a Replace that could not be recorded throws, so nothing uploads');
    st.failWrites = false;
    st.account = { exists: true };
    assert.equal(await d.pending(), true, 'and the phone is still pending');
  }

  // ── D2: only the ACCOUNT copy settles a restore. ──
  {
    const { st, d } = rig();
    await d.markPending();
    await d.restored('account');
    st.account = { exists: true };
    assert.equal(await d.pending(), false, 'restored the account copy: uploads may run');
  }
  for (const from of ['drive', 'local'] as const) {
    const { st, d } = rig({ ...settings(Date.now()), [RESTORE_SETTLED_KEY]: 'account' });
    await d.restored(from);
    assert.ok(st.store[RESTORE_PENDING_KEY], `${from} restore: flag set (even on an established install)`);
    st.account = { exists: false, unavailable: true };
    assert.equal(await d.pending(), true, `${from} restore while offline: the newer account copy stays protected`);
    st.account = { exists: true };
    assert.equal(await d.pending(), true, `${from} restore with an account copy: still pending until restored or replaced`);
    await d.settleAccount();
    assert.equal(await d.pending(), false, `${from} restore, then an explicit Replace: uploads run`);
  }
  {
    const { st, d } = rig();
    await d.restored('drive');
    st.drive = { exists: true };
    assert.equal(await d.pending(), false, 'Drive restore, no account copy: the Drive copy is the one restored, nothing to protect');
    assert.deepEqual(st.asked, ['account'], 'Drive is not asked about the copy this phone restored');
  }
  {
    const { st, d } = rig();
    await d.restored('local');
    st.drive = { exists: true };
    assert.equal(await d.pending(), true, 'device-file restore, no account copy, a Drive copy: that Drive copy stays protected');
  }

  // ── D3: a linked Drive is asked; unreadable counts as a copy. ──
  {
    const { st, d } = rig();
    st.drive = { exists: true };
    assert.equal(await d.pending(), true, 'Drive-only copy is protected');
  }
  {
    const { st, d } = rig();
    st.drive = { exists: false, unavailable: true };
    assert.equal(await d.pending(), true, 'linked Drive that could not be checked: fail safe');
  }
  {
    const { st, d } = rig();
    st.drive = { exists: false };
    assert.equal(await d.pending(), false, 'no linked Drive (or none there): nothing to protect');
  }
  {
    const { st, d } = rig();
    const throwing = restoreDecision({
      storage: { async getItem(k) { return st.store[k] ?? null; }, async setItem(k, v) { st.store[k] = v; }, async removeItem(k) { delete st.store[k]; } },
      async accountCopy() { return { exists: false }; },
      async driveCopy() { throw new Error('boom'); },
    });
    assert.equal(await throwing.pending(), true, 'a Drive lookup that throws counts as unavailable');
    void d;
  }
  // A lookup the caller already made is reused (no second request).
  {
    const { st, d } = rig();
    assert.equal(await d.pending({ exists: true }), true);
    assert.deepEqual(st.asked, [], 'the passed account meta is used');
  }

  // ── Wiring ──
  const sched = readFileSync(join(HERE, 'backupScheduler.ts'), 'utf8');
  assert.match(sched, new RegExp(`const SETTINGS_KEY = '${BACKUP_SETTINGS_KEY}';`), 'the settings key matches lib/backupScheduler');
  assert.ok(/if \(await restoreDecisionPending\(\)\) return;/.test(sched), 'the scheduler skips its run while pending');
  const cb = readFileSync(join(HERE, 'cloudBackup.ts'), 'utf8');
  assert.ok(cb.includes('SWITCH_PENDING_KEY, RESTORE_PENDING_KEY, RESTORE_SETTLED_KEY]);'), 'the decision keys never ride along in a bundle');
  assert.ok(cb.includes("applyEncryptedBackup(blob, userSecret, 'account')") && cb.includes("applyEncryptedBackup(blob, userSecret, 'drive')")
    && cb.includes("applyEncryptedBackup(blob, userSecret, 'local')"), 'each restore names the copy it applied');
  assert.ok(cb.includes('decision.restored(from)') && !/applyEncryptedBackup[\s\S]*?resolveRestoreDecision\(\)[\s\S]*?\/\/ ── Cloud/.test(cb),
    'a restore settles only through decision.restored(from)');
  assert.ok(/driveCopy: driveBackupMeta/.test(cb), 'Drive is part of the decision');
  const gd = readFileSync(join(HERE, 'googleDrive.ts'), 'utf8');
  assert.ok(/linked \? \{ exists: false, unavailable: true \} : \{ exists: false \}/.test(gd), 'a linked Drive that cannot be read is unavailable, not "none"');

  // Screens (rerate7 D2/D3 and chat-backup's Still-needed 1–2).
  const cbScreen = readFileSync(join(HERE, '..', 'app', 'chat-backup.tsx'), 'utf8');
  assert.match(cbScreen, /if \(src === 'cloud' && !only && !isNoBackup\(e\)\) \{ offerOlderCopy\(e\); return; \}/,
    'chat-backup: an account copy that failed (offline, busy, timeout) is not silently passed over for an older one');
  assert.match(cbScreen, /const paused = from !== 'cloud' && await restoreDecisionPending\(\)/, 'chat-backup: a fallback restore says backups stay paused');
  assert.match(cbScreen, /'Replace online copy'/, 'chat-backup: and offers the explicit replace');
  assert.match(cbScreen, /\{restorePending && \(\s*<View style=\{s\.notice\}>/, 'chat-backup: the paused notice shows whenever paused, not only when the meta answered');
  assert.match(cbScreen, /if \(!isRestorePending\(cloudErr\)\) \{\s*try \{ await backupToGoogleDrive\(true\)/, 'chat-backup: no Google sign-in for a Drive upload that would be refused');
  assert.match(cbScreen, /=== 'account';[\s\S]{0,400}removes that protection/, 'chat-backup: replacing from an account-key phone names the end-to-end downgrade');
  const rbScreen = readFileSync(join(HERE, '..', 'app', 'restore-backup.tsx'), 'utf8');
  assert.ok(/restoreDecisionPending\(m\)/.test(rbScreen) && !/!m\.unavailable\) resolveRestoreDecision/.test(rbScreen),
    'restore-backup: a "no backup" answer goes through the full check (Drive too), not a blind clear');

  console.log('restoreDecision selftest: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
