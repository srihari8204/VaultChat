/**
 * withAndroidFeatures — stop Google Play filtering the app off devices that
 * merely lack an optional sensor.
 *
 * THE PROBLEM
 * -----------
 * Google Play derives IMPLIED hardware requirements from permissions when the
 * manifest does not say otherwise, and an implied feature defaults to
 * required="true". Nothing in this project — not our config plugins, not
 * expo-camera, not react-native-vision-camera, not expo-location — declares a
 * single <uses-feature>, so every one of these was implied as REQUIRED:
 *
 *   CAMERA                 -> android.hardware.camera (+ autofocus)
 *   RECORD_AUDIO           -> android.hardware.microphone
 *   ACCESS_FINE_LOCATION   -> android.hardware.location.gps
 *   ACCESS_COARSE_LOCATION -> android.hardware.location.network
 *   BLUETOOTH*             -> android.hardware.bluetooth
 *
 * The practical effect is that Play hides the app from any device missing one of
 * them. For a messenger that is backwards: someone with no GPS or no Bluetooth
 * can still message, call and transfer files perfectly well. The app degrades
 * per feature at runtime already — every one of these paths is permission-gated
 * and fails soft — so the install should not be gated too.
 *
 * Declaring each explicitly with required="false" keeps the runtime behaviour
 * identical (a <uses-feature> grants nothing and changes no API) and only tells
 * Play to stop filtering.
 *
 * Run: expo prebuild --clean
 */
const { withAndroidManifest } = require('@expo/config-plugins');

// Every feature this app can imply, all optional. Ordered as in the analysis
// above so the mapping back to the triggering permission stays obvious.
const OPTIONAL_FEATURES = [
  'android.hardware.camera',
  'android.hardware.camera.front',
  'android.hardware.camera.autofocus',
  'android.hardware.camera.flash',
  'android.hardware.microphone',
  'android.hardware.location',
  'android.hardware.location.gps',
  'android.hardware.location.network',
  'android.hardware.bluetooth',
  'android.hardware.bluetooth_le',
  'android.hardware.sensor.accelerometer',   // emergency-sos shake detection
  'android.hardware.sensor.stepcounter',     // expo-sensors Pedometer
  'android.hardware.fingerprint',            // biometric unlock (falls back to PIN)
  'android.hardware.telephony',              // never required by a data-only app
  'android.hardware.wifi',
];

module.exports = function withAndroidFeatures(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] || [];

    for (const name of OPTIONAL_FEATURES) {
      const existing = manifest['uses-feature'].find((f) => f.$?.['android:name'] === name);
      if (existing) {
        // A library declared it (possibly as required) — force optional rather
        // than adding a duplicate the manifest merger would reject.
        existing.$['android:required'] = 'false';
      } else {
        manifest['uses-feature'].push({
          $: { 'android:name': name, 'android:required': 'false' },
        });
      }
    }
    return cfg;
  });
};
