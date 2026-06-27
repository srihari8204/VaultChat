// lib/callState.ts — the single active call, app-wide.
//
// Lets an incoming call that arrives while you're already talking become
// "call waiting" (WhatsApp-style) instead of clobbering the current call.
// The active call screen registers itself + hold/resume/hangUp callbacks; the
// incoming-call screen reads this to offer "Hold & accept" / "End & accept".

export type ActiveCall = {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: 'audio' | 'video';
  hold: () => void;     // pause local mic/audio (peer stays connected, on hold)
  resume: () => void;   // re-enable after the other call ends
  hangUp: () => void;   // end this call entirely
};

let active: ActiveCall | null = null;

export function setActiveCall(c: ActiveCall): void { active = c; }
export function clearActiveCall(c?: ActiveCall): void {
  // Only clear if it's still the same call (avoids a late unmount wiping a newer call).
  if (!c || active === c) active = null;
}
export function getActiveCall(): ActiveCall | null { return active; }
export function holdActiveCall(): void { try { active?.hold(); } catch {} }
export function endActiveCall(): void { try { active?.hangUp(); } catch {} active = null; }

export default {};
