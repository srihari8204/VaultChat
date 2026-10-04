// lib/launchGate.ts — the root layout's launch decision, awaitable from anywhere.
//
// WHY THIS EXISTS
// ---------------
// app/index.tsx and app/_layout.tsx both redirected on cold start, independently
// and asynchronously, and WHICHEVER RESOLVED LAST WON:
//
//   _layout: Promise.all([setSecure, getLaunchSessionState, isMfaEnabled])
//            -> router.replace('/onboard' | '/app-lock'), or launchGate 'allow'
//   index:   await shouldCheckRestore()
//            -> router.replace('/restore-backup' | '/(tabs)/chats')
//
// index usually won, because shouldCheckRestore opens SQLite. Two consequences,
// both bad:
//
//   1. THE LOCK GATE WAS BYPASSED. A user with MFA on, or a sealed session, was
//      sent to /app-lock and then overwritten onto /(tabs)/chats.
//   2. THE LAUNCH WEDGED. _layout computes
//        launchReady = launchGate === 'allow' || launchGate === pathname
//      and paints an opaque full-screen veil while !launchReady. With launchGate
//      '/app-lock' and pathname '/(tabs)/chats' those can never be equal, so the
//      veil stayed up for the rest of the launch and SplashScreen.hideAsync was
//      never called.
//
// THE ROOT OWNS THE DECISION, and must: app/_layout.tsx:229-232 explains that an
// initial deep link bypasses `/` entirely and never mounts index.tsx, so index
// structurally cannot be the owner.
//
// WHY A PROMISE AND NOT A SECOND SESSION READ
// -------------------------------------------
// The obvious fix — have index re-derive the gate — is forbidden by this repo's
// own guardrail. lib/startupColdPath.selftest.ts asserts:
//
//   'root gate uses one session snapshot':
//      layout.includes('getLaunchSessionState()') && !index.includes(...)
//
// One snapshot, one decision, one redirect. So the layout publishes its verdict
// here and index waits on it instead of racing it.
//
// ponytail: a bare promise, no store, no context. It is one boolean that is
// written once per launch and read once.

import { resetLaunchRouted } from './pendingLink';

let settle!: (allowed: boolean) => void;

/**
 * Resolves once the root gate has decided, for the FIRST root mount of this
 * JS process (it settles once; see "Per root mount" below for later mounts).
 *
 * `true`  — this launch may proceed to the app.
 * `false` — the root has ALREADY replaced the cold-start route (with /onboard
 *           or /app-lock) and the caller must not navigate. A later visit to
 *           '/' routes itself through lib/pendingLink.ts `splashNext`.
 */
export const launchAllowed: Promise<boolean> = new Promise((r) => { settle = r; });

// ── Per root mount ───────────────────────────────────────────────────────
//
// The root gate effect runs once per MOUNT of the root layout, and the React
// tree can remount while the JS process survives (Android activity
// re-creation). launchAllowed has settled by then and says how the PREVIOUS
// mount decided. app/index.tsx mounted under the remount used to read
// "decided" from a process flag and route by that stale answer in parallel
// with the new gate's own replace — e.g. into Chats while the new gate sends
// the launch to /app-lock, which also left the veil up (launchGate !==
// pathname). So the root re-arms a fresh decision during its first render
// (before any child renders), and index waits for that one.

let mount: { decision: Promise<boolean>; settle: (allowed: boolean) => void; settled: boolean } = {
  decision: launchAllowed,
  settle: (allowed) => settle(allowed),
  settled: false,
};

/**
 * app/_layout.tsx, once per root mount, during its first render. The first
 * mount (and a mount whose decision is still pending) keeps the current
 * decision; a remount after a settled one starts a new, pending decision.
 */
export function beginLaunchGate(): void {
  if (!mount.settled) return;
  let s!: (allowed: boolean) => void;
  const decision = new Promise<boolean>((r) => { s = r; });
  mount = { decision, settle: s, settled: false };
  resetLaunchRouted(); // the previous mount's index routed, not this one's
}

/** True until THIS root mount's gate has decided: index's cold-start visit. */
export function launchGatePending(): boolean { return !mount.settled; }

/** This root mount's decision; same meaning as launchAllowed. */
export function currentLaunchDecision(): Promise<boolean> { return mount.decision; }

/**
 * Called by app/_layout.tsx on EVERY settlement of its gate — both redirect
 * branches, the allow branch, and the catch — on every root mount.
 *
 * Deliberately no timeout: a timeout on an auth gate fails OPEN, which is the
 * bug this file removes. If the gate never settles, the veil stays up and the
 * app does not proceed — the same behaviour as today, minus the bypass.
 */
export function settleLaunchGate(allowed: boolean): void {
  settle(allowed); // the first mount's answer; a no-op once settled
  mount.settled = true;
  mount.settle(allowed);
}

// THE SAME WEDGE HAD A SECOND FORM, fixed in app/_layout.tsx (2026-09-19).
// The header above describes launchGate '/app-lock' never equalling pathname
// '/(tabs)/chats'. The index.tsx race was one way to get there; the other was
// simply the user navigating — onboard → mpin-entry, or app-lock → chats after
// unlocking — because that equality was re-checked on every route change while
// launchGate itself is set once per launch. The root now latches the veil down
// once the redirect has landed. Nothing in this file is involved; noted here so
// the next reader of the header does not conclude the race fix was the whole
// story.
