/**
 * Node self-test for the native-scan → signals mapper.
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the VaultShield bridge maps raw booleans to the right signals, reports
 * the platform's evaluable set honestly (so unfound = clear, not pending),
 * gates the re-sign check on a configured baseline, and applies the
 * accessibility allowlist.
 */
import { mapNativeScan } from './nativeMap';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
const has = (r: { signals: { type: string }[] }, t: string) => r.signals.some((s) => s.type === t);

(async () => {
  console.log('\nVaultChat native-map self-test\n──────────────────────────────────');

  // ── Android clean ────────────────────────────────────────────────
  console.log('Android:');
  const clean = mapNativeScan({ rooted: false, debugger: false, frida: false, accessibilityServices: [] }, 'android');
  check('clean scan → no signals', clean.signals.length === 0);
  check('android evaluable set reported (≥10)', clean.evaluatedTypes.length >= 10);
  check('root evaluated even when clean', clean.evaluatedTypes.includes('ROOT_DETECTED'));

  const bad = mapNativeScan({
    rooted: true, rootApp: 'com.topjohnwu.magisk', suBinary: true, suDetail: '/system/xbin/su',
    magisk: true, debugger: true, tracerPid: 1234, frida: true, fridaDetail: 'port 27042 open',
    hookFramework: true, hookDetail: 'lspd', emulator: true, devOptions: true, adb: true,
    accessibilityServices: ['com.evil.spy/.Svc'],
  }, 'android');
  check('root mapped', has(bad, 'ROOT_DETECTED'));
  check('su binary mapped', has(bad, 'SU_BINARY_FOUND'));
  check('magisk mapped', has(bad, 'MAGISK_DETECTED'));
  check('debugger mapped', has(bad, 'DEBUGGER_ATTACHED'));
  check('frida mapped', has(bad, 'FRIDA_DETECTED'));
  check('hook framework mapped', has(bad, 'HOOK_FRAMEWORK'));
  check('emulator mapped', has(bad, 'EMULATOR_DETECTED'));
  check('dev options mapped', has(bad, 'DEV_OPTIONS_ON'));
  check('adb → USB debugging mapped', has(bad, 'USB_DEBUGGING_ON'));
  check('unknown a11y service → accessibility risk', has(bad, 'ACCESSIBILITY_RISK'));

  // ── Accessibility allowlist ──────────────────────────────────────
  console.log('Accessibility allowlist:');
  const talkback = mapNativeScan({ accessibilityServices: ['com.google.android.marvin.talkback/.TalkBackService'] }, 'android');
  check('allowlisted service → no risk', !has(talkback, 'ACCESSIBILITY_RISK'));

  // ── Re-sign gating ───────────────────────────────────────────────
  console.log('Re-sign check:');
  // "No baseline" is stated explicitly rather than inferred from the shipped
  // EXPECTED_SIGNING_SHA256 being blank — that constant is filled in for
  // release builds, so inferring it made this case depend on release state.
  const noBaseline = mapNativeScan({ signingSha256: 'abc123' }, 'android', { expectedSigning: '' });
  check('no baseline → APK_RESIGNED not evaluated', !noBaseline.evaluatedTypes.includes('APK_RESIGNED') && !has(noBaseline, 'APK_RESIGNED'));
  // The gate must actually be live in shipped builds: with the default
  // baseline, a foreign signing cert is caught.
  const shipped = mapNativeScan({ signingSha256: 'abc123' }, 'android');
  check('shipped baseline is configured → foreign cert caught',
    shipped.evaluatedTypes.includes('APK_RESIGNED') && has(shipped, 'APK_RESIGNED'));
  const match = mapNativeScan({ signingSha256: 'ABC123' }, 'android', { expectedSigning: 'abc123' });
  check('matching cert → evaluated, no signal', match.evaluatedTypes.includes('APK_RESIGNED') && !has(match, 'APK_RESIGNED'));
  const mismatch = mapNativeScan({ signingSha256: 'deadbeef' }, 'android', { expectedSigning: 'abc123' });
  check('mismatched cert → APK_RESIGNED signal', has(mismatch, 'APK_RESIGNED'));

  // ── iOS ──────────────────────────────────────────────────────────
  console.log('iOS:');
  const jb = mapNativeScan({ jailbroken: true, jailbreakDetail: 'path:/Applications/Cydia.app', debugger: false }, 'ios');
  check('jailbreak mapped', has(jb, 'JAILBREAK_DETECTED'));
  check('iOS evaluable set (5)', jb.evaluatedTypes.length === 5);
  check('iOS does not evaluate android-only types', !jb.evaluatedTypes.includes('USB_DEBUGGING_ON'));
  const iosClean = mapNativeScan({ jailbroken: false }, 'ios');
  check('iOS clean → no signals but jailbreak evaluated', iosClean.signals.length === 0 && iosClean.evaluatedTypes.includes('JAILBREAK_DETECTED'));

  // ── Web / unknown ────────────────────────────────────────────────
  check('web platform → nothing evaluated', mapNativeScan({}, 'web').evaluatedTypes.length === 0);
  check('null raw → safe empty', mapNativeScan(null, 'android').signals.length === 0);

  console.log('──────────────────────────────────');
  if (failures === 0) { console.log('ALL NATIVE-MAP TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
