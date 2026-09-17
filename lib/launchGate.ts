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

let settle!: (allowed: boolean) => void;

/**
 * Resolves once the root gate has decided.
 *
 * `true`  — this launch may proceed to the app.
 * `false` — the root has ALREADY replaced the route (with /onboard or
 *           /app-lock) and the caller must not navigate.
 */
export const launchAllowed: Promise<boolean> = new Promise((r) => { settle = r; });

/**
 * Called by app/_layout.tsx on EVERY settlement of its gate — both redirect
 * branches, the allow branch, and the catch.
 *
 * Deliberately no timeout: a timeout on an auth gate fails OPEN, which is the
 * bug this file removes. If the gate never settles, the veil stays up and the
 * app does not proceed — the same behaviour as today, minus the bypass.
 */
export function settleLaunchGate(allowed: boolean): void { settle(allowed); }
