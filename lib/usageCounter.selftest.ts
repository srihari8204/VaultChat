// lib/usageCounter.selftest.ts — run: npx tsx lib/usageCounter.selftest.ts
//
// AUDIT F9. Analytics in a privacy messenger is the one feature where the
// failure mode is not "it does not work" but "it works, and collects more than
// it said". Every check here is about the SHAPE of what leaves the device and
// the SHAPE of what the server keeps — the two places where an instrument
// quietly becomes a log.
//
// The promise, in one line: a screen name and a day, added to a shared total,
// with no account, device or session attached. That promise is written in the
// privacy policy and in a Settings sub-line, so it is not this module's alone
// to change.

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const CLIENT = read('lib/usageCounter.ts');
const OBSERVER = read('components/UsageCounter.tsx');
const GO = read('vaultchat-backend-go/internal/routes/usage.go');
const SQL = read('vaultchat-backend/migrations/130_screen_usage.sql');
const POLICY = read('caddy/public/privacy.html');
const SETTINGS = read('app/settings.tsx');
const LAYOUT = read('app/_layout.tsx');

console.log('\nUsage-counter self-test\n');

console.log('The payload is a name and a number, and nothing else:');
check('the body is only counts', /json: \{ counts \} \}/.test(CLIENT));
// Named individually so adding one is a deliberate act that fails this test
// first, rather than a field that slips in during a refactor.
for (const forbidden of ['userId', 'deviceId', 'sessionId', 'timestamp', 'chatId', 'messageId', 'duration']) {
  check(`no ${forbidden} is collected`, !new RegExp(`\\b${forbidden}\\b`).test(CLIENT));
}
check('the observer can only pass a route name',
  /countScreen\(name\)/.test(OBSERVER) && !/countScreen\([^)]*,/.test(OBSERVER),
  'a second argument is how an instrument becomes a logger');

console.log('\nThe stored row has no identity:');
check('the table is (screen, day, views)', /PRIMARY KEY \(screen, day\)/.test(SQL));
for (const col of ['user_id', 'device_id', 'session_id', 'created_at']) {
  check(`the table has no ${col}`, !new RegExp(col).test(SQL));
}
check('the server writes through SysPool, not a user-bound pool', /db\.SysPool\.Exec/.test(GO),
  'a user-bound write would be an identity this design refuses to have');
check('the day comes from the SERVER clock', /CURRENT_DATE/.test(GO),
  'a device with a wrong date must not be able to write counts into next year');
check('the caller identity is used only to rate-limit',
  /redisx\.ConsumeSecure\(ctx, "usage:"\+user\.ID/.test(GO) &&
  !/user\.ID\)/.test(GO.slice(GO.indexOf('INSERT INTO screen_usage'))),
  'the id must not reach the INSERT');

console.log('\nThe endpoint cannot be turned into something else:');
check('screen names are an allow-list', /usageScreens\[screen\]/.test(GO),
  'without it this is an authenticated write-anything string store');
check('an unknown name is dropped, not stored', /continue \/\/ unknown or not worth counting/.test(GO));
check('the body size is bounded', /MaxBytesReader\(w, r\.Body, 8<<10\)/.test(GO));
check('a single batch cannot flood one counter', /n > usageMaxPerScreen/.test(GO));
check('the rate limit does not fail open', /ConsumeSecure/.test(GO) && !/redisx\.Consume\(/.test(GO));

console.log('\nThe switch is honoured before anything is recorded:');
check('countScreen returns immediately when off', /export function countScreen[\s\S]{0,120}if \(!enabled\) return;/.test(CLIENT),
  'buffering while off and discarding later still means the app held a record');
check('switching off discards what was buffered, before the preference write can fail',
  /if \(!on\) \{ enabled = false; pending = \{\}; \}\s*(\/\/[^\n]*)?\s*await AsyncStorage\.setItem/.test(CLIENT));
check('the preference is read at boot, before navigation',
  LAYOUT.indexOf('initUsageCounter()') > 0 && /initUsageCounter\(\)\.catch/.test(LAYOUT));
// Two concrete properties rather than a prose match: the buffer is never
// written to storage, and a failed send never puts anything back into it.
const flushBody = CLIENT.slice(CLIENT.indexOf('async function maybeFlush'));
check('the buffer is never persisted to disk',
  !/setItem\([^)]*pending/.test(CLIENT) && !/JSON\.stringify\(pending\)/.test(CLIENT),
  'an unsent batch that survives a restart is a record of where the user went');
check('a failed send does not put the counts back',
  !/pending\s*=\s*\{\s*\.\.\.counts/.test(flushBody) && !/pending\[[^\]]*\]\s*\+?=/.test(flushBody),
  'a counter that hoards unsent records on the device has become a log');

console.log('\nIt is disclosed where it has to be:');
check('the privacy policy names it', /Which screens get opened/.test(POLICY));
check('the policy says no identity is attached', /No account, device, or session is attached/.test(POLICY));
check('the policy says where to switch it off', /Help improve crazzychat/.test(POLICY));
check('Settings carries the same sentence', /a screen name and a day, with no account, device or message information/.test(SETTINGS));
check('Settings has the switch', /value=\{usageOn\}/.test(SETTINGS));

console.log(failures === 0 ? '\nAll usage-counter checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
