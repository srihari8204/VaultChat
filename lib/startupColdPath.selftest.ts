import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readRootLayout } from '../scripts/rootLayoutSources';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const gate = read('lib/restoreGate.ts');
const index = read('app/index.tsx');
// app/_layout.tsx plus the boot sequence it calls (components/root/useBootSequence).
const layout = readRootLayout();
const api = read('lib/api.ts');
const pkg = JSON.parse(read('package.json'));

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
}

check('restore existence check is O(1)',
  /SELECT 1 AS x FROM chats LIMIT 1/.test(gate) && !gate.includes('getCachedChats'));
check('root gate uses one session snapshot',
  layout.includes('getLaunchSessionState()') &&
  !index.includes('getLaunchSessionState()'));

const snapshot = api.slice(
  api.indexOf('export async function getLaunchSessionState'),
  api.indexOf('/** Seal the current session', api.indexOf('export async function getLaunchSessionState')),
);
check('session snapshot reads sealed state at most once',
  (snapshot.match(/hasSealedSession\(\)/g) ?? []).length === 1);
check('session snapshot preserves sealed-lock routing',
  snapshot.includes('{ signedIn: true, sealedLocked: true }'));
check('release Android build excludes Expo dev tooling',
  // expo-dev-client is a real dependency (~6.0.20), so what actually keeps it
  // out of a release APK is this autolinking exclude — it is the invariant.
  //
  // 2026-09-21: this check also required EX_DEV_CLIENT_NETWORK_INSPECTOR=false
  // in android/gradle.properties. That assertion could never hold on a fresh
  // tree and was dropped, NOT weakened:
  //   * android/ is gitignored (.gitignore:43 `/android`) and has no tracked
  //     files — it is `expo prebuild` output, regenerated from scratch by
  //     build:android:apk (`expo prebuild --platform android --clean`).
  //   * nothing in the tracked repo ever writes that property. No config
  //     plugin touches gradle.properties and app.json's expo-build-properties
  //     does not set it, so prebuild emits the stock template line, which is
  //     `=true`. The commit that added the check (e407d6d) added the
  //     package.json exclude but no build-config change to pair with it.
  //   * reading the file at all was the wrong shape: a clean clone has no
  //     android/ tree, so the top-level read threw ENOENT before any check
  //     ran. lib/buildInputs.selftest.ts is the model here — it guards its
  //     android/ read with existsSync and says so when the tree is absent.
  // The property is moot once the modules are excluded: it is consumed by
  // expo-dev-launcher's gradle logic, and an unlinked module reads nothing.
  ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface']
    .every((name) => pkg.expo?.autolinking?.android?.exclude?.includes(name)));
check('protected content stays veiled until the root gate resolves',
  // 2026-09-19: the veil now also latches down once the redirect has landed
  // (`landed`), so the first navigation inside the auth flow no longer veils
  // the screen the user is typing into. 'checking' never sets the latch, so
  // the property this check names — veiled until the gate resolves — holds.
  layout.includes("const launchReady = launchGate === 'allow' || landed || launchGate === pathname") &&
  layout.includes('{!launchReady && (') &&
  layout.includes("importantForAccessibility={launchReady ? 'auto' : 'no-hide-descendants'}"));
check('FLAG_SECURE participates in the root gate',
  /Promise\.all\(\[secure, getLaunchSessionState\(\), isMfaEnabled\(\)\]\)/.test(layout));
check('deep-link splash is hidden only after the root gate',
  !layout.includes('Linking.getInitialURL()') &&
  /if \(launchReady\) SplashScreen\.hideAsync/.test(layout));
check('launch restore decision is local-only',
  index.includes('shouldCheckRestore()') &&
  !index.includes('shouldOfferRestore') &&
  !index.includes('cloudBackupMeta'));

const deferredAt = layout.indexOf('InteractionManager.runAfterInteractions');
for (const work of ['monitorService', 'monitorTriggers', 'cacheManager']) {
  check(`${work} starts after interactions`, layout.indexOf(work) > deferredAt);
}
check('root uses only the tiny LiveKit DOMException shim',
  layout.includes("import '../lib/domExceptionPolyfill'") &&
  !layout.includes("import '@livekit/react-native'"));
