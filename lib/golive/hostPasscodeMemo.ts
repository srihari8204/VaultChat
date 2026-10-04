// lib/golive/hostPasscodeMemo.ts — the host's readable Private Live passcode,
// handed from app/live.tsx to app/live-view.tsx in memory.
//
// The server keeps only a bcrypt hash, so the copy the host typed is the only
// readable one, and the invite panel shows it so the host can send it on.
// It used to travel as a route param (`pc`), which puts a secret into the
// navigation state and the screen URL (`/live-view?pc=…`). Memory has the same
// lifetime the param had — gone on an app restart — without that exposure.
//
// Keyed by broadcast id, so re-opening your own broadcast from the Live list
// still shows it, and forgotten when the host ends the broadcast.

const memo = new Map<string, string>();

export function rememberHostPasscode(broadcastId: string, passcode: string): void {
  if (!broadcastId) return;
  if (passcode) memo.set(broadcastId, passcode); else memo.delete(broadcastId);
}

/** The passcode the host set for this broadcast, or '' when none is held. */
export function hostPasscodeFor(broadcastId: string): string {
  return memo.get(broadcastId) ?? '';
}

export function forgetHostPasscode(broadcastId: string): void {
  memo.delete(broadcastId);
}
