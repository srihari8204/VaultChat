// Expo config plugin — fixes the AndroidManifest merge conflict on
// `application@appComponentFactory`.
//
// A legacy dependency (e.g. @react-native-voice/voice) drags in the old
// com.android.support library, which declares android.support.v4.app.
// CoreComponentFactory. That collides with AndroidX's
// androidx.core.app.CoreComponentFactory and fails `:app:processReleaseMainManifest`.
//
// We force the AndroidX factory and tell the manifest merger to override the
// conflicting value (Google's recommended fix). Runs during `expo prebuild`,
// so it survives EAS regenerating the native project (the committed android/
// is gitignored).

const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAppComponentFactoryFix(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // Ensure the tools namespace exists on <manifest>.
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const app = manifest.application && manifest.application[0];
    if (app) {
      app.$ = app.$ || {};
      app.$['android:appComponentFactory'] = 'androidx.core.app.CoreComponentFactory';
      const prev = app.$['tools:replace'];
      const parts = new Set((prev ? prev.split(',') : []).map((s) => s.trim()).filter(Boolean));
      parts.add('android:appComponentFactory');
      app.$['tools:replace'] = Array.from(parts).join(',');
    }

    return cfg;
  });
};
