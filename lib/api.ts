// Single fetch wrapper for the VaultChat backend (Phase 1+).
// Handles JWT attachment, automatic refresh on 401, and JSON I/O.
//
// Tokens live in SecureStore (encrypted at rest by the OS keystore).
// The cached user profile lives there too so the app can render an
// authenticated shell on cold start before the first /user/profile call.

import * as Sentry from '@sentry/react-native';
import { router } from 'expo-router';

import { SessionEndedError } from './sessionEnded';
import { tokenSubject } from './tokenIdentity';
import { resetTo } from './authNav';
import * as SecureStore from 'expo-secure-store';
import { SERVER_URL } from '../constants/server';
import { VAULT_SESSION_SEALED } from '../constants/flags';

const ACCESS_TOKEN_KEY  = 'vc_access_token';
const REFRESH_TOKEN_KEY = 'vc_refresh_token';
const USER_KEY          = 'vc_user';

// ─── Token storage ────────────────────────────────────────────
// #32 Phase A (behind VAULT_SESSION_SEALED): when ON, the real session tokens
// are sealed under the unlock PIN and held in memory after unlock, never in
// plaintext SecureStore. When OFF, every path below is byte-identical to before.
let _mem: { access: string; refresh: string } | null = null;  // in-memory session (sealed mode only)
let tokenRevision = 0;
let _sealKey: Uint8Array | null = null;                         // PIN-derived key, cached after unlock/setup
const sealMod  = () => import('../services/security/sessionSeal');
const cacheMod = () => import('./cacheCrypto');                 // #32 Phase B: at-rest cache DEK

export async function getAccessToken(): Promise<string | null> {
  if (VAULT_SESSION_SEALED && _mem) return _mem.access;
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  if (VAULT_SESSION_SEALED && _mem) return _mem.refresh;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setTokens(access: string, refresh: string): Promise<void> {
  tokenRevision++;
  if (VAULT_SESSION_SEALED) {
    _mem = { access, refresh };
    if (_sealKey) {
      // Post-setup/unlock: persist via the sealed blob only — no plaintext.
      try { await (await sealMod()).sealWithKey(_sealKey, _mem); return; }
      catch { /* fall through to plaintext so a session is never lost */ }
    }
    // Pre-PIN (login window): keep a temp plaintext copy so a mid-flow reload
    // doesn't lose the session; sealCurrentSession() seals + clears it at PIN setup.
  }
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY,  access);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refresh);
}

export async function clearTokens(): Promise<void> {
  tokenRevision++;
  _mem = null;
  _sealKey = null;
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
  if (VAULT_SESSION_SEALED) { try { await (await sealMod()).clearSealedSession(); } catch {} }
  // #32 Phase B: drop the in-memory cache DEK (the envelope on disk is cleared by
  // the account wipe in clearLocalDb, so a same-PIN re-unlock keeps cached rows readable).
  try { (await cacheMod()).clearCacheKey(); } catch {}
  // The terms answer belongs to the USER, not the install. Without this, signing
  // out and back in as somebody else carries the first account's acceptance for
  // the life of the process — the second user is never asked, and the server has
  // no record that they agreed to anything. resetTermsCache existed for exactly
  // this and nothing called it.
  //
  // Dynamic import on purpose: lib/terms imports this module, so a static one is
  // a cycle. Same reason sealMod() and cacheMod() above are lazy.
  try { (await import('./terms')).resetTermsCache(); } catch {}
}

// ─── #32 session-seal seam (no-ops unless VAULT_SESSION_SEALED) ─────────────
/** Any usable session present? (in-memory, sealed-on-disk, or legacy plaintext.) */
export async function hasSession(): Promise<boolean> {
  if (VAULT_SESSION_SEALED && _mem) return true;
  if (VAULT_SESSION_SEALED) { try { if (await (await sealMod()).hasSealedSession()) return true; } catch {} }
  return !!(await SecureStore.getItemAsync(ACCESS_TOKEN_KEY));
}

