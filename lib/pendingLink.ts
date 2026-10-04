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
  // usePathname() + its query (hrefWithQuery below), because expo-router has
  // already resolved the launch URL by the time the gate's effect runs, and
  // notification taps hand us the href they would have pushed. Full URLs are
  // still accepted so the function stays usable from anywhere (and testable
  // without a router).
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

/**
 * `pathname` plus the QUERY of the route it names, as one replayable href.
 *
 * usePathname() carries no query, so a stashed `vaultchat://broadcast?code=X`
 * came back after unlock as a bare "/broadcast" and the invite code was gone.
 * The root layout passes useGlobalSearchParams() and useSegments() here.
 * Dynamic-segment params (`[code]`, `[...segments]`) are already IN the path,
 * so they are skipped rather than repeated as `?code=`.
 */
export function hrefWithQuery(
  pathname: string,
  params: Record<string, string | string[] | undefined> | null | undefined,
  segments: readonly string[] = [],
): string {
  const inPath = new Set(segments.map(s => /^\[(?:\.\.\.)?(.+)\]$/.exec(s)?.[1]).filter(Boolean));
  // Strings only: route state can also carry nested-navigator objects
  // (`params`), which are not part of any URL.
  const q = Object.entries(params ?? {})
    .filter(([k]) => !inPath.has(k))
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string')
      .map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x as string)}`))
    .join('&');
  return q ? `${pathname}?${q}` : pathname;
}

// ── Notification taps while the app is locked ─────────────────────────────
//
// A notification tap used to router.push() its screen whenever it fired. On a
// cold start that raced the launch gate's replace('/app-lock' | '/onboard'), and
// on resume it raced components/ResumeLock's push('/app-lock') — either way a
// chat or family-alert screen could land ON TOP of the lock or sign-in. Taps now
// go through openWhenUnlocked: opened only once nothing is locking, otherwise
// held in the same slot as a launch link and replayed after unlock
// (lib/authNav.resetTo on the cold path, app/app-lock's enter() on resume).

/** Routes that are a lock, a verdict, or the sign-in flow: nothing opens over them. */
const LOCK_OR_AUTH = /^\/(app-lock|onboard[\w-]*|email-verify|mpin-entry|mpin-recover|blocked)(\/|$)/;
export function isLockOrAuthRoute(path: string | null | undefined): boolean {
  return LOCK_OR_AUTH.test(path ?? '');
}

/** The in-flight resume-lock decision; true = the lock is going up. */
let resumeLock: Promise<boolean> = Promise.resolve(false);
/** components/ResumeLock publishes each resume's decision before acting on it. */
export function setResumeLockCheck(check: Promise<boolean>): void {
  resumeLock = check.catch(() => false);
}

/**
 * Open `href` once the launch gate has decided and nothing is locking now;
 * otherwise hold it for replay after unlock.
 *
 * `launch` settles ONCE per process, so `false` means only "this launch was sent
 * to the lock or sign-in", not "still locked". After the user unlocks or signs
 * in, later taps must open, so the current route decides. While the launch was
 * redirected, the root path ('/', the veil) still counts as locked: the
 * redirect may not have reached the router yet.
 */
export async function openWhenUnlocked(
  href: string,
  launch: Promise<boolean>,
  currentPath: () => string | null | undefined,
  open: (href: string) => void,
): Promise<void> {
  const [allowed, relocking] = await Promise.all([launch, resumeLock]);
  const path = currentPath();
  const stillGated = isLockOrAuthRoute(path) || (!allowed && (!path || path === '/'));
  if (!relocking && !stillGated) open(href);
  else stashLaunchLink(href);
}
