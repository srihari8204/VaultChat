/**
 * withGradleMemory — raise the Gradle JVM heap + Metaspace.
 *
 * The default (-Xmx2048m -XX:MaxMetaspaceSize=512m) OOMs the release-lint pass
 * (lintVitalAnalyzeRelease → TranslationDetector) on a full native build with
 * webrtc + vision-camera, failing `assembleRelease`. 512m Metaspace is the
 * bottleneck. Bumping it fixes the crash durably (survives `expo prebuild
 * --clean`) so the release APK builds with lint still enabled.
 *
 * Run: expo prebuild --clean
 */
const { withGradleProperties } = require('@expo/config-plugins');

const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8';

/**
 * ABIs to build. 64-bit only, deliberately.
 *
 * Play has required 64-bit since 2019 but has never required 32-bit, so
 * arm64-v8a + x86_64 is a complete, compliant release. Dropping armeabi-v7a
 * and x86 costs only devices that are 32-bit ONLY — effectively none still in
 * use, since arm64 has been the norm on even budget hardware for a decade — and
 * it shrinks every download.
 *
 * It also removes a build that cannot be reproduced here. armeabi-v7a fails
 * from scratch on this checkout with `ninja: manifest 'build.ninja' still dirty
 * after 100 tries`: quick-crypto's generated dependency paths run past the
 * Win32 260-char limit from this directory depth, ninja reads the file as
 * missing, and CMake re-runs forever. Builds that "worked" did so only because
 * the ABI was cached and skipped — a release pipeline resting on an artifact it
 * cannot regenerate. x86 has the same shape of risk and no audience beyond
 * emulators, which x86_64 already covers.
 *
 * To bring armeabi-v7a back, the fix is the path length, not this list: build
 * from a short root (C:\vc) or relocate that module's buildStagingDirectory.
 *
 * x86_64 is out for a DIFFERENT reason, and a machine-local one. Two release
 * bundles in a row died in `Unable to delete directory …\obj\x86_64` — gradle
 * could not replace libjsi.so / libc++_shared.so / libfbjni.so because
 * something on this Windows host holds them open, first under
 * react-native-worklets and then under react-native-reanimated. Every failure
 * was that ABI; arm64-v8a has never failed. Its only audience is emulators and
 * Chromebooks, neither of which is a target for a phone messenger, so it does
 * not earn a whack-a-mole per package.
 *
 * Add x86_64 back where the lock does not exist — a Linux CI or EAS build — not
 * by retrying here.
 */
const ABIS = 'arm64-v8a';

function setProp(props, key, value) {
  const existing = props.find((p) => p.type === 'property' && p.key === key);
  if (existing) existing.value = value;
  else props.push({ type: 'property', key, value });
}

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    setProp(cfg.modResults, 'org.gradle.jvmargs', JVM_ARGS);
    setProp(cfg.modResults, 'reactNativeArchitectures', ABIS);
    return cfg;
  });
};
