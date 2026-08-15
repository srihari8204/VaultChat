// lib/ringTracker.ts — which caller we're currently showing the incoming-call
// screen for. Lets the root layout de-dupe the caller's repeated call_incoming
// "ring" packets (re-sent every few seconds so a woken/killed device can still
// catch the offer) instead of stacking a new screen each time.

let ringingPeer: string | null = null;

export function setRingingPeer(p: string | null): void { ringingPeer = p; }
export function getRingingPeer(): string | null { return ringingPeer; }

// WHICH PEER ACTUALLY HAS A RING SCREEN ON STACK — not the same thing as
// ringingPeer, and conflating the two removed the ring screen entirely.
//
// ringingPeer is set the moment a call_incoming arrives, BEFORE the branch that
// decides between the in-app screen and an OS notification. So on a backgrounded
// device it is set while only a notification exists. Guarding the router push on
// it therefore refused to open the screen when the user finally tapped that
// notification — the call rang, the tap did nothing.
//
// This one is set ONLY by the code that pushes /incoming-call, and cleared when
// that screen unmounts, so "is a ring screen already up?" has an honest answer.
let ringScreenPeer: string | null = null;

export function setRingScreenPeer(p: string | null): void { ringScreenPeer = p; }
export function getRingScreenPeer(): string | null { return ringScreenPeer; }

// A call action chosen from a notification while the app wasn't foregrounded —
// consumed once the app is up so it can route/act on it.
export type PendingCall = { action: 'answer' | 'decline'; data: any };
let pendingCall: PendingCall | null = null;
export function setPendingCall(p: PendingCall | null): void { pendingCall = p; }
export function consumePendingCall(): PendingCall | null { const p = pendingCall; pendingCall = null; return p; }

export default {};
