# Application Cache Cleanup

Frees storage by clearing **rebuildable cache only** — never chats, saved media,
document originals, backups, encryption keys, settings, or offline downloads.
Caches rebuild lazily (re-download / re-generate) the next time they're needed,
so clearing is low-risk and reversible in effect.

## Safety model (why user data can't be lost)

An **allowlist**, not a blocklist. Only the ids in `CACHE_CATEGORIES` are
cleanable; the planner *refuses* anything else — including `chats`, `keys`,
`offline`, `backups`, `settings` — dropping them into `rejected`, never into the
plan. There is no id you can pass that deletes user data, and the Node self-test
asserts exactly that. On disk, cache lives under `cacheDirectory` while user data
lives under `documentDirectory` / SecureStore, so the two are physically
separate and the manager only ever touches cache dirs.

## Files

| File | Status |
|------|--------|
| `cachePlan.ts` | ✅ **Shipped, pure.** Category registry, `smartSelection()`, `planCleanup()` (allowlist-guarded), `summarizeSizes()`, `dueForAutoClean()`, `formatBytes()`. No disk access. |
| `cachePlan.selftest.ts` | ✅ **Shipped.** ~30 Node assertions — headlined by "user data is never selectable". |
| `cacheManager.ts` | ⚠️ **Device-only** (expo-file-system / AsyncStorage / local DB). Measures cache sizes, executes a plan (per-file idempotent deletes → interruption-safe), VACUUMs the DB cache, records last-clean time. Also: auto-clean/clear-on-logout settings, `maybeAutoClean()` (boot), `clearCacheOnLogout()` (logout). Not Node-tested. |
| `app/cache-cleanup.tsx` | ⚠️ **Device-only.** The screen — per-category sizes, One-Tap Smart Cleanup, clear-selected with a confirm dialog + freed estimate, auto-clean interval (Off/7/15/30), clear-on-logout switch. Reached from `app/storage-manager.tsx`. Thin renderer over the pure planner. |

## Features covered

- Clear image / thumbnail / video / audio / document / AI / search / temp caches,
  and a DB-cache VACUUM (rebuild cache pages only — never rows).
- **One-Tap Smart Cleanup** — `smartSelection()` = the safe-to-auto-clean subset
  (excludes the search index + DB VACUUM, which are heavier to rebuild).
- **Show cache size** — `summarizeSizes()` / `measureCacheSizes()`.
- **Automatic cleanup** after N days (7/15/30) — `dueForAutoClean()`.
- **Clear on logout** — `planCleanup(sizes, { all: true })`.
- **Exclude offline files** — offline downloads are not a cache category and live
  outside `cacheDirectory`, so they are structurally excluded.

## Pending on-device (verify on the dev build)

- Confirm each `CACHE_DIRS` path against how each subsystem actually writes its
  cache (expo-image, media store, doc viewer, AI, search) — the current paths are
  sensible defaults, not verified.
- The screen, confirm dialog, and settings are built (`app/cache-cleanup.tsx`);
  verify measurement/cleanup run smoothly and consider moving a very large scan
  fully off the UI thread.

## Test

```
npm test -- cachePlan
```
