// lib/securityVerdict.ts — the blocking security verdict, handed to app/blocked
// in memory instead of in the URL.
//
// app/blocked.tsx used to take `level` from its route params, so anyone could
// send `vaultchat://blocked?level=wipe` and show a "your keys were permanently
// wiped" screen with Back disabled. Route params are input from outside the
// app; a verdict is not. The in-app callers that ran the scan (app/_layout.tsx
// on launch, the Alerts tab's "Scan device") hold the report here before
// routing, and /blocked enforces only what is held. A link can open the screen
// but cannot set this, so it gets the neutral "Nothing is blocked" view.
//
// Memory only, on purpose: it dies with the process, and the next launch's scan
// sets it again if the device is still compromised.

export type BlockingLevel = 'restrict' | 'wipe';
export interface HeldVerdict {
  level: BlockingLevel;
  threats: { type: string; detail: string }[];
}

let held: HeldVerdict | null = null;

/** Hold a scan report's verdict for /blocked. Non-blocking levels hold nothing. */
export function holdSecurityVerdict(report: { level: string; threats?: { type: string; detail: string }[] }): void {
  if (report.level !== 'restrict' && report.level !== 'wipe') return;
  held = { level: report.level, threats: Array.isArray(report.threats) ? report.threats : [] };
}

/** The verdict /blocked must enforce, or null when nothing in-app reported one. */
export function securityVerdict(): HeldVerdict | null {
  return held;
}
