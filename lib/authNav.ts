// lib/authNav.ts — crossing the sign-in boundary must not leave the old stack
// underneath.
//
// router.replace() swaps the TOP history entry only. Everything pushed before
// it is still there, so:
//   • after "Continue to Chats" finished sign-up, Android BACK walked straight
//     back into onboard-security — a consumed, already-committed sign-up step;
//   • after mpin-entry signed an existing user in, BACK returned to the landing
//     form they had just left;
//   • after a sign-out or an account deletion, BACK returned INTO the
//     signed-in screen the redirect was supposed to end.
// All three were reported as "the back button takes me to old pages".
//
// dismissAll() pops to the first screen of the stack and replace() then swaps
// that one, so exactly one entry survives and BACK exits the app — which is
// what "you are now in the app" / "you are now signed out" actually means.
//
// Use this ONLY for those boundary crossings. An ordinary replace inside a flow
// (a step that consumes its predecessor) must keep the stack below it.
import { router } from 'expo-router';

export function resetTo(href: string): void {
  // canDismiss() is false when there is nothing below us (cold start straight
  // onto this screen) — dismissAll() would throw, and there is nothing to pop.
  try { if (router.canDismiss()) router.dismissAll(); } catch { /* not a dismissable stack */ }
  router.replace(href as any);
}
