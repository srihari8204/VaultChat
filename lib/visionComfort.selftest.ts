import assert from 'node:assert/strict';
import {
  VISION_COMFORT_STORAGE_KEY, decodeVisionComfortState, defaultVisionComfortState,
  deriveVisionMetrics, isVisionProfile, comfortLevelFromTrack,
} from './visionComfortModel';

assert.equal(VISION_COMFORT_STORAGE_KEY, 'vc_vision_comfort_v1');
assert.deepEqual(decodeVisionComfortState(null), defaultVisionComfortState());
assert.deepEqual(decodeVisionComfortState('{bad'), defaultVisionComfortState());
assert.deepEqual(decodeVisionComfortState(JSON.stringify({
  version: 1, activeProfile: 'without-glasses', profiles: {
    'with-glasses': { level: 0, highContrast: false, reduceTransparency: false },
    'without-glasses': { level: 5, highContrast: true, reduceTransparency: true },
  },
})).activeProfile, 'without-glasses');
assert.equal(isVisionProfile({ level: 6, highContrast: false, reduceTransparency: false }), false);
assert.equal(isVisionProfile({ level: 2, highContrast: 'yes', reduceTransparency: false }), false);
assert.equal(deriveVisionMetrics({ level: 0, highContrast: false, reduceTransparency: false }).textScale, 1);
assert.equal(deriveVisionMetrics({ level: 5, highContrast: true, reduceTransparency: true }).textScale, 1.4);
assert.equal(deriveVisionMetrics({ level: 5, highContrast: true, reduceTransparency: true }).bold, true);
assert.equal(comfortLevelFromTrack(0, 192), 5);
assert.equal(comfortLevelFromTrack(192, 192), 0);
assert.equal(comfortLevelFromTrack(96, 192), 3);
assert.equal(comfortLevelFromTrack(-40, 192), 5);
assert.equal(comfortLevelFromTrack(250, 192), 0);
console.log('Vision Comfort model OK');
