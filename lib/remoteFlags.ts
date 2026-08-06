// lib/remoteFlags.ts — the remote feature-flag channel (kill switch + canary).
//
// Every flag in constants/flags.ts is a compile-time constant, so "turn it off"
// has meant "cut a release and wait for the stores". This module is the small
// seam that makes a rollback real: the server can force a flag off, or hand it
// to a percentage of devices, without a build.
//
// THE ONE RULE: FAILURE MEANS THE COMPILED DEFAULT
// -----------------------------------------------
// No server, no network, no row, a 500, a parse error, a stale cache — every
// one of them resolves to the constant baked into this build, which is the
// value that was tested and shipped. This channel can only ever move a flag to
// a value an operator explicitly set. It can never fail a fleet ONTO an
// untested path, which is the failure mode that makes remote config dangerous.
//
// WHAT IT DOES NOT DO
// -------------------
// A kill switch stops NEW work; it does not reach into a transfer that is
// already running. Killing a flag mid-transfer would abandon a partially
// written file on the user's disk to protect against a bug that transfer has
// already survived. New transfers take the safe path within one refresh; the
// in-flight one finishes or fails on its own terms.
//
// constants/flags.ts is deliberately untouched — still plain `export const`,
// still parseable as text by scripts/prod-precheck.js. The override happens at
// the READ site, not the declaration.
//
// Pure enough to self-check: fetch, storage and clock are all injectable, so
// `npx tsx lib/remoteFlags.ts` exercises the whole resolution table.

export interface RemoteFlagPayload {
  v: number;
  flags: Record<string, boolean>;
  killed: string[];
  ttlSec: number;
}

interface CachedPayload { at: number; payload: RemoteFlagPayload }

export interface RemoteFlagDeps {
  fetchPayload: (build: number) => Promise<RemoteFlagPayload>;
  readCached: () => Promise<CachedPayload | null>;
  writeCached: (c: CachedPayload) => Promise<void>;
  now: () => number;
  build: () => number;
}

/**
 * How long a cached payload may still be trusted once its TTL has expired.
 *
 * The TTL says "you may serve this without asking again". This says "after
 * this, stop believing it at all". They are different questions, and the second
 * one is what stops an offline device from honouring a stale `true` forever
 * after the operator has killed the flag. Twelve hours is chosen against
 * VaultBeam's 24 h relay-object expiry: a device that has been dark longer than
 * this has nothing in flight worth protecting, so falling back to the compiled
 * default costs it nothing.
 */
export const MAX_STALE_MS = 12 * 60 * 60 * 1000;

/** Bounds a server-supplied TTL so a bad row cannot pin clients for days. */
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

export class RemoteFlagStore {
  private cached: CachedPayload | null = null;
  private inFlight: Promise<void> | null = null;
  private hydrated = false;

  constructor(private readonly deps: RemoteFlagDeps) {}

  /**
   * Resolve one flag. `compiled` is the constant from constants/flags.ts and is
   * the answer whenever the channel has nothing trustworthy to say.
   */
  enabled(key: string, compiled: boolean): boolean {
    const c = this.cached;
    if (!c) return compiled;
    if (this.deps.now() - c.at > MAX_STALE_MS) return compiled;   // too old to believe
    // The kill list is checked BEFORE the value map, so a payload that somehow
    // carries both cannot resolve to true.
    if (c.payload.killed?.includes(key)) return false;
    const v = c.payload.flags?.[key];
    return typeof v === 'boolean' ? v : compiled;
  }

  /** Is a flag under an explicit emergency kill (as opposed to merely off)? */
  isKilled(key: string): boolean {
    const c = this.cached;
    if (!c || this.deps.now() - c.at > MAX_STALE_MS) return false;
    return !!c.payload.killed?.includes(key);
  }

  /** True once a cached or fetched payload is available (diagnostics only). */
  get ready(): boolean { return this.hydrated; }

  /** Age of the payload in ms, or null if there is none. */
  ageMs(): number | null {
    return this.cached ? this.deps.now() - this.cached.at : null;
  }

  /**
   * Load from disk, then refresh from the server if the TTL has expired.
   * Never throws, never blocks longer than the underlying fetch.
   */
  async hydrate(): Promise<void> {
    if (!this.hydrated) {
      const disk = await this.deps.readCached().catch(() => null);
      if (disk && typeof disk.at === 'number' && disk.payload) this.cached = disk;
      this.hydrated = true;
    }
    if (this.isFresh()) return;
    await this.refresh();
  }

