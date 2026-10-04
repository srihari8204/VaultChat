// lib/onboardNav.selftest.ts — run: npx tsx lib/onboardNav.selftest.ts
//
// "anni pages back and front vellelaattu pettu" — every page must go back and
// forward properly. The email-OTP bounce (lib/refreshOutcome.selftest.ts) was
// one symptom of a wider class: a screen transition that picks the wrong verb.
//
//   push    — the previous step stays reachable. Correct while the user may
//             still want to CORRECT it (a mistyped email, a wrong question).
//   replace — the previous step is consumed and must not come back. Correct for
//             a spent OTP, and for a committed account.
//   resetTo — the whole stack below is consumed. Correct at the sign-in
//             boundary ONLY: replace() swaps the top entry alone, so without
//             this the finished sign-up (or the account you just deleted) sat
//             one BACK press under the app. See lib/authNav.ts.
//
// The screens import react-native and expo-router, so they cannot be loaded
// under Node. This reads their source, like refreshOutcome.selftest.ts does —
// enough to catch a verb being changed back, and honest about being a
// source-level check.

import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nOnboarding navigation\n');

const LANDING  = read('app/onboard.tsx');
const VERIFY   = read('app/phone-verify.tsx');
const PROFILE  = read('app/onboard-profile.tsx');
const SECURITY = read('app/onboard-security.tsx');
const MPIN     = read('app/onboard-mpin.tsx');
const SUCCESS  = read('app/onboard-success.tsx');
const ENTRY    = read('app/mpin-entry.tsx');
const LOCK     = read('app/app-lock.tsx');
const AUTHNAV  = read('lib/authNav.ts');

// ── steps the user may still want to correct → push, with a way back ──
console.log('Correctable steps are pushed and keep their Back:');
check('landing → phone-verify is a push (the number may be a typo)',
  /router\.push\('\/phone-verify'/.test(LANDING));
check('phone-verify has a Back to the landing form', /router\.back\(\)/.test(VERIFY));
check('profile → onboard-security is a push', /router\.push\('\/onboard-security'/.test(PROFILE));
check('profile has a Back', /router\.back\(\)/.test(PROFILE));
check('security → onboard-mpin is a push', /router\.push\('\/onboard-mpin'/.test(SECURITY));
check('security has a Back', /router\.back\(\)/.test(SECURITY));
check('mpin-entry has a Back to the landing form', /router\.back\(\)/.test(ENTRY));

// ── consumed steps → replace ─────────────────────────────────────────
console.log('\nConsumed steps are replaced, not pushed:');
check('phone-verify → profile REPLACES (the OTP is spent; back into it is dead)',
  /router\.replace\('\/onboard-profile'/.test(VERIFY) && !/router\.push\('\/onboard-profile'/.test(VERIFY));
check('phone-verify → mpin-entry REPLACES too (an existing account, same spent code)',
  /router\.replace\(\{ pathname: '\/mpin-entry'/.test(VERIFY) && !/router\.push\(\{ pathname: '\/mpin-entry'/.test(VERIFY));
check('onboard-mpin → success REPLACES (the account is committed by then)',
  /router\.replace\(\{ pathname: '\/onboard-success'/.test(MPIN));

// ── step 3 of 3 had no Back affordance at all ────────────────────────
console.log('\nEvery step of the chain offers a way back:');
check('onboard-mpin renders a Back control', /router\.back\(\)/.test(MPIN),
  'step 3 of 3 was the only step with no arrow');
check('...but hides it, and swallows hardware BACK, while committing',
  /hardwareBackPress'?,\s*\(\) => busy\)/.test(MPIN),
  'leaving mid-commit creates the account with nobody to hand it to');

// ── the sign-in boundary must not leave the old stack underneath ─────
console.log('\nCrossing the sign-in boundary clears the stack:');
// Scoped to the function body — the header comment names router.replace() too,
// so a bare indexOf would compare against prose.
const RESET = AUTHNAV.slice(AUTHNAV.indexOf('export function resetTo'));
check('lib/authNav.resetTo dismisses the stack before replacing',
  /canDismiss\(\)\)\s*router\.dismissAll\(\);/.test(RESET)
  && RESET.indexOf('dismissAll()') < RESET.indexOf('router.replace'));
check('onboard-success → chats uses resetTo, not replace',
  /resetTo\(next \?\? '\/\(tabs\)\/chats'\)/.test(SUCCESS)
  && !/router\.replace\(\(next/.test(SUCCESS),
  'BACK from the chat list returned into onboard-security');
check('mpin-entry → chats uses resetTo, not replace',
  /resetTo\('\/\(tabs\)\/chats'\)/.test(ENTRY) && !/router\.replace\('\/\(tabs\)\/chats'/.test(ENTRY),
  'BACK from the chat list returned to the landing form');
check('signing out of a deleted account uses resetTo',
  /resetTo\('\/onboard'\)/.test(read('app/delete-account.tsx')));
check('signing out from the profile tab uses resetTo',
  /resetTo\('\/onboard'\)/.test(read('app/(tabs)/profile.tsx')));

// ── the finished sign-up is a dead end, on purpose ───────────────────
console.log('\nA committed sign-up cannot be re-entered:');
check('onboard-success swallows hardware BACK',
  /hardwareBackPress'?,\s*\(\) => true\)/.test(SUCCESS));
check('...and the swipe gesture too', /gestureEnabled: false/.test(SUCCESS));

// ── the unlock screen ────────────────────────────────────────────────
console.log('\nThe unlock screen cannot be walked around:');
check('app-lock blocks the swipe', /gestureEnabled: false/.test(LOCK));
check('app-lock consumes hardware BACK only when a screen sits beneath it',
  /hardwareBackPress'?,\s*\(\) => router\.canGoBack\(\)\)/.test(LOCK),
  'lib/api.ts replaces INTO this screen mid-stack; back then re-entered the app');
check('...and still lets BACK exit the app on a cold start',
  !/hardwareBackPress'?,\s*\(\) => true\)/.test(LOCK));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all onboarding-navigation checks passed\n');
process.exit(failures ? 1 : 0);
