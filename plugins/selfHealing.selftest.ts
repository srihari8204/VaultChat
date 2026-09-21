// @ts-nocheck
// plugins/selfHealing.selftest.ts — run: npx tsx plugins/selfHealing.selftest.ts
//
// A CONFIG-PLUGIN MOD THAT CAN ONLY APPEND IS A MOD THAT SHIPS ITS FIRST DRAFT
// FOREVER.
//
// `expo prebuild` WITHOUT --clean preserves android/ and only re-applies the
// mods. A mod guarded by "append if my marker is absent" therefore writes its
// block once and can never correct it: the marker is already in the file, the
// guard skips, and whatever the FIRST prebuild emitted survives every later
// one. `--clean` (~25 minutes) is the only escape, and nothing announces the
// staleness — you find it on a device, or not at all.
//
// It has bitten three times:
//   1. MainApplication.kt kept a superseded System.loadLibrary("vaultbeamnative")
//      from withVaultBeamRust; cost cold-start time on every launch, found by a
//      device test.
//   2. app/build.gradle kept a strict inputs.file(rootProject.file(...)) after
//      withTransportCore moved to the lenient files() form; found by
//      lib/buildInputs.selftest.ts (commit ceac425).
//   3. CallForegroundService kept foregroundServiceType="microphone|camera"
//      after mediaProjection was added; screen share published encoded=0
//      size=0x0 with no error anywhere.
//
// So the invariant this file guards is not "the plugins are correct" but "the
// plugins can CHANGE THEIR MIND". Every mod below is driven twice against
// synthetic prebuild output, then once more against a tree deliberately left by
// an older plugin version, and asserted to converge on the current content —
// with brace and paren balance checked on everything emitted, because these
// strings become Kotlin and Groovy that has to compile.
//
// NOT DISCOVERED BY `npm test` YET: scripts/test-all.ts scans lib/ services/
// utils/ constants/ db/ hooks/ components/ scripts/ and not plugins/. Adding
// 'plugins' to its SEARCH_DIRS is the one-line change that wires this in.

import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// ── stub @expo/config-plugins so each mod callback can be driven directly ────
const mods: Array<{ kind: string; fn: Function }> = [];
const KINDS = ['withMainApplication', 'withMainActivity', 'withAppBuildGradle',
  'withSettingsGradle', 'withAndroidManifest', 'withGradleProperties',
  'withDangerousMod', 'withInfoPlist'];
const stub: any = {
  AndroidConfig: { Manifest: { getMainApplicationOrThrow: (m) => m.manifest.application[0] } },
};
for (const k of KINDS) {
  stub[k] = (config, arg) => {
    mods.push({ kind: k, fn: Array.isArray(arg) ? arg[1] : arg });
    return config;
  };
}
const realLoad = (Module as any)._load;
(Module as any)._load = function (req, parent, isMain) {
  if (req === '@expo/config-plugins') return stub;
  // Pretend the Rust toolchain is installed, so the toolchain-gated plugins
  // register their mods instead of returning early.
  if (req === 'child_process' || req === 'node:child_process') {
    return { ...realLoad(req, parent, isMain), execSync: () => '' };
  }
  return realLoad(req, parent, isMain);
};

let fails = 0;
function ok(name: string, cond: boolean, extra?: string): void {
  if (cond) { console.log('  ok  ' + name); return; }
  fails++;
  console.error('  FAIL ' + name + (extra ? '\n        ' + extra : ''));
}
function balanced(name: string, s: string): void {
  const n = (ch: string) => (s.split(ch).length - 1);
  ok(`${name}: braces balanced`, n('{') === n('}'), `{=${n('{')} }=${n('}')}`);
  ok(`${name}: parens balanced`, n('(') === n(')'), `(=${n('(')} )=${n(')')}`);
}
function load(file: string) {
  mods.length = 0;
  const p = path.join(ROOT, 'plugins', file);
  delete require.cache[require.resolve(p)];
  require(p)({});
  return mods.slice();
}
function run(fn: Function, contents: string, projectRoot = ROOT): string {
  const cfg = {
    modResults: { contents, language: 'kt' },
    modRequest: { projectRoot, platformProjectRoot: path.join(projectRoot, 'android') },
  };
  fn(cfg);
  return cfg.modResults.contents;
}

// ── fixtures: what `expo prebuild` actually emits ───────────────────────────
const MAIN_APP = [
  'class MainApplication : Application(), ReactApplication {',
  '  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(',
  '      this,',
  '      object : DefaultReactNativeHost(this) {',
  '        override fun getPackages(): List<ReactPackage> =',
  '            PackageList(this).packages.apply {',
  '              // add(MyReactNativePackage())',
  '            }',
  '      }',
  '  )',
  '  override fun onCreate() {',
  '    super.onCreate()',
  '    loadReactNative(this)',
  '  }',
  '}',
  '',
].join('\n');

