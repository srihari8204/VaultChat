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

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const existing = props.find((p) => p.type === 'property' && p.key === 'org.gradle.jvmargs');
    if (existing) existing.value = JVM_ARGS;
    else props.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS });
    return cfg;
  });
};
