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
const LOCK_OR_AUTH = /^\/(app-lock|onboard[\w-]*|phone-verify|mpin-entry|mpin-recover|blocked)(\/|$)/;
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
 * True once app/index.tsx has made its cold-start replace. Until then a tap on
 * '/' is held: index's replace('/(tabs)/chats') swaps the TOP entry, so a tap
 * pushed first was overwritten and lost. index replays the held tap itself.
 */
let launchRouted = false;
export function markLaunchRouted(): void { launchRouted = true; }

/**
 * Open `href` once the launch gate has decided and nothing is locking now;
 * otherwise hold it for replay after unlock.
 *
 * `launch` settles ONCE per process, so `false` means only "this launch was sent
 * to the lock or sign-in", not "still locked". After the user unlocks or signs
 * in, later taps must open, so the current route decides. The root path ('/',
 * the splash) holds taps until something has routed away from it: the gate's
 * redirect (launch false) or index's own replace (launch true).
 */
export async function openWhenUnlocked(
  href: string,
  launch: Promise<boolean>,
  currentPath: () => string | null | undefined,
  open: (href: string) => void,
): Promise<void> {
  const [allowed, relocking] = await Promise.all([launch, resumeLock]);
  const path = currentPath();
  const onSplash = !path || path === '/';
  const stillGated = isLockOrAuthRoute(path) || (onSplash && !(allowed && launchRouted));
  if (!relocking && !stillGated) open(href);
  else stashLaunchLink(href);
}

// ── Taps that arrive outside React ────────────────────────────────────────
//
// notifee's background handler (lib/callBackground.ts) runs for a notification
// pressed while the app is backgrounded, and at JS load on a cold start —
// possibly before the root layout has mounted. It hands the tap here; the root
// subscribes and sends it through its lock-aware opener. The same tap can also
// come back from getInitialNotification on a cold start, so a repeat of the
// same href within DUP_MS is dropped rather than opened twice.

const DUP_MS = 10_000;
let tapSink: ((href: string) => void) | null = null;
let heldTap: string | null = null;
let lastTap: { href: string; at: number } | null = null;

/** Deliver a tap to the root's opener, or hold it until the root subscribes. */
export function deliverTap(href: string, now: number = Date.now()): void {
  if (lastTap && lastTap.href === href && now - lastTap.at < DUP_MS) return;
  lastTap = { href, at: now };
  if (tapSink) tapSink(href);
  else heldTap = href;
}

/** The root's subscription; a tap that arrived before it is delivered at once. */
export function onDeliveredTap(sink: (href: string) => void): () => void {
  tapSink = sink;
  const held = heldTap;
  heldTap = null;
  if (held) sink(held);
  return () => { if (tapSink === sink) tapSink = null; };
}

// ── Where the app last sent this process to authenticate ─────────────────
//
// launchAllowed (lib/launchGate) settles ONCE per process, so it says how this
// launch began, not whether the user is past the lock NOW. app/index.tsx used to
// return silently on `false`. That is right for the cold-start visit, which the
// root gate has already replaced, but it left any LATER visit to '/' on the logo
// with nothing to press. /blocked's exit did exactly that after a clean
// re-check: the launch scan had REPLACED the lock or sign-in screen, so there
// was nothing to go back to, and it replaced onto '/'.
//
// The root gate records where it sent the launch (null when it let it through),
// and lib/authNav.resetTo records each later crossing of the sign-in boundary.

/** The lock or sign-in route this process was last sent to; null once inside the app. */
let edge: string | null = null;
let gateDecided = false;

/** Root gate (every branch) and resetTo: where the user now stands. */
export function noteAuthEdge(next: string | null): void {
  edge = next;
  gateDecided = true;
}
/** The lock or sign-in route to return to, or null when the user is inside the app. */
export function authEdge(): string | null { return edge; }
/** False until the root gate has decided; read by index on its first render. */
export function launchGateDecided(): boolean { return gateDecided; }

/** The edge after a resetTo(href): a lock or sign-in route is one, anything else is inside. */
export function edgeAfterReset(href: string): string | null {
  return isLockOrAuthRoute(href.split('?')[0]) ? href : null;
}

/**
 * What app/index.tsx does on a visit to '/'.
 *   'route' — continue into the app (restore offer or Chats);
 *   'wait'  — the cold-start visit: the root gate has already replaced it;
 *   an href — a later visit while the user is still outside: go to that lock or
 *             sign-in screen. Never 'route' for a launch the gate refused unless
 *             a resetTo has since recorded the user inside.
 */
export function splashNext(allowed: boolean, coldVisit: boolean, current: string | null): 'route' | 'wait' | string {
  if (coldVisit) return allowed ? 'route' : 'wait';
  return current ?? 'route';
}
