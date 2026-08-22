// scanner.selftest.ts — the BLE scanner's failure paths.
//
// Lives in its own file, NOT an embedded `require.main === module` block:
// a source-scanning self-check inside a shipped module breaks
// assembleRelease (Metro follows the require('fs')). Run with:
//   npx tsx lib/items/scanner.selftest.ts
//
// Why this exists: on device the search button did nothing at all. No error,
// no dialog, no spinner — tap after tap. The BT stack showed a lone
// `stop_scan` and never a `start_scan`. Every one of these checks fails
// against the version of scanner.ts that shipped that behaviour.

/* eslint-disable @typescript-eslint/no-require-imports */

// ── stub the native module BEFORE scanner.ts is loaded ──
// react-native-ble-plx IS installed, so a plain require would pull the real
// native binding and throw under node. Intercept the loader instead.
const Module = require('module') as any;
const realLoad = Module._load;

interface FakeScanCall { cb: (err: any, dev: any) => void }
let scanCalls: FakeScanCall[] = [];
let stopCalls = 0;
let constructThrows = false;
let startThrows = false;

class FakeBleManager {
  constructor() { if (constructThrows) throw new Error('native module not linked'); }
  startDeviceScan(_uuids: any, _opts: any, cb: (err: any, dev: any) => void) {
    if (startThrows) throw new Error('adapter busy');
    scanCalls.push({ cb });
  }
  stopDeviceScan() { stopCalls++; }
  destroy() {}
}

Module._load = function (req: string, ...rest: any[]) {
  if (req === 'react-native-ble-plx') return { BleManager: FakeBleManager };
  // react-native's index.js is Flow-typed and esbuild cannot parse it. The
  // scanner only needs Platform + PermissionsAndroid for the Android runtime
  // permission prompt, which is not what these checks exercise.
  if (req === 'react-native') {
    return {
      Platform: { OS: 'android', Version: 31 },
      PermissionsAndroid: {
        PERMISSIONS: {}, RESULTS: { GRANTED: 'granted' },
        requestMultiple: async () => ({}),
      },
    };
  }
  return realLoad.call(this, req, ...rest);
};

const scanner = require('./scanner');
const { startScan, bleLastError, destroyScanner } = scanner;

const fail = (m: string) => { throw new Error(m); };
const reset = () => {
  scanCalls = []; stopCalls = 0; constructThrows = false; startThrows = false;
  destroyScanner();
};

async function run() {
  // 1 ── happy path still works
  reset();
  const seen: any[] = [];
  const stop = await startScan((s: any) => seen.push(s));
  if (typeof stop !== 'function') fail('1: a successful scan must return a stop function');
  if (scanCalls.length !== 1) fail(`1: expected one startDeviceScan, got ${scanCalls.length}`);
  scanCalls[0].cb(null, { id: 'aa:bb', name: 'Tag', rssi: -60 });
  if (seen.length !== 1) fail('1: a valid advertisement must reach onSeen');
  if (seen[0].id !== 'aa:bb') fail('1: wrong device id forwarded');

  // 2 ── THE BUG: an async scan error must be recorded, not swallowed.
  // Old code: `if (err || !dev?.id) return;` — the screen sat there forever
  // with no results and no explanation.
  reset();
  await startScan(() => {});
  scanCalls[0].cb(new Error('SCAN_FAILED_APPLICATION_REGISTRATION_FAILED'), null);
  const rec = bleLastError();
  if (!rec) fail('2: a scan error must be recorded in bleLastError()');
  if (!/REGISTRATION_FAILED/.test(rec)) fail(`2: wrong error recorded: ${rec}`);

  // 3 ── and it must be reported to the caller, or the UI cannot say anything
  reset();
  let reported: string | null = null;
  await startScan(() => {}, (e: string) => { reported = e; });
  scanCalls[0].cb(new Error('boom'), null);
  if (!reported) fail('3: an async scan failure must invoke the onError callback');

  // 4 ── after a failure the next attempt must REALLY start a scan.
  // Old code set `scanning = true` before knowing the scan took, and never
  // cleared it on error, so every later tap only emitted stop_scan. This is
  // the check that reproduces the dead button.
  reset();
  await startScan(() => {});
  scanCalls[0].cb(new Error('registration failed'), null);
  const before = scanCalls.length;
  await startScan(() => {});
  if (scanCalls.length !== before + 1) {
    fail(`4: retry after a failed scan must call startDeviceScan again (got ${scanCalls.length - before})`);
  }

  // 5 ── a construction failure must return null, not a truthy no-op.
  // The caller guards with `if (!stopRef.current)`; a `() => {}` is truthy, so
  // that guard could never fire and the alert was unreachable.
  reset();
  constructThrows = true;
  const s5 = await startScan(() => {});
  if (s5) fail('5: a manager construction failure must return null');
  if (!bleLastError()) fail('5: construction failure must be recorded');

  // 6 ── a synchronous throw from startDeviceScan must not escape
  reset();
  startThrows = true;
  let threw = false;
  let s6: any;
  try { s6 = await startScan(() => {}); } catch { threw = true; }
  if (threw) fail('6: startScan must never let a native throw escape to an async caller');
  if (s6) fail('6: a failed start must return null');
  if (!bleLastError()) fail('6: the throw must be recorded');

  // 7 ── stop is idempotent
  reset();
  const stop7 = await startScan(() => {});
  const n = stopCalls;
  stop7!(); stop7!();
  if (stopCalls !== n + 1) fail(`7: stop must be safe to call twice (${stopCalls - n} native stops)`);

  console.log('scanner.selftest: all 7 checks passed');
}

run().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