  /**
   * Force a round trip. Single-flight: a burst of transfer starts costs one
   * request, not one each.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const payload = await this.deps.fetchPayload(this.deps.build());
        if (!payload || typeof payload !== 'object' || typeof payload.flags !== 'object') return;
        const next: CachedPayload = { at: this.deps.now(), payload };
        this.cached = next;
        this.hydrated = true;
        await this.deps.writeCached(next).catch(() => {});
      } catch {
        // Keep the last good payload. It is still subject to MAX_STALE_MS, so a
        // server we cannot reach eventually returns us to compiled defaults
        // rather than leaving us on an override nobody can revoke.
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Refresh only if the TTL has expired — the cheap call for a hot path. */
  refreshIfStale(): Promise<void> {
    return this.isFresh() ? Promise.resolve() : this.refresh();
  }

  private isFresh(): boolean {
    const c = this.cached;
    if (!c) return false;
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, (c.payload.ttlSec ?? 900) * 1000));
    return this.deps.now() - c.at < ttl;
  }
}

// ── production binding ───────────────────────────────────────────────
// Lazily imported so this module stays loadable under `npx tsx`.

const CACHE_KEY = 'remote_flags_v1';

function appBuild(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants').default;
    const n = Number(
      Constants?.expoConfig?.android?.versionCode ??
      Constants?.expoConfig?.ios?.buildNumber ?? 0,
    );
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

let _store: RemoteFlagStore | null = null;

export function remoteFlags(): RemoteFlagStore {
  if (_store) return _store;
  _store = new RemoteFlagStore({
    build: appBuild,
    now: () => Date.now(),
    async fetchPayload(build) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { api } = require('./api');
      // auth:false is load-bearing. lib/api.ts bounces a user to onboarding when
      // a token refresh fails, and a boot-time flag lookup must never be able to
      // log somebody out. The device id still rides along, which is all the
      // server needs to bucket.
      return api(`/config/flags?build=${build}`, { auth: false });
    },
    async readCached() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readCache } = require('./localCache');
      return readCache(CACHE_KEY) as Promise<CachedPayload | null>;
    },
    async writeCached(c) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { writeCache } = require('./localCache');
      return writeCache(CACHE_KEY, c);
    },
  });
  return _store;
}

/** Boot hook — safe to call more than once, never throws. */
export async function hydrateRemoteFlags(): Promise<void> {
  try { await remoteFlags().hydrate(); } catch { /* compiled defaults stand */ }
}

/**
 * The single read used by feature code: the server's answer when it has one,
 * this build's constant otherwise.
 */
export function flagEnabled(key: string, compiled: boolean): boolean {
  try { return remoteFlags().enabled(key, compiled); } catch { return compiled; }
}