check('localDb warmup is deferred and dynamically imported',
  !/import \{ getLocalDb \} from '(\.\.\/)+lib\/localDb'/.test(layout) &&
  layout.indexOf("import('../../lib/localDb')") > deferredAt);
check('PDF thumbnail host is loaded after interactions',
  !/from '(\.\.\/)+(components\/)?PdfThumbnailer'/.test(layout) &&
  layout.indexOf("import('../PdfThumbnailer')") > deferredAt);
check('leftover chat-export sweep is deferred and dynamically imported',
  !/from '(\.\.\/)+(components\/)?chattools\/chatExportFile'/.test(layout) &&
  layout.indexOf("import('../chattools/chatExportFile')") > deferredAt);
check('scheduled runner stays off the static root import graph',
  !/from '(\.\.\/)+lib\/scheduledRunner'/.test(layout) &&
  layout.includes("import('../../lib/scheduledRunner')"));
check('embedded fonts remove root runtime font loading',
  !layout.includes('useFonts(') &&
  !layout.includes('@expo-google-fonts') &&
  layout.includes('<FontReadyContext.Provider value={true}>'));
check('killed-state task registrations remain at module scope',
  layout.indexOf("import '../lib/callBackground'") < layout.indexOf('function RootLayoutInner') &&
  layout.indexOf("import '../lib/syncBackground'") < layout.indexOf('function RootLayoutInner'));
check('socket and active security scan still start before deferred work',
  layout.indexOf('void getSocket()') < deferredAt && layout.indexOf('runSecurityCheck()') < deferredAt);
check('startup token reads are coalesced',
  api.includes('let _accessTokenPromise: Promise<string | null> | null = null') &&
  api.includes('let _refreshTokenPromise: Promise<string | null> | null = null') &&
  (api.match(/_accessTokenPromise = null/g) ?? []).length >= 3 &&
  (api.match(/_refreshTokenPromise = null/g) ?? []).length >= 3);

// ── Instrumentation honesty ────────────────────────────────────────────────
//
// Two things broke a cold-start investigation badly enough to be worth a guard.
//
// 1. db_ready used to be marked at a CALLER (app/_layout.tsx's deferred
//    warm-up). getLocalDb() is memoized, so that .then() fires when a resolved
//    promise is observed — it measured nothing, while the real first open
//    happens earlier via app/index.tsx -> shouldCheckRestore().
// 2. perf-debug labelled the three text-submit counters "Protobuf submits /
//    acks". They move only for an eligible outbound plain-text chat message,
//    so a healthy session that exchanged dozens of frames reads 0 / 0 — which
//    was then read as proof that no protobuf was on the wire.
const localDb = read('lib/localDb.ts');
const perfDebug = read('app/perf-debug.tsx');
const perf = read('lib/perf.ts');
const socket = read('lib/socket.ts');

check('instrumentation is measured at the real site, not at a caller',
  /mark\('db_open_start'\)/.test(localDb) && /mark\('db_ready'\)/.test(localDb) &&
  !layout.includes("mark('db_ready')"));
check('cold-path marks survive into release logs',
  ['db_open_start', 'db_ready', 'chats_paint_cache', 'chats_paint_net', 'socket_connect_start']
    .every((m) => /const BOOT_MARK = (\/[^\n]*\/)/.exec(perf) != null &&
      new RegExp(/const BOOT_MARK = \/([^\n]*)\/;/.exec(perf)[1]).test(m)));
check('CC-Wire connection timing is visible in boot marks',
  /mark\('socket_connect_start'\)/.test(socket) &&
  /mark\('socket_token_ready'\)/.test(socket) &&
  /mark\('socket_connect_ready'/.test(socket));
check('submit counters are not labelled as frame counters',
  !perfDebug.includes('Protobuf submits') &&
  perfDebug.includes('Text submits / acks (ccwire)') &&
  perfDebug.includes('Frames in / out'));

console.log('\nCold-path startup checks passed.');
