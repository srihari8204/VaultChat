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
 * Standard Android ABIs for production AABs. Google Play serves only the
 * matching native slice to each device, so broad support does not make every
 * user's download contain all four copies.
 *
 * The connected-device APK stays fast and small through
 * `build:android:apk:arm64`, whose Gradle `-P` override wins over this default.
 * Build the multi-ABI production artifact on Linux CI/EAS: native dependency
 * builds on this Windows checkout have previously hit path-length/file-lock
 * failures for non-arm64 variants.
 */
const ABIS = 'arm64-v8a,armeabi-v7a,x86,x86_64';

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