/** True when a sealed session exists that must be unlocked with the PIN. */
export async function sealedSessionLocked(): Promise<boolean> {
  if (!VAULT_SESSION_SEALED || _mem) return false;
  try { return await (await sealMod()).hasSealedSession(); } catch { return false; }
}

/** One cold-start read for the two routing questions index.tsx must answer. */
export async function getLaunchSessionState(): Promise<{ signedIn: boolean; sealedLocked: boolean }> {
  if (VAULT_SESSION_SEALED && _mem) return { signedIn: true, sealedLocked: false };
  if (VAULT_SESSION_SEALED) {
    try {
      const sealed = await (await sealMod()).hasSealedSession();
      // Unlock may have completed while the SecureStore read was in flight.
      if (_mem) return { signedIn: true, sealedLocked: false };
      if (sealed) return { signedIn: true, sealedLocked: true };
    } catch {}
  }
  return {
    signedIn: !!(await SecureStore.getItemAsync(ACCESS_TOKEN_KEY)),
    sealedLocked: false,
  };
}

/** Seal the current session under the PIN and drop the plaintext copy. Call at PIN setup. */
export async function sealCurrentSession(pin: string): Promise<void> {
  if (!VAULT_SESSION_SEALED) return;
  try {
    const m = await sealMod();
    // Grab the current tokens (memory or the temp plaintext from the login window).
    const access  = _mem?.access  ?? (await SecureStore.getItemAsync(ACCESS_TOKEN_KEY));
    const refresh = _mem?.refresh ?? (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY));
    if (!access || !refresh) return;
    _mem = { access, refresh };
    _sealKey = await m.deriveSessionKey(pin);
    await m.sealWithKey(_sealKey, _mem);
    // #32 Phase B: provision + load the at-rest cache DEK under the same PIN key.
    try { await (await cacheMod()).provisionCacheKey(_sealKey); } catch {}
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {});
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
  } catch { /* keep the plaintext fallback — never brick */ }
}

/**
 * Undo sealing: put the session back on the plaintext path. Call when the local
 * PIN is REMOVED, so a user who turns the feature off is never stranded holding
 * a sealed blob they have no key for.
 *
 * No-op when nothing is in memory — which is exactly the logout case
 * (clearTokens() already nulled _mem and deleted the sealed blob), so this can
 * never resurrect tokens a logout just destroyed.
 */
export async function unsealCurrentSession(): Promise<void> {
  if (!VAULT_SESSION_SEALED || !_mem) return;
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY,  _mem.access);
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, _mem.refresh);
  _sealKey = null;
  try { await (await sealMod()).clearSealedSession(); } catch {}
  // #32 Phase B: drop the in-memory DEK. The envelope on disk is deliberately
  // LEFT ALONE — see the ponytail note in cacheCrypto's caller list.
  // ponytail: rows already sealed under that DEK become unreadable ciphertext
  // after a PIN removal/change. Harmless while VAULT_CACHE_ENCRYPTED is off (no
  // row is ever sealed); before that flag can ship, this needs a row rewrite or
  // a cache purge here.
  try { (await cacheMod()).clearCacheKey(); } catch {}
}

/** Unseal the session with the PIN into memory. Returns true on success. Call at unlock. */
export async function loadSealedSession(pin: string): Promise<boolean> {
  if (!VAULT_SESSION_SEALED) return false;
  try {
    const m = await sealMod();
    const key = await m.deriveSessionKey(pin);
    const tokens = await m.unsealWithKey(key);
    if (tokens) {
      _mem = tokens; _sealKey = key;
      // #32 Phase B: load the at-rest cache DEK with the same PIN key.
      try { await (await cacheMod()).unlockCacheKey(key); } catch {}
      return true;
    }
  } catch { /* fall through — legacy plaintext path still works */ }
  return false;
}

