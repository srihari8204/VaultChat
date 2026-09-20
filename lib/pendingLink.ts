// lib/pendingLink.ts — hold the launch deep link across the auth gate.
//
// THE BUG THIS EXISTS FOR
// app/_layout.tsx's launch gate does router.replace('/onboard') or
// '/app-lock' on any cold launch that is not already signed-in-and-unlocked --
// including from its own .catch(), so a SecureStore hiccup lands there too.
// Nothing preserved the URL the app was launched WITH, so it was gone: the
// person tapped a link, got the lock screen, unlocked, and arrived at Chats
// with no idea the link had ever been honoured.
//
// This was found chasing `vaultchat://emergency-sos`, but SOS was never
// special. EVERY deep link into a signed-out or locked app was discarded the
// same way -- an invite, a chat, a call. Fixing it per-route would have fixed
// one of them.
//
// WHY A MODULE AND NOT STATE
// The stash happens in the root layout effect and the replay happens in
// lib/authNav.ts's resetTo, which is called from app-lock and mpin-entry --
// different trees, and the navigator is replaced in between, so React state
// does not survive the trip. Module scope does, and it dies with the process,
// which is exactly the lifetime a "link this launch arrived with" should have.
//
// It is deliberately NOT persisted. A link stashed on Monday must not fire on
// Tuesday's launch; if the app is killed before auth completes, the link is
// meant to be lost.

/** The pending in-app path, e.g. "/emergency-sos". Null once consumed. */
let pending: string | null = null;

/**
 * A URL is worth replaying only if it names a screen. `vaultchat://` on its own
 * is the launcher icon's own URL on some Android skins, and replaying that
 * would navigate to "/" and fight the gate.
 *
 * Kept to a hand-written parse rather than expo-linking's: this runs on the
 * cold-start path, and the only thing needed is the path and query of a URL the
 * OS already handed us. Both app schemes are accepted (app.json declares
 * "vaultchat" and "crazzychat") plus the https deep-link host, so a link that
 * works from a browser works here too.
 */
export function pathFromLaunchUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // ALREADY A PATH. This is the normal case: app/_layout.tsx hands us
  // usePathname(), because expo-router has already resolved the launch URL by
  // the time the gate's effect runs. Full URLs are still accepted so the
  // function stays usable from anywhere (and testable without a router).
  if (url.startsWith('/')) {
    const p = url.split('#')[0];
    return p === '/' || p === '' ? null : p;
  }
  const m = /^(?:vaultchat|crazzychat):\/\/|^https?:\/\/[^/]+/i.exec(url);
  if (!m) return null;
  let rest = url.slice(m[0].length);
  // A scheme URL puts the screen in the HOST position (vaultchat://settings),
  // an https one in the path (https://host/settings). Normalising to a leading
  // slash makes both the same thing to the router.
  if (!rest.startsWith('/')) rest = '/' + rest;
  // "/" alone, or an empty tail, is the launcher, not a destination.
  const justPath = rest.split('#')[0];
  if (justPath === '/' || justPath === '') return null;
  return justPath;
}

/**
 * Remember where this launch was trying to go, before the gate redirects away.
 * Call it only on the signed-out / locked branches: a launch that is allowed
 * through needs nothing, because expo-router routes the initial URL itself.
 */
export function stashLaunchLink(url: string | null | undefined): void {
  const path = pathFromLaunchUrl(url);
  if (path) pending = path;
}

/**
 * Take the pending path, if any. CONSUMES it: a second call returns null, so a
 * replay can never loop, and a later sign-out cannot resurrect a link the user
 * has already been shown.
 */
export function consumeLaunchLink(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Drop it unread — for a sign-out, where the pending link is no longer theirs. */
export function clearLaunchLink(): void {
  pending = null;
}
