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

import { clearLaunchLink, consumeLaunchLink } from './pendingLink';

export function resetTo(href: string): void {
  // canDismiss() is false when there is nothing below us (cold start straight
  // onto this screen) — dismissAll() would throw, and there is nothing to pop.
  try { if (router.canDismiss()) router.dismissAll(); } catch { /* not a dismissable stack */ }

  // REPLAY THE LAUNCH DEEP LINK, if this crossing is INTO the app.
  //
  // The root layout's gate replaces to /onboard or /app-lock on any cold launch
  // that is not already signed in and unlocked, and a replace discards the URL
  // the app was launched with. lib/pendingLink.ts holds it; this is the one
  // chokepoint both unlock paths cross (app-lock.tsx:37, mpin-entry.tsx:43), so
  // replaying here fixes EVERY deep link rather than one route at a time.
  //
  // Direction matters. resetTo is also the SIGN-OUT crossing
  // (app-lock.tsx:89 -> '/onboard', and the delete-account path), and replaying
  // a stashed link there would drop a freshly signed-out person into a screen
  // belonging to the account they just left. So: replay only when heading into
  // the tab stack, and DROP the link on the way out — consume() and clear()
  // both leave it null, so it can never fire late.
  if (href.startsWith('/(tabs)')) {
    const pending = consumeLaunchLink();
    if (pending) {
      // replace, not push: the link is the destination of this launch, not a
      // screen stacked on top of Chats — BACK from it must exit, exactly as it
      // would have on a launch that was never redirected.
      try { router.replace(pending as any); return; } catch { /* fall through to the normal landing */ }
    }
  } else {
    clearLaunchLink();
  }

  router.replace(href as any);
}