// ─── Cached user profile ──────────────────────────────────────
export async function setCachedUser(user: any | null): Promise<void> {
  // Login and logout both land here, and both change who "I" am. chatService
  // memoises this device's user id for the process lifetime to keep the
  // per-message ownership check off the SecureStore path — so without this it
  // would keep answering with the PREVIOUS account's id after a switch, and
  // every own message would be treated as someone else's and sent to a decrypt
  // that cannot succeed. Dynamic import: chatService imports this module.
  try { (await import('./chatService')).resetMyUserIdCache(); } catch {}
  if (!user) {
    await SecureStore.deleteItemAsync(USER_KEY).catch(() => {});
    try { Sentry.setUser(null); } catch {}
    return;
  }
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  // Tag every subsequent Sentry event with this user id so crashes are
  // attributable. No-op if Sentry isn't init'd.
  try {
    Sentry.setUser({
      id:       user.id    ?? undefined,
      email:    user.email ?? undefined,
      username: user.name  ?? undefined,
    });
  } catch {}
}

export async function getCachedUser(): Promise<any | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ─── fetch wrapper ────────────────────────────────────────────
type ApiOptions = Omit<RequestInit, 'body'> & {
  expectedUserId?: string; // queued user-owned work must not borrow a later login
  auth?: boolean;     // default true — attach Bearer token if available
  json?: any;         // sets body to JSON + Content-Type
  body?: BodyInit;    // raw body, mutually exclusive with json
};

// Stable per-install id, cached in memory after the first read. Sent as
// X-Device-Id so the server can tell a resumed client from a cold start — see
// the cold-sync guard in internal/routes/chats.go. It lives in the OS keystore,
// so uninstall destroys it and a reinstall correctly presents as a NEW device.
// Best-effort: a device that can't produce one still syncs (uncapped), which is
// also how older clients behave.
let _deviceIdPromise: Promise<string | null> | null = null;
function deviceId(): Promise<string | null> {
  if (!_deviceIdPromise) {
    _deviceIdPromise = import('../services/deviceService')
      .then(m => m.getDeviceId())
      .catch(() => null);
  }
  return _deviceIdPromise;
}

async function rawFetch(path: string, opts: ApiOptions): Promise<Response> {
  // Strip our internal keys so they don't leak into fetch init.
  const { json, auth, expectedUserId, headers: optHeaders, body: optBody, ...init } = opts;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(optHeaders as Record<string, string> | undefined),
  };

  const did = await deviceId();
  if (did) headers['X-Device-Id'] = did;

  let body: BodyInit | undefined = optBody;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  if (auth !== false) {
    const token = await getAccessToken();
    if (expectedUserId && tokenSubject(token) !== expectedUserId) throw new SessionEndedError();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const url = `${SERVER_URL}${path}`;
  if (__DEV__) console.log(`[api] ${init.method || 'GET'} ${url}`);

  // A request with no deadline is not "patient", it is a hang.
  //
  // RN Android builds OkHttp with zero (= infinite) connect/read/write timeouts.
  // Airplane mode rejects fast, so this stays invisible until the link is
  // CONNECTED BUT DEAD — a captive portal, Wi-Fi with no route, a black-holing
  // server. Then fetch simply never settles. The outbox held its `flushing`
  // mutex across an await like this one, so the finally that releases it never
  // ran and every later flush early-returned: tapping Send did nothing, with no
  // error and no recovery short of killing the app.
  //
  // Two escapes, both deliberate:
  //   * caller passed a signal — cancellation is theirs, don't fight it
  //   * FormData — an upload is legitimately long (chatService uploadAttachment)
  if (init.signal || (typeof FormData !== 'undefined' && body instanceof FormData)) {
    return fetch(url, { ...init, headers, body });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers, body, signal: ctl.signal });
  } finally {
    clearTimeout(timer);   // response headers are in; the body streams on
  }
}

// Generous: it is a backstop against a dead link, not a latency budget. Slow
// networks must not trip it, so it sits well above any normal request.
const REQUEST_TIMEOUT_MS = 30_000;

