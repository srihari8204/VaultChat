// Expo config plugin — Android build fixes applied during `expo prebuild`
// (the committed android/ is gitignored, so EAS regenerates it; these must be
// config plugins to survive).
//
// 1. appComponentFactory manifest merge conflict: a legacy dependency
//    (@react-native-voice/voice) drags in com.android.support, whose
//    android.support.v4.app.CoreComponentFactory collides with AndroidX's.
//    We force the AndroidX factory + tools:replace (Google's recommended fix).
//
// 2. Duplicate classes: androidx.core already bundles the android.support.v4.*
//    compat shims, so the legacy com.android.support:28.0.0 artifacts duplicate
//    them and fail :app:checkReleaseDuplicateClasses. Enabling Jetifier rewrites
//    every legacy support reference to AndroidX, removing the old artifacts.

const {
  withAndroidManifest,
  withGradleProperties,
} = require('@expo/config-plugins');

function fixManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
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
}

function enableJetifier(config) {
  return withGradleProperties(config, (cfg) => {
    const set = (key, value) => {
      cfg.modResults = cfg.modResults.filter(
        (p) => !(p.type === 'property' && p.key === key),
      );
      cfg.modResults.push({ type: 'property', key, value });
    };
    set('android.useAndroidX', 'true');
    set('android.enableJetifier', 'true');
    return cfg;
  });
}

module.exports = function withAndroidBuildFixes(config) {
  config = fixManifest(config);
  config = enableJetifier(config);
  return config;
};
