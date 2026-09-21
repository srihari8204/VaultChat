/**
 * withVaultChatCalls — Expo config plugin for production call reliability.
 *
 * Android:
 *  - permissions (FOREGROUND_SERVICE[_MICROPHONE|_CAMERA], POST_NOTIFICATIONS,
 *    USE_FULL_SCREEN_INTENT, WAKE_LOCK, battery/lock-screen)
 *  - <service> CallForegroundService (foregroundServiceType microphone|camera)
 *  - <service> VaultCallMessagingService (FCM MESSAGING_EVENT)
 *  - <receiver> CallActionReceiver
 *  - copies the Kotlin sources from plugins/android into the app package
 *  - registers CallPackage in MainApplication
 *
 * iOS:
 *  - background modes: audio + remote-notification. `voip` is GATED behind
 *    IOS_CALLKIT_IMPLEMENTED below — see the note there before flipping it.
 *    The PushKit/CallKit Swift glue is documented in CALLS_README.md (manual
 *    AppDelegate addition) since a robust automated Swift patch is brittle.
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
  withInfoPlist,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const CALLS_PKG = `${PKG}.calls`;
const KOTLIN = ['CallForegroundService.kt', 'VaultCallMessagingService.kt', 'CallModule.kt', 'CallPackage.kt'];

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',   // in-call screen share (#124)
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.DISABLE_KEYGUARD',
  'android.permission.RECEIVE_BOOT_COMPLETED',
];

function withPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const existing = new Set(manifest['uses-permission'].map((p) => p.$['android:name']));
    for (const name of PERMISSIONS) {
      if (!existing.has(name)) manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
    return cfg;
  });
}

/**
 * PiP on MainActivity, applied by the plugin so a prebuild cannot lose it.
 *
 * Back on a call screen enters Picture-in-Picture instead of hanging up
 * (CallModule.enterPip). That needs android:supportsPictureInPicture, and
 * smallestScreenSize in configChanges — without the latter the PiP resize
 * RESTARTS the activity, which tears the call down: exactly the bug PiP was
 * added to fix, in a form that only shows up on the resize.
 *
 * This lived in the GENERATED AndroidManifest.xml, where the next
 * `expo prebuild` would silently drop it and PiP would stop working with no
 * error anywhere. Config is the only durable home for it.
 */
function withPipActivity(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const main = (app.activity || []).find((a) => a.$['android:name'] === '.MainActivity');
    if (main) {
      main.$['android:supportsPictureInPicture'] = 'true';
      // The other half of the lock-screen ring. setFullScreenIntent() launches
      // MainActivity, but the KEYGUARD still sits in front of it unless the
      // activity itself declares these — the phone lights up and shows the lock
      // screen instead of the call. API 27+ manifest attributes, so they are the
      // whole fix; no code change and nothing to request at runtime.
      main.$['android:showWhenLocked'] = 'true';
      main.$['android:turnScreenOn'] = 'true';
      const cc = main.$['android:configChanges'] || '';
      if (!cc.includes('smallestScreenSize')) {
        main.$['android:configChanges'] = cc ? `${cc}|smallestScreenSize` : 'smallestScreenSize';
      }
    }
    return cfg;
  });
}

function withServices(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    app.receiver = app.receiver || [];

    const hasService = (name) => app.service.some((s) => s.$['android:name'] === name);
    const hasReceiver = (name) => app.receiver.some((s) => s.$['android:name'] === name);

    // FIND-OR-CREATE, then ALWAYS assign — not push-if-absent.
    //
    // android/ is prebuild OUTPUT that a plain `expo prebuild` preserves, so a
    // push-if-absent mod can ADD this service once and then never CORRECT it:
    // the name is already there, the guard skips, and whatever attributes the
    // first prebuild wrote survive every later one. That is not hypothetical
    // here — foregroundServiceType gained `mediaProjection` after this service
    // already existed, and on any tree generated before that the type stayed
    // `microphone|camera`, which is precisely the encoded=0 size=0x0 silent
    // failure described below. Assigning unconditionally is what makes a
    // changed type actually reach an existing tree.
    {
      const NAME = `${CALLS_PKG}.CallForegroundService`;
      let svc = app.service.find((s) => s.$['android:name'] === NAME);
      if (!svc) { svc = { $: { 'android:name': NAME } }; app.service.push(svc); }
      Object.assign(svc.$, {
          'android:exported': 'false',
          // mediaProjection is REQUIRED for screen share on Android 14+.
          //
          // createVirtualDisplay() is refused unless a foreground service of
          // that type is running, and on device the capture then produced
          // nothing at all — `dumpsys` showed our service at types=0x000000C0
          // (camera|microphone, no 0x20) while the screen track reported
          // encoded=0 size=0x0. Declaring it here is the half that must exist
          // before the service can ever ADD the type at runtime, which it does
          // only after the user has granted the projection (Android forbids
          // starting this type without a live projection token).
          'android:foregroundServiceType': 'microphone|camera|mediaProjection',
      });
    }
    if (!hasService(`${CALLS_PKG}.VaultCallMessagingService`)) {
      app.service.push({
        $: { 'android:name': `${CALLS_PKG}.VaultCallMessagingService`, 'android:exported': 'false' },
        'intent-filter': [{ action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] }],
      });
    }
    if (!hasReceiver(`${CALLS_PKG}.CallActionReceiver`)) {
      app.receiver.push({
        $: { 'android:name': `${CALLS_PKG}.CallActionReceiver`, 'android:exported': 'false' },
      });
    }
    return cfg;
  });
}

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...CALLS_PKG.split('.'),
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of KOTLIN) {
        const from = path.join(srcDir, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destDir, f));
      }
      return cfg;
    },
  ]);
}

function withPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(`${CALLS_PKG}.CallPackage()`)) return cfg;   // already registered
    const add = `add(${CALLS_PKG}.CallPackage())`;

    // Current Expo (SDK 50+) Kotlin template:
    //   override fun getPackages(): List<ReactPackage> =
    //     PackageList(this).packages.apply {
    //       // add(MyReactNativePackage())
    //     }
    if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      // Older block form: val packages = PackageList(this).packages … return packages
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(`[withVaultChatCalls] could not auto-register CallPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

// Native FCM SDK so VaultCallMessagingService (a FirebaseMessagingService) has
// com.google.firebase.messaging on the classpath. The project shims the JS
// @react-native-firebase to the web SDK, but this is the native Gradle lib and
// is independent of that shim. The google-services plugin + json are already set
// up by the base config, so only the dependency is needed.
const FIREBASE_MESSAGING = 'com.google.firebase:firebase-messaging:24.1.1';
function withFirebaseMessaging(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    // Re-pin the VERSION before the guard below decides there is nothing to do.
    // app/build.gradle is prebuild output that a plain `expo prebuild` keeps,
    // and the guard matches on the artifact name, not the coordinate — so
    // bumping FIREBASE_MESSAGING above would land in every fresh tree and in no
    // existing one, leaving a build whose FCM version silently disagrees with
    // this file forever. Only the coordinate is rewritten: no quoting, no
    // parentheses and no braces are touched, so the surrounding `implementation`
    // line keeps whatever shape it had.
    src = src.replace(/com\.google\.firebase:firebase-messaging:[^"']*/g, FIREBASE_MESSAGING);
    if (!src.includes('firebase-messaging')) {
      src = src.replace(
        /dependencies\s*\{/,
        `dependencies {\n    implementation("${FIREBASE_MESSAGING}")  // native FCM for call wake-up`,
      );
    }
    cfg.modResults.contents = src;   // written back even when only the version moved
    return cfg;
  });
}

/**
 * Flip to true ONLY together with a real PushKit + CallKit implementation.
 *
 * The `voip` background mode is not a hint to iOS — it is a claim that the app
 * registers a PKPushRegistry for .voIP pushes and reports every one of them to
 * CallKit via CXProvider.reportNewIncomingCall() immediately on arrival. There
 * is no such code in this app yet (lib/CallService.ts:21 gates the whole native
 * call surface behind Platform.OS === 'android'), so declaring the mode today
 * buys nothing at runtime and is a documented App Review rejection trigger.
 *
 * Worse than the rejection: iOS revokes an app's VoIP push privileges if it
 * receives a VoIP push and fails to report a call, so shipping the entitlement
 * ahead of the implementation is actively harmful.
 *
 * `audio` and `remote-notification` stay — the app really does play audio in the
 * background (voice notes, video) and really does receive remote notifications.
 */
const IOS_CALLKIT_IMPLEMENTED = false;

function withIosVoip(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    if (IOS_CALLKIT_IMPLEMENTED) modes.add('voip');
    else modes.delete('voip');   // never leave a stale entitlement behind
    modes.add('audio');
    modes.add('remote-notification');
    cfg.modResults.UIBackgroundModes = Array.from(modes);
    return cfg;
  });
}


/**
 * LiveKitReactNative.setup(this) in MainApplication.onCreate().
 *
 * @livekit/react-native installs an audio device module whose
 * audioRecordSamplesDispatcher is created by this call. Without it every call
 * path eventually throws
 *
 *   IllegalStateException: audioRecordSamplesDispatcher is not initialized!
 *   Did you remember to call LiveKitReactNative.setup in your Application.onCreate?
 *
 * It was missing entirely and nobody noticed, because it is NOT a startup
 * crash: the app boots perfectly and the failure surfaces wherever audio
 * capture is first touched. Found by reading a device log during an end-to-end
 * walkthrough; no test could have shown it.
 *
 * It lives HERE rather than in the generated file because android/ is
 * gitignored and rewritten by `expo prebuild` — a hand edit there is correct
 * until the next prebuild and then silently gone, which is exactly how this
 * would come back.
 *
 * Ordering matters: it must run BEFORE loadReactNative(this), so the native
 * module is ready by the time React Native resolves it.
 */
function withLiveKitSetup(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes('LiveKitReactNative.setup(this)')) return cfg;   // idempotent

    const IMPORT = 'import com.livekit.reactnative.LiveKitReactNative';
    const EXPO_IMPORT = 'import expo.modules.ApplicationLifecycleDispatcher';
    if (!src.includes(IMPORT) && src.includes(EXPO_IMPORT)) {
      src = src.replace(EXPO_IMPORT, [IMPORT, '', EXPO_IMPORT].join('\n'));
    }

    const SETUP = '    LiveKitReactNative.setup(this)';
    if (src.includes('    loadReactNative(this)')) {
      src = src.replace('    loadReactNative(this)', [SETUP, '    loadReactNative(this)'].join('\n'));
    } else if (src.includes('    super.onCreate()')) {
      // Older templates call SoLoader rather than loadReactNative.
      src = src.replace('    super.onCreate()', ['    super.onCreate()', SETUP].join('\n'));
    } else {
      console.warn('[withVaultChatCalls] could not insert LiveKitReactNative.setup — add it to MainApplication.onCreate() by hand, or calls will have no audio');
      return cfg;
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = function withVaultChatCalls(config) {
  config = withPermissions(config);
  config = withServices(config);
  config = withPipActivity(config);   // back → PiP, not hang-up
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withLiveKitSetup(config);
  config = withFirebaseMessaging(config);
  config = withIosVoip(config);
  return config;
};