// Refresh tokens ROTATE (single-use): the server revokes the presented token and
// issues a new pair. So when a dozen requests 401 at once on app resume (access
// token expired), they must NOT each fire their own /auth/refresh — the first
// rotates the token and the rest would present the now-revoked one and get logged
// out. All concurrent callers therefore share ONE in-flight refresh.
/**
 * WHY REFRESH HAS THREE ANSWERS, NOT TWO.
 *
 * AUDIT F08: this returned a plain boolean, so a dropped connection, a 503
 * during a deploy and a genuinely revoked token were all `false` — and the
 * caller responded to `false` by DELETING the user's credentials and bouncing
 * them to onboarding. A tunnel, a failed network resume or one bad minute on
 * the server logged people out and made them sign in again.
 *
 * Only the server saying "this token is not valid" means the session is over.
 * Everything else means "ask again later", and the credentials must survive it.
 *
 *   'ok'        — refreshed, tokens rotated.
 *   'terminal'  — the server rejected the refresh token itself. Session over.
 *   'transient' — no answer, or one we cannot act on. Keep the credentials.
 */
export type RefreshOutcome = 'ok' | 'terminal' | 'transient';

/** Refresh is not allowed to hang forever — see F09. */
const REFRESH_TIMEOUT_MS = 15_000;

let refreshInFlight: Promise<RefreshOutcome> | null = null;
function tryRefresh(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<RefreshOutcome> {
  const revision = tokenRevision;
  const refresh = await getRefreshToken();
  if (revision !== tokenRevision) return 'transient';
  // No refresh token at all is genuinely terminal: there is nothing to retry.
  //
  // EXCEPT when the session is SEALED AND STILL LOCKED (#32). Then the tokens
  // exist, they are simply not in memory yet — this is a request that reached
  // the network before the unlock screen did (a deep link, a notification tap,
  // a background task). Calling it terminal would run endSessionAndBounce(),
  // whose clearTokens() DELETES THE SEALED BLOB: a permanent logout for a user
  // whose only crime was tapping a notification. Send them to the unlock screen
  // and report the failure as retryable instead.
  if (!refresh) {
    if (await sealedSessionLocked()) {
      try { router.replace('/app-lock' as any); } catch {}
      return 'transient';
    }
    return 'terminal';
  }

  // Bounded on purpose. This fetch used to run with no signal and no deadline,
  // outside the normal request timeout, so a black-hole connection could leave
  // refreshInFlight pending forever — and every request that joined it with it.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
      signal: ctl.signal,
    });
    if (revision !== tokenRevision) return 'transient';
    // 401/403 is the server telling us this token is dead. A 5xx is the server
    // having a bad time and says nothing about the token; 429 likewise.
    if (res.status === 401 || res.status === 403) return 'terminal';
    if (!res.ok) return 'transient';

    const data = await res.json().catch(() => null);
    // A 200 we cannot parse is a broken response, not a revoked session —
    // a captive-portal login page answers 200 with HTML.
    if (!data?.accessToken || !data?.refreshToken) return 'transient';
    // A response for a previous login must never replace a newer session.
    if (revision !== tokenRevision) return 'transient';
    await setTokens(data.accessToken, data.refreshToken);
    return 'ok';
  } catch {
    return 'transient';   // offline, DNS, TLS, abort — all retryable
  } finally {
    clearTimeout(timer);
  }
}

// Guard so we don't navigate to /welcome from a hundred concurrent failing requests.
let sessionEndingPromise: Promise<void> | null = null;
async function endSessionAndBounce(expectedUserId?: string): Promise<void> {
  if (sessionEndingPromise) return sessionEndingPromise;
  sessionEndingPromise = (async () => {
    // YOU CANNOT END A SESSION THAT NEVER STARTED.
    //
    // During onboarding there are no tokens yet, so doRefresh() answers
    // 'terminal' (correctly — there is nothing to retry) and every caller of a
    // 401'd authenticated request lands here. The redirect below then fires
    // router.replace('/onboard') UNDER A USER WHO IS MID-SIGN-UP: typing the
    // email OTP, they are silently thrown back to the landing screen with the
    // form blank, and the code they were sent is now unreachable. Any stray
    // background request during onboarding does it — a version check, a sync
    // tick, a listener warming up — so it looks random and untraceable.
    //
    // "Was there a session?" is the honest test, and it is the same question
    // the bounce is really asking. Never had one → this is the sign-in flow
    // doing its job, so leave the navigator alone. Had one → it is genuinely
    // dead, clear it and send them to sign in, exactly as before.
    if (!(await hasSession())) {
      sessionEndingPromise = null;
      return;
    }
    if (expectedUserId && tokenSubject(await getAccessToken()) !== expectedUserId) return;
    await clearTokens();
    await setCachedUser(null);
    try {
      // expo-router's imperative router is safe outside React components.
      //
      // resetTo, not replace: replace() swaps only the TOP history entry, so a
      // forced sign-out left the whole signed-in stack sitting underneath and
      // one BACK press walked straight back into the app the redirect existed
      // to eject the user from. The session is dead by this point — every
      // screen below is unusable — so the stack goes with it.
      resetTo('/onboard');
    } catch (err) {
      console.warn('[api] could not redirect after session end:', (err as any)?.message);
    }
  })();
  try { await sessionEndingPromise; } finally {
    // Reset after a beat so a future fresh sign-in starts clean.
    setTimeout(() => { sessionEndingPromise = null; }, 5000);
  }
}

