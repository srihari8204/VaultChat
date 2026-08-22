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

/**
 * Permissions a DEPENDENCY declares that this app does not use.
 *
 * The merged manifest is the union of every library's manifest, so a permission
 * can appear without a single line of our code asking for it. Each one still
 * costs: Play wants a written justification for the restricted ones, and the
 * user reads the whole list on the store page. An E2EE messenger asking to
 * MODIFY the address book is exactly the kind of thing that makes someone close
 * the page — and reviewers ask about it too.
 *
 * Only permissions with NO caller in this codebase belong here. Removing one a
 * library genuinely needs breaks that feature at runtime with a SecurityException
 * the merger cannot warn about, so verify before adding.
 */
const REMOVED_PERMISSIONS = [
  // expo-contacts declares read AND write; contactSync.ts only ever reads.
  // Nothing calls addContactAsync / updateContactAsync anywhere in app/ or lib/.
  'android.permission.WRITE_CONTACTS',
];

/**
 * Permissions that are legacy-only, capped instead of removed.
 *
 * WRITE_EXTERNAL_STORAGE does nothing from API 29 and is ignored outright from
 * 33, but declared unbounded it still shows up as broad storage access on the
 * store listing and in Play's data review. Capping keeps it working on the old
 * devices minSdk 24 still admits, and makes it invisible everywhere else.
 */
const CAPPED_PERMISSIONS = { 'android.permission.WRITE_EXTERNAL_STORAGE': '28' };

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

    // tools:node="remove" rather than deleting the element: the permission is
    // introduced by a LIBRARY manifest, so dropping our own copy achieves
    // nothing — the merger would just re-add theirs. Only an explicit remove
    // marker survives the merge.
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    manifest['uses-permission'] = manifest['uses-permission'] || [];

    for (const name of REMOVED_PERMISSIONS) {
      const existing = manifest['uses-permission'].find((p) => p.$?.['android:name'] === name);
      const marker = { $: { 'android:name': name, 'tools:node': 'remove' } };
      if (existing) Object.assign(existing.$, marker.$);
      else manifest['uses-permission'].push(marker);
    }

    for (const [name, maxSdk] of Object.entries(CAPPED_PERMISSIONS)) {
      const existing = manifest['uses-permission'].find((p) => p.$?.['android:name'] === name);
      // tools:overrideLibrary is not enough here — the merger takes the WIDEST
      // maxSdkVersion across manifests, so the cap has to replace the library's
      // attribute rather than sit beside it.
      const attrs = { 'android:name': name, 'android:maxSdkVersion': maxSdk, 'tools:node': 'replace' };
      if (existing) Object.assign(existing.$, attrs);
      else manifest['uses-permission'].push({ $: attrs });
    }

    return cfg;
  });
};
