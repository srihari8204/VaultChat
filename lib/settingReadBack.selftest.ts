// lib/settingReadBack.selftest.ts — npx tsx lib/settingReadBack.selftest.ts
//
// Pins three "the screen shows what is actually true" fixes:
//   1. The cache settings setters reject on a storage failure, so
//      app/cache-cleanup.tsx's revert-and-alert branch can run.
//   2. app/call-reliability.tsx (via lib/batteryOptimization readBatteryExemption) never shows the battery exemption as "Done"
//      when it could not read it back (no VaultPower module in the build).
//   3. app/dashboard.tsx re-reads the score when the screen regains focus.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

const fnBody = (src: string, sig: string) => {
  const i = src.indexOf(sig);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i));
};

// 1
const cache = read('services/cache/cacheManager.ts');
for (const fn of ['setAutoCleanDays', 'setClearOnLogout']) {
  const body = fnBody(cache, `export async function ${fn}`);
  ok(body.length > 0 && !/\.catch\(/.test(body) && !/try\s*\{/.test(body),
    `1. ${fn} lets a storage failure reject instead of swallowing it`);
}
const cleanup = read('app/cache-cleanup.tsx');
ok(/try \{ await setAutoCleanDays\(d\); \}\s*catch \{ setAutoDays\(prev\)/.test(cleanup),
  '1a. cache-cleanup reverts the interval when the save rejects');
ok(/try \{ await setClearOnLogout\(v\); \}\s*catch \{ setClearLogout\(!v\)/.test(cleanup),
  '1b. cache-cleanup reverts the logout toggle when the save rejects');

// 2
const rel = read('app/call-reliability.tsx');
ok(!/isIgnoringBatteryOptimizations\(\)\.then\(setBattOk\)/.test(rel),
  '2. the battery card does not use the helper that reports TRUE when unknown');
const batt = read('lib/batteryOptimization.ts');
const tri = batt.slice(batt.indexOf('export async function readBatteryExemption'));
ok(/readBatteryExemption\(\)\.then\(setBattOk\)/.test(rel)
  && /if \(!mod\?\.isIgnoringBatteryOptimizations\) return null;/.test(tri)
  && /catch \{ return null; \}/.test(tri.slice(0, tri.indexOf('\n}\n'))),
  '2a. a build without VaultPower reads as unknown (null), not exempt');
ok(/battOk === true \? 'Done/.test(rel) && !/\{battOk \? 'Done/.test(rel),
  '2b. "Done" is shown only for a confirmed exemption');
ok(/battOk === null \? 'Open battery settings'/.test(rel),
  '2c. the unknown state offers to open battery settings');
ok(/battOk === true && autoOk/.test(rel), '2d. "You\'re set" needs a confirmed exemption');

// 3
const dash = read('app/dashboard.tsx');
ok(/useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\)/.test(dash),
  '3. the dashboard reloads the score on focus');

console.log(`settingReadBack.selftest: ${n} assertions passed`);
