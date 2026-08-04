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
| `cacheManager.ts` | ⚠️ **Device-only** (expo-file-system / AsyncStorage / local DB). Measures cache sizes, executes a plan (per-file idempotent deletes → interruption-safe), VACUUMs the DB cache, records last-clean time. Not Node-tested. |

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
  cache (expo-image, media store, doc viewer, AI, search).
- A confirm-before-clearing dialog showing bytes-to-free (`formatBytes`), a
  cache screen with per-category sizes + One-Tap, and the settings for automatic
  cleanup / clear-on-logout. All thin renderers over the pure planner.
- Run measurement + cleanup in the background so a large scan doesn't block the UI.

## Test

```
npm test -- cachePlan
```
