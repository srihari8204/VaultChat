// lib/ringTracker.ts — which caller we're currently showing the incoming-call
// screen for. Lets the root layout de-dupe the caller's repeated call_incoming
// "ring" packets (re-sent every few seconds so a woken/killed device can still
// catch the offer) instead of stacking a new screen each time.

let ringingPeer: string | null = null;

export function setRingingPeer(p: string | null): void { ringingPeer = p; }
export function getRingingPeer(): string | null { return ringingPeer; }

// A call action chosen from a notification while the app wasn't foregrounded —
// consumed once the app is up so it can route/act on it.
export type PendingCall = { action: 'answer' | 'decline'; data: any };
let pendingCall: PendingCall | null = null;
export function setPendingCall(p: PendingCall | null): void { pendingCall = p; }
export function consumePendingCall(): PendingCall | null { const p = pendingCall; pendingCall = null; return p; }

export default {};
