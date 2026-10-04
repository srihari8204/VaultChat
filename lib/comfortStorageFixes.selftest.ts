// lib/comfortStorageFixes.selftest.ts — npx tsx lib/comfortStorageFixes.selftest.ts
//
// Pins round-4 fixes on the utilities/comfort screens that are wiring, not
// pure logic (the screens import React Native, so they are read as source):
//   1. Eye Check returns to the Vision Comfort that opened it (dismissTo), and
//      Vision Comfort applies a result that arrives after it initialised.
//   2. The Security Hub does not score facts that are neither safe nor unsafe.
//   3. The auto-download setter rejects on a storage failure, so Settings'
//      saveLocal can revert and say so.
//   4. Notification sounds: one ringtone save at a time.
//   5. Offline mode re-describes a retry on every recount after it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

// 1
const eye = read('app/eye-check.tsx');
ok(/router\.dismissTo\(\{\s*pathname: '\/vision-comfort'/.test(eye) && !/router\.replace\(\{\s*pathname: '\/vision-comfort'/.test(eye),
  '1. Eye Check pops back to Vision Comfort instead of stacking a second one');
ok(/eyeCheckAt: String\(Date\.now\(\)\)/.test(eye), '1a. each Eye Check result is told apart from the last');
const vc = read('app/vision-comfort.tsx');
ok(/appliedCheck\.current !== eyeCheckAt/.test(vc) && /\[ready, activeProfile, profiles, eyeCheckSuggestion, eyeCheckGlasses, eyeCheckAt\]/.test(vc),
  '1b. Vision Comfort applies a suggestion that arrives after it initialised');

// 2
const dash = read('app/dashboard.tsx');
ok(/name: 'Blocked Contacts', icon: 'ban-outline', ok: null/.test(dash), '2. blocked contacts is a fact, not a pass');
ok(/name: 'Active Sessions', icon: 'phone-portrait-outline', ok: null/.test(dash) && !/activeSessions <= 3/.test(dash),
  '2a. no arbitrary session threshold in the score');
ok(/const scored = checks\.filter\(c => c\.ok !== null\)/.test(dash), '2b. the score counts scored checks only');
ok(/if \(cached\) setStale\(true\)/.test(dash), '2c. a failed refresh over cached data says it is stale');

// 3
const media = read('lib/mediaPrefs.ts');
const setter = media.slice(media.indexOf('export async function setAutoDownload'));
const body = setter.slice(0, setter.indexOf('\n}\n'));
ok(body.length > 0 && !/catch/.test(body) && body.indexOf('setItem') < body.indexOf('cached = p'),
  '3. setAutoDownload stores first and lets a failure reject');

// 4
const sounds = read('app/notification-sounds.tsx');
ok(/if \(savingTone\) return;/.test(sounds) && /disabled=\{savingTone\}/.test(sounds), '4. ringtone rows are disabled while a save runs');
ok(!/'#[0-9A-Fa-f]{3,8}'/.test(sounds), '4a. the Switch thumb is a palette token, not a literal');

// 5
const offline = read('app/offline-mode.tsx');
ok(/if \(retryBase\.current\) setRetryResult\(describeRetry\(retryBase\.current, next\)\)/.test(offline),
  '5. every recount after a retry updates the result line');

console.log(`comfortStorageFixes.selftest: ${n} assertions passed`);
