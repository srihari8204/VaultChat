// Single fetch wrapper for the VaultChat backend (Phase 1+).
// Handles JWT attachment, automatic refresh on 401, and JSON I/O.
//
// Tokens live in SecureStore (encrypted at rest by the OS keystore).
// The cached user profile lives there too so the app can render an
// authenticated shell on cold start before the first /user/profile call.

import * as Sentry from '@sentry/react-native';
import { router } from 'expo-router';
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
  _mem = null;
  _sealKey = null;
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
  if (VAULT_SESSION_SEALED) { try { await (await sealMod()).clearSealedSession(); } catch {} }
  // #32 Phase B: drop the in-memory cache DEK (the envelope on disk is cleared by
  // the account wipe in clearLocalDb, so a same-PIN re-unlock keeps cached rows readable).
  try { (await cacheMod()).clearCacheKey(); } catch {}
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
  const { json, auth, headers: optHeaders, body: optBody, ...init } = opts;

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
let refreshInFlight: Promise<boolean> | null = null;
function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  const refresh = await getRefreshToken();
  if (!refresh) return false;
  try {
    const res = await fetch(`${SERVER_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.accessToken || !data?.refreshToken) return false;
    await setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

// Guard so we don't navigate to /welcome from a hundred concurrent failing requests.
let sessionEndingPromise: Promise<void> | null = null;
async function endSessionAndBounce(): Promise<void> {
  if (sessionEndingPromise) return sessionEndingPromise;
  sessionEndingPromise = (async () => {
    await clearTokens();
    await setCachedUser(null);
    try {
      // expo-router's imperative router is safe outside React components.
      router.replace('/onboard' as any);
    } catch (err) {
      console.warn('[api] could not redirect after session end:', (err as any)?.message);
    }
  })();
  try { await sessionEndingPromise; } finally {
    // Reset after a beat so a future fresh sign-in starts clean.
    setTimeout(() => { sessionEndingPromise = null; }, 5000);
  }
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res = await rawFetch(path, opts);

  // Auto-refresh once on 401
  if (res.status === 401 && opts.auth !== false) {
    const ok = await tryRefresh();
    if (ok) res = await rawFetch(path, opts);
    else {
      // Refresh failed → session is dead. Clear tokens and bounce to /welcome
      // so the user can sign in again instead of staring at a "token_expired"
      // alert with no way forward.
      await endSessionAndBounce();
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
