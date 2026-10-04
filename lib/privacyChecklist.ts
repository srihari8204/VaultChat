// lib/privacyChecklist.ts — the Privacy Dashboard's checklist and score.
//
// Every row is a fact the app can check, and each one names the screen where
// it is changed. The old dashboard kept Face Lock, Biometric Lock, 2FA,
// Screenshot Protection, "About" and "Online status" as AsyncStorage flags that
// nothing else read, so flipping them moved the score and protected nothing.
//
// The score is the share of APPLICABLE rows that pass. A row the platform
// cannot provide (screenshot blocking on iOS) is `null` and left out of the
// denominator rather than counted as a failure or a pass — the same rule as
// services/security/securityScore.ts.
//
// A fact whose source failed to load is 'unknown' and is also left out of the
// score — one failing request degrades its own row, not the whole dashboard.

/** true = on, false = off, null = the platform cannot provide it, 'unknown' = could not be checked. */
export type FactValue = boolean | null | 'unknown';

export interface PrivacyFacts {
  /** Direct chats are end-to-end encrypted in this build (E2EE_ENABLED). */
  e2ee: boolean;
  /** Screenshots and recordings are blocked (Android FLAG_SECURE, as setSecure reports it); null where the OS cannot. */
  screenshotsBlocked: FactValue;
  /** Device MFA (biometric / device PIN at launch), lib/mfa. */
  deviceMfa: FactValue;
  /** A device PIN is set (services/security/pinStore). */
  pinSet: FactValue;
  /** At least one trusted contact for account recovery. */
  trustedContacts: FactValue;
  /** Last seen hidden — server setting. */
  lastSeenHidden: FactValue;
  /** Read receipts off — server setting. */
  readReceiptsOff: FactValue;
}

export interface ChecklistRow {
  key: keyof PrivacyFacts;
  label: string;
  /** true = on, false = off, null = not available on this device, 'unknown' = could not be checked. */
  on: FactValue;
  /** Fixed by the build or the OS — shown, but there is nothing to change. */
  fixed: boolean;
  /** Where the user changes it (when not fixed). */
  route?: string;
  /** What to do when it is off. */
  suggestion?: string;
}

const ROWS: Omit<ChecklistRow, 'on'>[] = [
  { key: 'e2ee', label: 'End-to-end encryption', fixed: true },
  { key: 'screenshotsBlocked', label: 'Screenshot blocking', fixed: true },
  { key: 'deviceMfa', label: 'Device MFA at launch', fixed: false, route: '/settings',
    suggestion: 'Turn on Device MFA in Settings → Security to require your fingerprint, face or PIN at launch.' },
  { key: 'pinSet', label: 'Device PIN', fixed: false, route: '/backup-pin?from=settings',
    suggestion: 'Set a device PIN to lock this session behind a PIN only you know.' },
  { key: 'trustedContacts', label: 'Trusted contacts', fixed: false, route: '/trusted-contacts',
    suggestion: 'Add trusted contacts who can help you recover your account.' },
  { key: 'lastSeenHidden', label: 'Last seen hidden', fixed: false, route: '/last-seen-privacy',
    suggestion: 'Hide your last seen so others cannot track when you are active.' },
  { key: 'readReceiptsOff', label: 'Read receipts off', fixed: false, route: '/last-seen-privacy',
    suggestion: 'Turn off read receipts. You also stop seeing other people’s.' },
];

export function privacyChecklist(f: PrivacyFacts): ChecklistRow[] {
  return ROWS.map((r) => ({ ...r, on: f[r.key] }));
}

/** 0–100: share of applicable, checked rows that are on. */
export function privacyScore(rows: readonly ChecklistRow[]): number {
  const applicable = rows.filter((r) => typeof r.on === 'boolean');
  if (applicable.length === 0) return 0;
  return Math.round((applicable.filter((r) => r.on === true).length / applicable.length) * 100);
}
