// services/cache/cachePlan.ts — cache-cleanup planning (pure, testable).
//
// The safety core of the Application Cache Cleanup feature. It decides WHAT may
// be cleared and computes how much would be freed — but never touches the disk
// (that's cacheManager.ts). Keeping the decision pure means the one rule that
// matters is provable in CI: user data is NEVER selectable.
//
// HARD SAFETY MODEL (allowlist, not blocklist):
//   • Only ids in CACHE_CATEGORIES are cleanable. Anything else — chats, saved
//     media, document originals, backups, encryption keys, settings, and
//     OFFLINE files — is not in the registry and is REJECTED even if explicitly
//     passed. There is no id you can hand this planner that deletes user data.
//   • Every category is rebuildable cache: clearing it only forces a lazy
//     re-download / re-generation, never data loss.

export type CacheCategoryId =
  | 'image' | 'video' | 'document' | 'audio' | 'ai'
  | 'search' | 'thumbnail' | 'temp' | 'dbCache';

export interface CacheCategory {
  id: CacheCategoryId;
  label: string;
  description: string;
  /** Included by One-Tap Smart Cleanup and by Automatic Cleanup. */
  safeToAutoClean: boolean;
  /** What rebuilds it (shown to the user so "cache" reads as recreatable). */
  rebuiltBy: string;
}

// The complete set of cleanable caches. Order is display order.
export const CACHE_CATEGORIES: CacheCategory[] = [
  { id: 'image',     label: 'Image cache',     description: 'Cached image previews and full-size images.', safeToAutoClean: true,  rebuiltBy: 're-downloaded when you open the chat' },
  { id: 'thumbnail', label: 'Thumbnails',      description: 'Generated image/video thumbnails.',           safeToAutoClean: true,  rebuiltBy: 're-generated on demand' },
  { id: 'video',     label: 'Video cache',     description: 'Temporary streamed video files.',              safeToAutoClean: true,  rebuiltBy: 're-streamed when you play it' },
  { id: 'audio',     label: 'Voice/audio cache',description: 'Temporary voice-message and audio cache.',    safeToAutoClean: true,  rebuiltBy: 're-downloaded on play' },
  { id: 'document',  label: 'Document cache',  description: 'Temporary copies of opened documents (not the originals).', safeToAutoClean: true, rebuiltBy: 're-downloaded when you open it' },
  { id: 'ai',        label: 'AI cache',        description: 'Temporary AI responses and embeddings.',        safeToAutoClean: true,  rebuiltBy: 'recomputed on the next request' },
  { id: 'search',    label: 'Search index',    description: 'Cached search index that can be rebuilt.',      safeToAutoClean: false, rebuiltBy: 're-indexed on the next search' },
  { id: 'temp',      label: 'Temporary files', description: 'Logs, temporary downloads, expired files.',     safeToAutoClean: true,  rebuiltBy: 'recreated as needed' },
  { id: 'dbCache',   label: 'Database cache',  description: 'Rebuildable cache tables (VACUUM — never your messages).', safeToAutoClean: false, rebuiltBy: 'rebuilt lazily by the app' },
];

const BY_ID: Record<string, CacheCategory> = Object.fromEntries(CACHE_CATEGORIES.map((c) => [c.id, c]));

/** Every cleanable id (e.g. for "Clear all on logout"). */
export function allCleanableIds(): CacheCategoryId[] {
  return CACHE_CATEGORIES.map((c) => c.id);
}

/** Ids One-Tap Smart Cleanup / Automatic Cleanup may remove (safe subset). */
export function smartSelection(): CacheCategoryId[] {
  return CACHE_CATEGORIES.filter((c) => c.safeToAutoClean).map((c) => c.id);
}

export interface PlanItem { id: CacheCategoryId; label: string; bytes: number; }
export interface CleanupPlan {
  items: PlanItem[];
  totalBytes: number;
  /** Ids that were requested but refused because they are not cleanable cache. */
  rejected: string[];
}

export interface PlanOptions {
  /** Explicit category ids to clear. Ignored when `smart` is true. */
  selected?: string[];
  /** One-Tap Smart Cleanup — clear only the safe-to-auto-clean subset. */
  smart?: boolean;
  /** Clear everything cleanable (e.g. logout). Overrides selected/smart. */
  all?: boolean;
}

/**
 * Build a cleanup plan from measured per-category sizes. The ONLY ids that can
 * end up in the plan are real cache categories; a request to clear anything else
 * (chats, keys, offline, backups, settings, or an unknown id) is dropped into
 * `rejected` and never deleted. Sizes for unlisted/negative categories are
 * treated as zero. Pure — no disk access.
 */
export function planCleanup(sizes: Record<string, number>, opts: PlanOptions = {}): CleanupPlan {
  let ids: string[];
  if (opts.all) ids = allCleanableIds();
  else if (opts.smart) ids = smartSelection();
  else ids = opts.selected ?? [];

  const rejected: string[] = [];
  const items: PlanItem[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cat = BY_ID[id];
    if (!cat) { rejected.push(id); continue; }        // not a cleanable cache → refuse
    const bytes = safeBytes(sizes[id]);
    items.push({ id: cat.id, label: cat.label, bytes });
  }

  const totalBytes = items.reduce((a, it) => a + it.bytes, 0);
  return { items, totalBytes, rejected };
}

export interface CacheSizeRow { id: CacheCategoryId; label: string; bytes: number; }
export interface CacheSizeSummary { rows: CacheSizeRow[]; totalBytes: number; }

/** "Show cache size" — per-category + total, in registry order. Pure. */
export function summarizeSizes(sizes: Record<string, number>): CacheSizeSummary {
  const rows = CACHE_CATEGORIES.map((c) => ({ id: c.id, label: c.label, bytes: safeBytes(sizes[c.id]) }));
  return { rows, totalBytes: rows.reduce((a, r) => a + r.bytes, 0) };
}

/** Automatic Cleanup: is a cleanup due given the last run and the configured age? */
export function dueForAutoClean(lastCleanAt: number | null, now: number, days: number): boolean {
  if (days <= 0) return false;                 // 0/negative = automatic cleanup off
  if (lastCleanAt == null) return true;        // never cleaned → due
  const ageMs = now - lastCleanAt;
  if (ageMs < 0) return true;                  // clock moved back → treat as due
  return ageMs >= days * 24 * 60 * 60 * 1000;
}

/** Human-readable size for the UI. */
export function formatBytes(n: number): string {
  const b = safeBytes(n);
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function safeBytes(n: number | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0;
}
