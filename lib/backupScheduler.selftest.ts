// lib/backupScheduler.selftest.ts — run: npx tsx lib/backupScheduler.selftest.ts
//
// Executes the REAL runScheduledBackupIfDue() / getBackupSettings() from
// lib/backupScheduler.ts.
//
// WHAT THIS GUARDS
//
// "Uninstall the app and your chat history is gone forever" was not one bug, it
// was three, and all of them were silent — the backup screen reported success,
// the restore prompt existed and was correct, and nothing anywhere logged that
// the two were pointed at different stores:
//
//   1. the schedule defaulted to 'manual', so nothing ever ran;
//   2. a migration actively flipped installs from 'daily' to 'manual', so the
//      users carrying the bug longest were the ones it would never reach;
//   3. the scheduled run wrote a LOCAL file (BACKUP_ROOT is inside the app
//      sandbox — deleted by the uninstall) and attempted a silent Google Drive
//      upload (skipped unless already signed in, absent on no-GMS devices), but
//      never called uploadCloudBackup(). The server copy is the only one that
//      survives a reinstall, and it is what the restore prompt in
//      (tabs)/chats.tsx asks for via cloudBackupMeta() — so that prompt got
//      `exists:false` for every user and never fired.
//
// Plus one that would have re-created the same class of silence: the timer was
// reset even when every destination failed, so a permanently-failing account
// waited a full day between attempts while reporting itself backed up.
//
// backupScheduler.ts cannot be imported under Node (react-native, AsyncStorage),
// so its IMPORT BLOCK ONLY is rewritten to point at stubs and the body is used
// verbatim — regenerated on every run, so it cannot drift from what ships. Same
// approach as messageQueue.flush.selftest.ts.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── build a runnable copy: imports rewritten, body untouched ──────────────
const WORK = join(tmpdir(), `vc-backup-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

const STUBS = `
const H = () => globalThis.__H;
export default {
  async getItem(k) { return H().store[k] ?? null; },
  async setItem(k, v) { H().store[k] = v; },
};
export const NetInfo = { async fetch() { return H().net; } };
export async function uploadCloudBackup()   { H().calls.push('cloud');  if (H().fail.cloud) throw new Error('cloud down'); return { messageCount: 1, sizeBytes: 1 }; }
export async function writeLocalBackup()    { H().calls.push('local');  if (H().fail.local) throw new Error('local down'); return { path: '/x', messageCount: 1, sizeBytes: 1 }; }
export async function backupToGoogleDrive() { H().calls.push('drive');  if (H().fail.drive) throw new Error('drive down'); return { messageCount: 1, sizeBytes: 1 }; }
`;
writeFileSync(join(WORK, 'stubs.js'), STUBS);

const IMPORT_REWRITES: [RegExp, string][] = [
  [/^import NetInfo from '@react-native-community\/netinfo';$/m, `import { NetInfo } from './stubs.js';`],
  [/^import AsyncStorage from '@react-native-async-storage\/async-storage';$/m, `import AsyncStorage from './stubs.js';`],
  [/^import \{ writeLocalBackup, backupToGoogleDrive, uploadCloudBackup \} from '\.\/cloudBackup';$/m,
   `import { writeLocalBackup, backupToGoogleDrive, uploadCloudBackup } from './stubs.js';`],
];

let src = readFileSync(join(HERE, 'backupScheduler.ts'), 'utf8');
for (const [re, to] of IMPORT_REWRITES) {
  if (!re.test(src)) {
    console.log(`  ✗ selftest could not rewrite an import — backupScheduler.ts changed its import block (${re})`);
    failures++;
  }
  src = src.replace(re, to);
}
const stray = [...src.matchAll(/^import .*from '([^']+)';$/gm)].map(m => m[1]).filter(p => p !== './stubs.js');
check('every backupScheduler import is accounted for', stray.length === 0, `unstubbed: ${stray.join(', ')}`);
writeFileSync(join(WORK, 'bs.ts'), src);

// ── harness state ─────────────────────────────────────────────────────────
const H: any = {
  store: {} as Record<string, string>,
  calls: [] as string[],
  fail: { cloud: false, local: false, drive: false },
  net: { isConnected: true, type: 'wifi' },
};
(globalThis as any).__H = H;

function reset(store: Record<string, string> = {}) {
  H.store = { ...store };
  H.calls = [];
  H.fail = { cloud: false, local: false, drive: false };
  H.net = { isConnected: true, type: 'wifi' };
}
const SETTINGS_KEY = 'vc_backup_settings';
const settings = (o: any) => ({ [SETTINGS_KEY]: JSON.stringify(o) });
const saved = () => JSON.parse(H.store[SETTINGS_KEY] ?? '{}');

// Wrapped: this repo compiles as CJS under tsx, so there is no top-level await.
async function main() {
const B: any = await import(pathToFileURL(join(WORK, 'bs.ts')).href);

// ── 1. the default ────────────────────────────────────────────────────────
// A fresh install must back up on its own. This is the entire fix: with
// 'manual' here, every user below is one uninstall away from losing everything.
console.log('\nA fresh install backs up automatically:');
reset();
let s = await B.getBackupSettings();
check("default frequency is 'daily', not 'manual'", s.frequency === 'daily', `got '${s.frequency}'`);
check("default network policy is Wi-Fi only", s.network === 'wifi', `got '${s.network}'`);

// ── 2. the migration ──────────────────────────────────────────────────────
console.log('\nInstalls that were force-flipped OFF get turned back on, once:');
reset({ ...settings({ frequency: 'manual', network: 'wifi', includeVideos: false, lastBackupAt: 0 }),
        vc_backup_auto_off_v1: '1' });
s = await B.getBackupSettings();
check('a forced-manual install is restored to daily', s.frequency === 'daily', `got '${s.frequency}'`);
check('and the flip is persisted', saved().frequency === 'daily');

// Idempotent: the user must be able to turn it off again and have it STAY off.
// Without the one-shot flag this would re-enable on every read and the setting
// would be impossible to change.
H.store[SETTINGS_KEY] = JSON.stringify({ ...saved(), frequency: 'manual' });
s = await B.getBackupSettings();
check('turning it off again after the migration sticks', s.frequency === 'manual', `got '${s.frequency}'`);

// A deliberate 'manual' — no auto-off flag — was the user's own choice and is
// not ours to overrule.
console.log('\nA deliberate choice is left alone:');
reset(settings({ frequency: 'manual', network: 'wifi', includeVideos: false, lastBackupAt: 0 }));
s = await B.getBackupSettings();
check("user-chosen 'manual' is respected", s.frequency === 'manual', `got '${s.frequency}'`);
reset(settings({ frequency: 'weekly', network: 'any', includeVideos: false, lastBackupAt: 0 }));
s = await B.getBackupSettings();
check("user-chosen 'weekly' is respected", s.frequency === 'weekly', `got '${s.frequency}'`);

// ── 3. the destination that actually matters ──────────────────────────────
// THE defect. Local dies with the app; Drive is absent on no-GMS handsets. If
// the server copy is not written, cloudBackupMeta() says `exists:false` and the
// restore prompt never appears — which is precisely what shipped.
console.log('\nA due backup reaches the server, not just the sandbox:');
reset();
await B.runScheduledBackupIfDue();
check('uploadCloudBackup() is called', H.calls.includes('cloud'), `called: [${H.calls}]`);
check('the server copy is attempted FIRST', H.calls[0] === 'cloud', `order: [${H.calls}]`);
check('local + Drive still run as secondary copies',
  H.calls.includes('local') && H.calls.includes('drive'), `called: [${H.calls}]`);

// A failing cloud upload must not abort the other destinations — a same-install
// local restore is still worth having.
console.log('\nOne broken destination does not cancel the others:');
reset();
H.fail.cloud = true;
await B.runScheduledBackupIfDue();
check('local + Drive still attempted after a cloud failure',
  H.calls.includes('local') && H.calls.includes('drive'), `called: [${H.calls}]`);

// ── 4. the timer ──────────────────────────────────────────────────────────
console.log('\nThe due-timer only advances on a backup that happened:');
reset();
await B.runScheduledBackupIfDue();
check('a successful run stamps lastBackupAt', saved().lastBackupAt > 0);

reset();
H.fail = { cloud: true, local: true, drive: true };
await B.runScheduledBackupIfDue();
check('a total failure does NOT stamp lastBackupAt (retries next launch)',
  !(saved().lastBackupAt > 0), `got ${saved().lastBackupAt}`);

// Not yet due — nothing should be built or uploaded. Building the bundle reads
// every message plus the plaintext cache, so an un-gated run would be a full
// history scan on each app open.
console.log('\nAn undue backup does no work:');
reset(settings({ frequency: 'daily', network: 'wifi', includeVideos: false, lastBackupAt: Date.now() }));
await B.runScheduledBackupIfDue();
check('nothing runs before the interval elapses', H.calls.length === 0, `called: [${H.calls}]`);

console.log('\n\'manual\' still means off:');
reset(settings({ frequency: 'manual', network: 'wifi', includeVideos: false, lastBackupAt: 0 }));
await B.runScheduledBackupIfDue();
check('an off schedule uploads nothing', H.calls.length === 0, `called: [${H.calls}]`);

// ── 5. network policy ─────────────────────────────────────────────────────
// The bundle is the user's whole history; pushing it over cellular by default
// would be a real bill. Wi-Fi-only must survive this change.
console.log('\nWi-Fi-only is honoured (the bundle is the whole history):');
reset();
H.net = { isConnected: true, type: 'cellular' };
await B.runScheduledBackupIfDue();
check('wifi-only + cellular uploads nothing', H.calls.length === 0, `called: [${H.calls}]`);

reset(settings({ frequency: 'daily', network: 'any', includeVideos: false, lastBackupAt: 0 }));
H.net = { isConnected: true, type: 'cellular' };
await B.runScheduledBackupIfDue();
check("'any' + cellular does upload", H.calls.includes('cloud'), `called: [${H.calls}]`);

reset();
H.net = { isConnected: false, type: 'none' };
await B.runScheduledBackupIfDue();
check('offline uploads nothing', H.calls.length === 0, `called: [${H.calls}]`);

rmSync(WORK, { recursive: true, force: true });
}

main().then(() => {
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.message ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
