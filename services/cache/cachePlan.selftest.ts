/**
 * Node self-test for cache-cleanup planning.
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * The load-bearing proof: USER DATA IS NEVER SELECTABLE. Whatever you pass, the
 * planner only ever includes real cache categories; chats, keys, backups,
 * settings, and offline files are refused. Also covers smart/all selection,
 * size math, auto-clean scheduling, and formatBytes.
 */
import {
  CACHE_CATEGORIES, allCleanableIds, smartSelection, planCleanup,
  summarizeSizes, dueForAutoClean, formatBytes,
} from './cachePlan';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}

(async () => {
  console.log('\ncrazzychat cache-cleanup planner self-test\n────────────────────────────────────────────');

  const SIZES = {
    image: 40_000_000, thumbnail: 5_000_000, video: 120_000_000, audio: 8_000_000,
    document: 12_000_000, ai: 3_000_000, search: 6_000_000, temp: 2_000_000, dbCache: 1_000_000,
  };

  // ── SAFETY: user data can never be selected ──────────────────────
  console.log('Safety (allowlist):');
  const attack = planCleanup(
    { chats: 999, keys: 999, offline: 999, backups: 999, settings: 999, image: 40_000_000 } as any,
    { selected: ['chats', 'keys', 'offline', 'backups', 'settings', 'image'] },
  );
  check('protected/unknown ids rejected', attack.rejected.length === 5);
  check('only the real cache category is planned', attack.items.length === 1 && attack.items[0].id === 'image');
  check('rejected ids never contribute bytes', attack.totalBytes === 40_000_000);
  check('offline files explicitly refused', attack.rejected.includes('offline'));
  check('encryption keys explicitly refused', attack.rejected.includes('keys'));

  // ── Smart selection = safe subset only ───────────────────────────
  console.log('Smart / all selection:');
  const smartIds = smartSelection();
  check('smart excludes search index (rebuild cost)', !smartIds.includes('search'));
  check('smart excludes dbCache (VACUUM is heavier)', !smartIds.includes('dbCache'));
  check('smart includes image/thumbnail/temp', ['image', 'thumbnail', 'temp'].every((i) => smartIds.includes(i as any)));
  const smart = planCleanup(SIZES, { smart: true });
  check('smart plan only safe categories', smart.items.every((i) => smartIds.includes(i.id)));
  check('smart frees < all', smart.totalBytes < planCleanup(SIZES, { all: true }).totalBytes);
  const all = planCleanup(SIZES, { all: true });
  check('all plan covers every cleanable category', all.items.length === allCleanableIds().length);
  check('all total = sum of sizes', all.totalBytes === Object.values(SIZES).reduce((a, b) => a + b, 0));

  // ── Selection hygiene ────────────────────────────────────────────
  console.log('Selection:');
  check('empty selection → empty plan', planCleanup(SIZES, {}).items.length === 0);
  check('duplicate ids de-duplicated', planCleanup(SIZES, { selected: ['image', 'image'] }).items.length === 1);
  check('missing size treated as 0', planCleanup({}, { selected: ['image'] }).totalBytes === 0);
  check('negative size treated as 0', planCleanup({ image: -5 } as any, { selected: ['image'] }).totalBytes === 0);

  // ── Show cache size ──────────────────────────────────────────────
  console.log('Size summary:');
  const sum = summarizeSizes(SIZES);
  check('summary has a row per category', sum.rows.length === CACHE_CATEGORIES.length);
  check('summary total correct', sum.totalBytes === Object.values(SIZES).reduce((a, b) => a + b, 0));
  check('summary rows in registry order', sum.rows[0].id === CACHE_CATEGORIES[0].id);

  // ── Automatic cleanup scheduling ─────────────────────────────────
  console.log('Auto-clean scheduling:');
  const NOW = 1_700_000_000_000;
  check('never cleaned → due', dueForAutoClean(null, NOW, 7) === true);
  check('within window → not due', dueForAutoClean(NOW - 3 * 86_400_000, NOW, 7) === false);
  check('past window → due', dueForAutoClean(NOW - 8 * 86_400_000, NOW, 7) === true);
  check('days=0 → automatic cleanup off', dueForAutoClean(null, NOW, 0) === false);
  check('clock moved back → due', dueForAutoClean(NOW + 86_400_000, NOW, 30) === true);
  check('30-day window respected', dueForAutoClean(NOW - 20 * 86_400_000, NOW, 30) === false && dueForAutoClean(NOW - 31 * 86_400_000, NOW, 30) === true);

  // ── formatBytes ──────────────────────────────────────────────────
  console.log('formatBytes:');
  check('bytes', formatBytes(512) === '512 B');
  check('KB', formatBytes(2048) === '2.0 KB');
  check('MB', formatBytes(40_000_000).endsWith(' MB'));
  check('GB', formatBytes(3 * 1024 ** 3).endsWith(' GB'));
  check('zero/garbage → 0 B', formatBytes(-5) === '0 B' && formatBytes(NaN) === '0 B');

  console.log('────────────────────────────────────────────');
  if (failures === 0) { console.log('ALL CACHE-PLANNER TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
