// lib/restoreDecision.ts — may this phone's backups replace the online copies yet?
//
// A phone that has neither restored the user's backup nor been told, plainly,
// that backing up will REPLACE it must not upload anything: the scheduler is due
// at once on a fresh install (lastBackupAt 0), so it would put the near-empty
// phone over the only copy of the user's history within seconds.
//
// Three holes in the first version of this rule (rerate7 D1–D3), and how each
// is closed here:
//
//   D1  The "pending" flag was set only when app/restore-backup was SHOWN. A
//       launch check that failed skipped the screen, set nothing, and the
//       scheduler uploaded. Now an install is undecided by DERIVATION, not by
//       the screen: no flag is needed while it has never settled the decision
//       and never completed a backup (lastBackupAt 0). Read failures count as
//       undecided.
//   D2  Any successful restore cleared the flag, including one from a fallback
//       copy (Drive or a device file, after the account copy failed for an
//       offline / timeout / busy reason). The next backup then replaced a NEWER
//       account copy with that older history — and, from an account-key Drive
//       copy, dropped end-to-end encryption. Now only the ACCOUNT copy settles
//       the decision (restored, or the user chose to replace it); a fallback
//       restore keeps it pending until the account copy is restored, replaced,
//       or definitively absent.
//   D3  Only the server was asked whether there was anything to protect. Now a
//       linked Google Drive is asked too, and a Drive that is linked but cannot
//       be read counts as holding a copy.
//
// Pure: storage and the two lookups are passed in (lib/cloudBackup wires them),
// so every path is Node-tested in restoreDecision.selftest.ts. All keys are
// device-local: lib/cloudBackup keeps them out of every backup bundle.

/** Set while uploads must wait for the user. */
export const RESTORE_PENDING_KEY = 'vc_backup_restore_pending';
/**
 * Which copy this install has dealt with: 'account' (the account copy was
 * restored, or the user chose to replace it, or this phone has uploaded since),
 * or the fallback it restored instead ('drive' / 'local').
 */
export const RESTORE_SETTLED_KEY = 'vc_backup_restore_settled';
/** Must equal lib/backupScheduler's SETTINGS_KEY (restoreDecision.selftest checks). */
export const BACKUP_SETTINGS_KEY = 'vc_backup_settings';

export type RestoredFrom = 'account' | 'drive' | 'local';
/** A lookup answer: `unavailable` means it could not be asked, never "none". */
export interface CopyState { exists: boolean; unavailable?: true }

export interface RestoreDecisionDeps {
  storage: {
    getItem(k: string): Promise<string | null>;
    setItem(k: string, v: string): Promise<void>;
    removeItem(k: string): Promise<void>;
  };
  /** The account (server) copy. */
  accountCopy(): Promise<CopyState>;
  /** The Drive copy: `{ exists: false }` when no Google account is linked. */
  driveCopy(): Promise<CopyState>;
}

const UNKNOWN: CopyState = { exists: false, unavailable: true };

export function restoreDecision(deps: RestoreDecisionDeps) {
  const s = deps.storage;

  /**
   * Local only (no network): might this phone still owe the user a decision?
   * True when the flag is set, or when the install has never settled it and
   * never completed a backup. Fails closed.
   */
  async function undecided(): Promise<boolean> {
    try {
      if (await s.getItem(RESTORE_PENDING_KEY)) return true;
      if (await s.getItem(RESTORE_SETTLED_KEY)) return false;
      // Installs from before this rule have no settled marker; one that has
      // completed a backup is established. A restore brings the old phone's
      // lastBackupAt with it, but a restore always writes the marker too.
      const raw = await s.getItem(BACKUP_SETTINGS_KEY);
      const last = raw ? Number((JSON.parse(raw) as { lastBackupAt?: unknown })?.lastBackupAt) : 0;
      return !(last > 0);
    } catch {
      return true;
    }
  }

  /**
   * True while uploads must wait. Asks only for an undecided phone: the
   * account copy (pass `account` when it was just looked up), then a linked
   * Drive unless Drive's copy is the one this phone restored. Any copy, or any
   * lookup that failed, keeps it pending (and sets the flag, so screens show
   * it); only "none anywhere" clears the flag.
   */
  async function pending(account?: CopyState): Promise<boolean> {
    if (!(await undecided())) return false;
    const a = account ?? await deps.accountCopy().catch(() => UNKNOWN);
    let keep = !!(a.unavailable || a.exists);
    if (!keep) {
      const restored = await s.getItem(RESTORE_SETTLED_KEY).catch(() => null);
      if (restored !== 'drive') {
        const d = await deps.driveCopy().catch(() => UNKNOWN);
        keep = !!(d.unavailable || d.exists);
      }
    }
    if (keep) {
      await s.setItem(RESTORE_PENDING_KEY, String(Date.now())).catch(() => {});
      return true;
    }
    await s.removeItem(RESTORE_PENDING_KEY).catch(() => {});
    return false;
  }

  /** Shown the restore offer: wait for the user. */
  async function markPending(): Promise<void> {
    await s.setItem(RESTORE_PENDING_KEY, String(Date.now()));
  }

  /**
   * The account copy is dealt with: restored, or the user chose to replace it.
   * Throws when it could not be recorded, so a "Replace" that did not stick
   * uploads nothing. The marker goes first: a failure between the two writes
   * leaves the flag set, the safe side.
   */
  async function settleAccount(): Promise<void> {
    await s.setItem(RESTORE_SETTLED_KEY, 'account');
    await s.removeItem(RESTORE_PENDING_KEY);
  }

  /**
   * A restore was applied. Only the account copy settles the decision; a
   * fallback keeps it pending (flag set before the marker, again the safe
   * order) until the account copy is restored, replaced or found absent.
   */
  async function restored(from: RestoredFrom): Promise<void> {
    if (from === 'account') return settleAccount();
    await s.setItem(RESTORE_PENDING_KEY, String(Date.now()));
    await s.setItem(RESTORE_SETTLED_KEY, from);
  }

  /**
   * An upload to the account went through (it only runs once pending() said
   * no): this install is established. Best-effort; without it the next check
   * simply asks again.
   */
  async function uploaded(): Promise<void> {
    await s.setItem(RESTORE_SETTLED_KEY, 'account').catch(() => {});
  }

  return { undecided, pending, markPending, settleAccount, restored, uploaded };
}

export default { restoreDecision };