// ── self-check: `npx tsx lib/remoteFlags.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('remoteFlags: ' + m); };

  const mk = (opts: {
    payload?: RemoteFlagPayload | (() => RemoteFlagPayload);
    fail?: boolean;
    disk?: CachedPayload | null;
  } = {}) => {
    let clock = 1_000_000;
    let fetches = 0;
    const written: CachedPayload[] = [];
    const store = new RemoteFlagStore({
      build: () => 18,
      now: () => clock,
      async fetchPayload() {
        fetches++;
        if (opts.fail) throw new Error('offline');
        const p = typeof opts.payload === 'function' ? opts.payload() : opts.payload;
        return p ?? { v: 1, flags: {}, killed: [], ttlSec: 900 };
      },
      async readCached() { return opts.disk ?? null; },
      async writeCached(c) { written.push(c); },
    });
    return {
      store, written,
      fetches: () => fetches,
      advance: (ms: number) => { clock += ms; },
      at: () => clock,
    };
  };

  const run = async () => {
    // 1. no payload at all ⇒ the compiled constant, in both directions
    {
      const h = mk({ fail: true });
      await h.store.hydrate();
      A(h.store.enabled('VB_SEAMLESS_RESUME', false) === false, 'a dead channel keeps a false default false');
      A(h.store.enabled('VB_RELIABILITY_FIXES', true) === true, 'a dead channel keeps a TRUE default true');
      A(h.store.ageMs() === null, 'nothing cached');
    }

    // 2. the server can turn a flag ON (the canary) and OFF (the rollback)
    {
      const on = mk({ payload: { v: 1, flags: { F: true }, killed: [], ttlSec: 900 } });
      await on.store.hydrate();
      A(on.store.enabled('F', false) === true, 'the server can enable a flag this build ships off');
      A(on.written.length === 1, 'the payload was persisted for the next cold boot');

      const off = mk({ payload: { v: 1, flags: { F: false }, killed: [], ttlSec: 900 } });
      await off.store.hydrate();
      A(off.store.enabled('F', true) === false, 'the server can disable a flag this build ships on');
    }

    // 3. a key the server has no opinion on falls through to the constant
    {
      const h = mk({ payload: { v: 1, flags: { OTHER: true }, killed: [], ttlSec: 900 } });
      await h.store.hydrate();
      A(h.store.enabled('F', true) === true, 'an unmentioned key keeps its compiled value (true)');
      A(h.store.enabled('F', false) === false, 'an unmentioned key keeps its compiled value (false)');
    }

    // 4. THE kill switch: it wins even when the value map says true
    {
      const h = mk({ payload: { v: 1, flags: { F: true }, killed: ['F'], ttlSec: 900 } });
      await h.store.hydrate();
      A(h.store.enabled('F', true) === false, 'a killed flag is off despite a true value');
      A(h.store.enabled('F', false) === false, 'a killed flag is off, full stop');
      A(h.store.isKilled('F') === true, 'the kill is visible to diagnostics');
      A(h.store.isKilled('G') === false, 'an unkilled flag is not reported as killed');
    }

    // 5. a stale cache stops being believed — the offline-device case. Without
    //    this, a device that goes dark holding `true` honours it forever, and
    //    the kill switch has a hole exactly where it matters.
    {
      const h = mk({ payload: { v: 1, flags: { F: true }, killed: [], ttlSec: 900 }, fail: false });
      await h.store.hydrate();
      A(h.store.enabled('F', false) === true, 'fresh override applies');
      h.advance(MAX_STALE_MS + 1);
      A(h.store.enabled('F', false) === false, 'an over-stale override is abandoned for the constant');
      A(h.store.isKilled('F') === false, 'an over-stale payload reports nothing');
    }

    // 6. the TTL governs refetching, and it is CLAMPED so a bad row cannot pin
    //    the fleet (or hammer the server)
    {
      const h = mk({ payload: { v: 1, flags: {}, killed: [], ttlSec: 900 } });
      await h.store.hydrate();
      A(h.fetches() === 1, 'one fetch on a cold hydrate');
      await h.store.refreshIfStale();
      A(h.fetches() === 1, 'a fresh payload is not refetched');
      h.advance(901 * 1000);
      await h.store.refreshIfStale();
      A(h.fetches() === 2, 'an expired payload is refetched');
    }
    {
      const huge = mk({ payload: { v: 1, flags: {}, killed: [], ttlSec: 86400 } });
      await huge.store.hydrate();
      huge.advance(MAX_TTL_MS + 1);
      await huge.store.refreshIfStale();
      A(huge.fetches() === 2, 'an absurd server TTL is clamped, so clients stay reachable');
    }

    // 7. a failed refresh keeps the last good payload rather than blanking it
    {
      let shouldFail = false;
      const h = mk({
        payload: () => { if (shouldFail) throw new Error('down'); return { v: 1, flags: { F: true }, killed: [], ttlSec: 900 }; },
      });
      await h.store.hydrate();
      A(h.store.enabled('F', false) === true, 'override applied');
      shouldFail = true;
      h.advance(901 * 1000);
      await h.store.refresh();
      A(h.store.enabled('F', false) === true, 'a failed refresh does not discard the last good answer');
      A(h.store.ageMs()! > 0, 'and the payload keeps ageing towards the staleness cap');
    }

    // 8. cold boot from disk: the cached payload applies before any network
    {
      const disk: CachedPayload = { at: 1_000_000, payload: { v: 1, flags: { F: true }, killed: [], ttlSec: 900 } };
      const h = mk({ disk, fail: true });
      await h.store.hydrate();
      A(h.store.enabled('F', false) === true, 'a warm cache applies offline');
      A(h.store.ready === true, 'the store reports itself hydrated');
    }
    // …but a cached payload older than the staleness cap does not
    {
      const disk: CachedPayload = {
        at: 1_000_000 - MAX_STALE_MS - 1,
        payload: { v: 1, flags: { F: true }, killed: [], ttlSec: 900 },
      };
      const h = mk({ disk, fail: true });
      await h.store.hydrate();
      A(h.store.enabled('F', false) === false, 'an ancient disk cache is not honoured');
    }

    // 9. single-flight: a burst of callers costs one request
    {
      const h = mk({ payload: { v: 1, flags: {}, killed: [], ttlSec: 900 } });
      await Promise.all([h.store.refresh(), h.store.refresh(), h.store.refresh()]);
      A(h.fetches() === 1, 'concurrent refreshes share one request');
    }

    // 10. malformed payloads are ignored, not adopted
    {
      const h = mk({ payload: (() => (null as any)) });
      await h.store.hydrate();
      A(h.store.enabled('F', true) === true, 'a null payload leaves the constant standing');
      const h2 = mk({ payload: ({ v: 1 } as any) });
      await h2.store.hydrate();
      A(h2.store.enabled('F', false) === false, 'a payload with no flags map is ignored');
      A(h2.written.length === 0, 'a malformed payload is never persisted');
    }

    console.log('remoteFlags self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