const MAIN_ACTIVITY = [
  'package com.vaultchat.app',
  '',
  'import android.os.Build',
  'import android.os.Bundle',
  '',
  'class MainActivity : ReactActivity() {',
  '  override fun onCreate(savedInstanceState: Bundle?) {',
  '    super.onCreate(null)',
  '  }',
  '',
  '  override fun getMainComponentName(): String = "main"',
  '}',
  '',
].join('\n');

const APP_GRADLE = [
  'apply plugin: "com.android.application"',
  'android {',
  '    signingConfigs {',
  '        debug {',
  '            storeFile file("debug.keystore")',
  '        }',
  '    }',
  '    buildTypes {',
  '        debug {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '        release {',
  '            signingConfig signingConfigs.debug',
  '            minifyEnabled enableProguardInReleaseBuilds',
  '        }',
  '    }',
  '}',
  'dependencies {',
  '    implementation("com.facebook.react:react-android")',
  '}',
  '',
].join('\n');

const emptyManifest = () => ({
  manifest: {
    $: {},
    'uses-permission': [],
    application: [{ $: {}, activity: [{ $: { 'android:name': '.MainActivity' } }], service: [], receiver: [] }],
  },
});

// ══ withMainActivityNewIntent ═══════════════════════════════════════════════
console.log('\nwithMainActivityNewIntent — the onNewIntent body can be UPDATED');
{
  const fn = load('withMainActivityNewIntent.js').find((m) => m.kind === 'withMainActivity')!.fn;
  const once = run(fn, MAIN_ACTIVITY);
  ok('inserts the override', /override fun onNewIntent\(intent: Intent\)/.test(once));
  ok('inserts the import', once.includes('import android.content.Intent'));
  balanced('MainActivity.kt', once);
  ok('a second prebuild is a fixed point', run(fn, once) === once);
  ok('exactly one override, never two', (once.match(/override fun onNewIntent/g) || []).length === 1);

  const stale = once.replace('setIntent(intent)', 'setIntent(intent) // SUPERSEDED');
  const healed = run(fn, stale);
  ok('a superseded body is REPLACED, not preserved', !healed.includes('SUPERSEDED'));
  ok('the healed tree equals a fresh insert', healed === once);

  // A hand-written override carries no markers; it must survive untouched,
  // because silently deleting someone's code is worse than skipping.
  const hand = MAIN_ACTIVITY.replace('  override fun getMainComponentName',
    '  override fun onNewIntent(intent: Intent) { custom() }\n\n  override fun getMainComponentName');
  ok('a hand-written override is not clobbered', run(fn, hand).includes('custom()'));
}

// ══ withCryptoCore ══════════════════════════════════════════════════════════
console.log('\nwithCryptoCore — the loadLibrary line can be UPDATED');
{
  const fn = load('withCryptoCore.js').find((m) => m.kind === 'withMainApplication')!.fn;
  const once = run(fn, MAIN_APP);
  ok('inserts the guarded load', once.includes('System.loadLibrary("vaultcrypto")'));
  balanced('MainApplication.kt', once);
  ok('a second prebuild is a fixed point', run(fn, once) === once);
  ok('exactly one load line', (once.match(/loadLibrary\("vaultcrypto"\)/g) || []).length === 1);

  const stale = once.replace('"native crypto unavailable — TS fallback"', '"OLD MESSAGE"');
  const healed = run(fn, stale);
  ok('a superseded log message is REPLACED', !healed.includes('OLD MESSAGE'));
  ok('the healed tree equals a fresh insert', healed === once);
}

// ══ withVaultBeamRust ═══════════════════════════════════════════════════════
console.log('\nwithVaultBeamRust — the eager vaultbeamnative load is stripped');
{
  const fn = load('withVaultBeamRust.js').find((m) => m.kind === 'withMainApplication')!.fn;
  const clean = run(fn, MAIN_APP);
  const stale = MAIN_APP.replace('    super.onCreate()',
    '    super.onCreate()\n    try { System.loadLibrary("vaultbeamnative") } catch (t: Throwable) { android.util.Log.w("VaultBeamCore", "x", t) }');
  const healed = run(fn, stale);
  ok('the stale eager load is gone', !/System\.loadLibrary\("vaultbeamnative"\)/.test(healed));
  ok('super.onCreate() survives', healed.includes('super.onCreate()'));
  ok('the Rust package is still registered', healed.includes('VaultBeamStreamRustPackage()'));
  ok('only that one line was removed', healed.split('\n').length === clean.split('\n').length);
  ok('the healed tree equals a tree that never had it', healed === clean);
  balanced('MainApplication.kt', healed);
  ok('a no-op on a tree that never had it', run(fn, clean) === clean);
}

// ══ withReleaseSigning ══════════════════════════════════════════════════════
console.log('\nwithReleaseSigning — ROTATED credentials reach an existing tree');
{
  const fn = load('withReleaseSigning.js').find((m) => m.kind === 'withAppBuildGradle')!.fn;
  // A throwaway projectRoot, so the real (gitignored) keystore.properties is
  // neither read nor written by a test.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-'));
  const write = (pw: string) => fs.writeFileSync(path.join(tmp, 'keystore.properties'),
    `VAULTCHAT_STORE_FILE=vaultchat-release.jks\nVAULTCHAT_STORE_PASSWORD=${pw}\nVAULTCHAT_KEY_ALIAS=vaultchat\n`);
  try {
    write('OLDPASS');
    const once = run(fn, APP_GRADLE, tmp);
    ok('adds the signing config', once.includes('vaultchatRelease {'));
    ok('repoints buildTypes.release off the debug key',
      /release \{[\s\S]*?signingConfig signingConfigs\.vaultchatRelease/.test(once));
    ok('the debug buildType still uses the debug key',
      /debug \{\n            signingConfig signingConfigs\.debug/.test(once));
    balanced('app/build.gradle', once);
    ok('a second prebuild is a fixed point', run(fn, once, tmp) === once);

    write('NEWPASS');
    const rotated = run(fn, once, tmp);
    ok('a rotated password reaches the generated gradle', rotated.includes('NEWPASS'));
    ok('the superseded password is gone', !rotated.includes('OLDPASS'));
    ok('still exactly one signing block', (rotated.match(/vaultchatRelease \{/g) || []).length === 1);
    balanced('app/build.gradle (rotated)', rotated);

    // No credentials at all must stay a no-op: removing the block while
    // buildTypes.release still referenced it would break the build outright.
    fs.unlinkSync(path.join(tmp, 'keystore.properties'));
    ok('no keystore.properties leaves the tree untouched', run(fn, rotated, tmp) === rotated);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ══ withVaultChatCalls ══════════════════════════════════════════════════════
console.log('\nwithVaultChatCalls — FCM version and service type can be UPDATED');
{
  const all = load('withVaultChatCalls.js');
  const gradle = all.filter((m) => m.kind === 'withAppBuildGradle');
  const fn = gradle[gradle.length - 1].fn;   // withFirebaseMessaging
  const once = run(fn, APP_GRADLE);
  ok('adds firebase-messaging', /com\.google\.firebase:firebase-messaging:[\d.]+/.test(once));
  balanced('app/build.gradle', once);
  ok('a second prebuild is a fixed point', run(fn, once) === once);
  ok('exactly one firebase-messaging line', (once.match(/firebase-messaging/g) || []).length === 1);

  const stale = once.replace(/firebase-messaging:[\d.]+/, 'firebase-messaging:23.0.0');
  const healed = run(fn, stale);
  ok('a superseded VERSION is re-pinned', !healed.includes('23.0.0'));
  ok('the healed tree equals a fresh insert', healed === once);
  balanced('app/build.gradle (healed)', healed);

  const manifestMods = all.filter((m) => m.kind === 'withAndroidManifest');
  const apply = (m) => manifestMods.forEach((mm) => mm.fn({ modResults: m, modRequest: {} }));
  const m = emptyManifest();
  apply(m);
  const svc = () => m.manifest.application[0].service.filter((s) => /CallForegroundService/.test(s.$['android:name']));
  ok('the call service is declared', svc().length === 1);
  ok('with the full foregroundServiceType',
    svc()[0].$['android:foregroundServiceType'] === 'microphone|camera|mediaProjection');
  svc()[0].$['android:foregroundServiceType'] = 'microphone|camera';   // the pre-mediaProjection tree
  apply(m);
  ok('a frozen service type is CORRECTED on the next prebuild',
    svc()[0].$['android:foregroundServiceType'] === 'microphone|camera|mediaProjection');
  ok('and is not duplicated', svc().length === 1);
}

// ══ the other two foreground services ═══════════════════════════════════════
for (const [file, needle, want] of [
  ['withVaultChatGoLive.js', 'GoLiveForegroundService', 'microphone|camera|mediaProjection'],
  ['withVaultBeamStream.js', 'VaultBeamForegroundService', 'dataSync'],
] as const) {
  console.log(`\n${file} — the foregroundServiceType can be UPDATED`);
  const fn = load(file).filter((m) => m.kind === 'withAndroidManifest')[0].fn;
  const m = emptyManifest();
  const find = () => m.manifest.application[0].service.filter((s) => s.$['android:name'].includes(needle));
  fn({ modResults: m, modRequest: {} });
  ok('declared with the right type', find()[0].$['android:foregroundServiceType'] === want);
  find()[0].$['android:foregroundServiceType'] = 'stale';
  fn({ modResults: m, modRequest: {} });
  ok('a stale type is CORRECTED', find()[0].$['android:foregroundServiceType'] === want);
  ok('and is not duplicated', find().length === 1);
}

console.log(fails ? `\n  ${fails} FAILED\n` : '\n  all config-plugin self-healing checks passed\n');
process.exit(fails ? 1 : 0);