/**
 * Refresh the access token on demand, for callers outside the HTTP path.
 *
 * The socket layer needs this: its handshake credential is separate from any
 * request, so when the access token expires while the app is idle there is no
 * 401 to trigger the usual refresh — see lib/socket.ts (audit F13). De-duped
 * through the same in-flight promise as the HTTP path, so a socket reconnect
 * storm cannot start a second refresh and rotate the token out from under one.
 */
export function refreshAccessToken(): Promise<RefreshOutcome> {
  return tryRefresh();
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res = await rawFetch(path, opts);

  // Auto-refresh once on 401
  if (res.status === 401 && opts.auth !== false) {
    if (opts.expectedUserId && tokenSubject(await getAccessToken()) !== opts.expectedUserId) throw new SessionEndedError();
    const outcome = await tryRefresh();
    if (opts.expectedUserId && tokenSubject(await getAccessToken()) !== opts.expectedUserId) throw new SessionEndedError();
    if (outcome === 'ok') res = await rawFetch(path, opts);
    else if (outcome === 'transient') {
      // AUDIT F08: the session is probably fine — we just could not reach the
      // server to prove it. Surface an ordinary failure the caller can retry
      // and the offline queue can hold, and leave the credentials alone.
      throw new Error('Network unavailable — check your connection and try again.');
    } else {
      // Refresh failed → session is dead. Clear tokens and bounce to /welcome
      // so the user can sign in again instead of staring at a "token_expired"
      // alert with no way forward.
      await endSessionAndBounce(opts.expectedUserId);
      // AUDIT F09, completed. This used to return a promise that never settled,
      // which suppressed the "token_expired" dialog that the ~20 sites doing
      //   catch (e) { Alert.alert('… failed', e?.message ?? 'Try again') }
      // would otherwise have stacked on top of the sign-in screen. It worked,
      // and it cost more than it should have: `finally` never ran either, so
      // spinners, disabled buttons and "sending…" states stayed frozen on any
      // screen that outlived the redirect, and no caller could clean up.
      //
      // Now it rejects with a TYPED error and the dialog is suppressed at the
      // alert boundary instead (lib/alertGuard.ts, installed in app/_layout).
      // Callers unwind normally; the user gets the sign-in screen with nothing
      // in front of it.
      throw new SessionEndedError();
    }
  }

  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    let body: any;
    try {
      const j: any = await res.json();
      body = j;
      // Old routes: { error: "msg" }. New onboarding routes: { error: { code, message } }.
      if (j?.error) msg = typeof j.error === 'string' ? j.error : (j.error.message || msg);
    } catch {}
    const err: any = new Error(msg);
    err.status = res.status;
    // Some routes answer a failure with data the caller must act on — e.g. a
    // 409 price change carries the new prices to show the customer. Dropping
    // the body left them with a message and nothing to render.
    err.body = body;
    throw err;
  }

  // 204 / empty body
  const text = await res.text();
  if (!text) return undefined as any;
  try { return JSON.parse(text) as T; } catch { return text as any; }
}

// ✅ Required by expo-router to suppress "no default export" route warning
export default {};
