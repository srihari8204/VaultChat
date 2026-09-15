import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const gate = read('lib/restoreGate.ts');
const index = read('app/index.tsx');
const layout = read('app/_layout.tsx');
const api = read('lib/api.ts');

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
check('protected content stays veiled until the root gate resolves',
  layout.includes("const launchReady = launchGate === 'allow' || launchGate === pathname") &&
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
  !layout.includes("import { getLocalDb } from '../lib/localDb'") &&
  layout.indexOf("import('../lib/localDb')") > deferredAt);
check('PDF thumbnail host is loaded after interactions',
  !layout.includes("import { PdfThumbnailerHost } from '../components/PdfThumbnailer'") &&
  layout.indexOf("import('../components/PdfThumbnailer')") > deferredAt);
check('scheduled runner stays off the static root import graph',
  !layout.includes("from '../lib/scheduledRunner'") &&
  layout.includes("import('../lib/scheduledRunner')"));
check('embedded fonts remove root runtime font loading',
  !layout.includes('useFonts(') &&
  !layout.includes('@expo-google-fonts') &&
  layout.includes('<FontReadyContext.Provider value={true}>'));
check('killed-state task registrations remain at module scope',
  layout.indexOf("import '../lib/callBackground'") < layout.indexOf('function RootLayoutInner') &&
  layout.indexOf("import '../lib/syncBackground'") < layout.indexOf('function RootLayoutInner'));
check('socket and active security scan still start before deferred work',
  layout.indexOf('void getSocket()') < deferredAt && layout.indexOf('runSecurityCheck()') < deferredAt);

console.log('\nCold-path startup checks passed.');
