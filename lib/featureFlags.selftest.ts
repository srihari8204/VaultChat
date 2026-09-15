// lib/featureFlags.selftest.ts — run: npx tsx lib/featureFlags.selftest.ts
//
// §21. This file guards one promise: with nothing configured, the app behaves
// exactly as it does today. The app is live, so "defaults to OFF" is not a
// nicety — every other check here exists because some way of getting that wrong
// has shipped in somebody's app before.
//
//   • a missing / malformed config must be OFF, never a crash and never ON;
//   • a percentage must select the SAME installs every launch, or a 1% rollout
//     is a 1%-per-launch lottery and nothing is reproducible;
//   • 0 must mean nobody and 100 must mean everybody, exactly;
//   • a flag must not change value inside a session, or a transport can swap
//     under a live conversation.

import {
  TRANSPORT_RUST,
  bucketOf,
  normalizePercent,
  evaluateFlag,
  envKeyFor,
  configuredPercent,
  isFeatureEnabled,
  featureFlagDiagnostics,
  __resetFeatureFlagsForTest,
} from './featureFlags';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const ENV_KEY = envKeyFor(TRANSPORT_RUST);
const ids = Array.from({ length: 2000 }, (_, i) => `install-${i}-${(i * 2654435761) % 1000003}`);

console.log('\nFeature-flag rollout self-test\n');

// ── 1. Nothing configured means nothing changes ────────────────────────────
console.log('Default is OFF with no configuration:');
delete process.env[ENV_KEY];
__resetFeatureFlagsForTest();
check('no env var, no install id ⇒ the flag is off', isFeatureEnabled(TRANSPORT_RUST) === false);
check('no env var ⇒ the configured percentage is 0', configuredPercent(TRANSPORT_RUST) === 0);
__resetFeatureFlagsForTest('an-install-id');
check('an install id alone does NOT enable anything', isFeatureEnabled(TRANSPORT_RUST) === false,
  'the build must opt in; having an id is not opting in');
check('an unknown flag name is off', isFeatureEnabled('never.heard.of.it') === false);
check('an empty flag name is off, not a throw', isFeatureEnabled('') === false);

// ── 2. Garbage in means OFF, not a crash ───────────────────────────────────
console.log('\nA malformed or absent config is OFF, not a crash:');
for (const bad of ['', '   ', 'yes', 'true', 'NaN', '10%', '{}', 'null', '-5', '1e400x']) {
  process.env[ENV_KEY] = bad;
  __resetFeatureFlagsForTest('an-install-id');
  check(`env=${JSON.stringify(bad)} ⇒ off`, isFeatureEnabled(TRANSPORT_RUST) === false);
}
delete process.env[ENV_KEY];
check('normalizePercent(undefined) is 0', normalizePercent(undefined) === 0);
check('normalizePercent(null) is 0', normalizePercent(null) === 0);
check('normalizePercent(NaN) is 0', normalizePercent(NaN) === 0);
check('normalizePercent(Infinity) is 0, not 100', normalizePercent(Infinity) === 0,
  'a corrupt value must never read as "ship it to everyone"');
check('normalizePercent(-1) clamps to 0', normalizePercent(-1) === 0);
check('normalizePercent(101) clamps to 100', normalizePercent(101) === 100);
check('normalizePercent("25") parses a string env value', normalizePercent('25') === 25);
check('normalizePercent(7.9) floors', normalizePercent(7.9) === 7);
check('evaluateFlag(null) is false, not a throw', evaluateFlag(null as any) === false);
check('evaluateFlag({}) is false', evaluateFlag({}) === false);
check('a percentage with no install id is off below 100',
  evaluateFlag({ name: 'f', percent: 50 }) === false,
  'unbucketable must fall to the OLD transport');

// ── 3. 0 is nobody, 100 is everybody ───────────────────────────────────────
console.log('\n0% means nobody and 100% means everybody:');
check('0% excludes every one of 2000 installs',
  ids.every((id) => evaluateFlag({ name: 'f', percent: 0, installId: id }) === false));
check('100% includes every one of 2000 installs',
  ids.every((id) => evaluateFlag({ name: 'f', percent: 100, installId: id }) === true));
check('100% includes an install with no id at all',
  evaluateFlag({ name: 'f', percent: 100 }) === true);
check('a kill beats 100%',
  evaluateFlag({ name: 'f', percent: 100, installId: ids[0], killed: true }) === false,
  'the rollback lever has to win against every other input');
check('a kill beats a bucketed install',
  ids.every((id) => evaluateFlag({ name: 'f', percent: 50, installId: id, killed: true }) === false));
check('killed:false is not treated as killed',
  evaluateFlag({ name: 'f', percent: 100, installId: ids[0], killed: false }) === true);

// ── 4. The same install always lands the same side ─────────────────────────
console.log('\nThe same install id always lands the same side:');
check('bucketOf is deterministic across calls',
  ids.every((id) => bucketOf('f', id) === bucketOf('f', id)));
check('bucketOf is always 0–99',
  ids.every((id) => { const b = bucketOf('f', id); return Number.isInteger(b) && b >= 0 && b < 100; }));
check('evaluateFlag repeats itself for the same inputs',
  ids.every((id) => evaluateFlag({ name: 'f', percent: 5, installId: id })
                 === evaluateFlag({ name: 'f', percent: 5, installId: id })));
check('an install inside 1% is still inside at 5, 25, 50 and 100',
  ids.filter((id) => evaluateFlag({ name: 'f', percent: 1, installId: id }))
     .every((id) => [5, 25, 50, 100].every((p) => evaluateFlag({ name: 'f', percent: p, installId: id }))),
  'raising a stage must never MOVE anyone back to the old transport');
check('two different flags do not select the same cohort',
  ids.filter((id) => bucketOf('a.flag', id) !== bucketOf('b.flag', id)).length > ids.length * 0.9);

const at5 = ids.filter((id) => evaluateFlag({ name: 'f', percent: 5, installId: id })).length;
const at50 = ids.filter((id) => evaluateFlag({ name: 'f', percent: 50, installId: id })).length;
check(`5% of 2000 lands near 100 (got ${at5})`, at5 >= 60 && at5 <= 150);
check(`50% of 2000 lands near 1000 (got ${at50})`, at50 >= 880 && at50 <= 1120);

// ── 5. Stickiness within a session ─────────────────────────────────────────
console.log('\nA flag does not change value within a session:');
process.env[ENV_KEY] = '100';
__resetFeatureFlagsForTest('sticky-install');
const first = isFeatureEnabled(TRANSPORT_RUST);
check('a configured flag reads on', first === true);
process.env[ENV_KEY] = '0';
check('lowering the percentage mid-session does not flip it',
  isFeatureEnabled(TRANSPORT_RUST) === first,
  'a transport must not swap under a live conversation');
let killedNow = false;
__resetFeatureFlagsForTest('sticky-install', () => killedNow);
process.env[ENV_KEY] = '100';
check('a fresh session re-reads the config', isFeatureEnabled(TRANSPORT_RUST) === true);
killedNow = true;
check('a kill arriving mid-session does not flip it either',
  isFeatureEnabled(TRANSPORT_RUST) === true,
  'documented limit: the kill lands on the next cold start');
__resetFeatureFlagsForTest('sticky-install', () => true);
check('the next session honours the kill', isFeatureEnabled(TRANSPORT_RUST) === false);

// ── 6. Diagnostics are safe to show and to log ─────────────────────────────
console.log('\nDiagnostics report the decision without leaking the id:');
process.env[ENV_KEY] = '25';
__resetFeatureFlagsForTest('diag-install');
const d = featureFlagDiagnostics(TRANSPORT_RUST);
check('reports the configured percentage', d.percent === 25);
check('reports a bucket, not an id', d.bucket === bucketOf(TRANSPORT_RUST, 'diag-install'));
check('the diagnostic agrees with the flag', d.enabled === isFeatureEnabled(TRANSPORT_RUST));
check('no install id appears anywhere in the diagnostic',
  !JSON.stringify(d).includes('diag-install'));
__resetFeatureFlagsForTest();
check('with no id the bucket is -1 and the flag is off',
  featureFlagDiagnostics(TRANSPORT_RUST).bucket === -1
  && featureFlagDiagnostics(TRANSPORT_RUST).enabled === false);
delete process.env[ENV_KEY];

// ── 7. The live path is genuinely untouched ────────────────────────────────
console.log('\nNothing on the live path depends on this yet:');
import('node:fs').then(async (fs) => {
  const src = fs.readFileSync('lib/featureFlags.ts', 'utf8');
  check('no random draw anywhere in the rollout logic', !/Math\.random\s*\(/.test(src),
    'a per-launch draw makes a 1% rollout a 1%-per-launch lottery');
  check('no module-scope react-native / storage import',
    !/^import .*(react-native|async-storage|expo-secure-store)/m.test(src),
    'a native import at module scope would crash this very test');
  check('every storage touch is behind a lazy import in try/catch',
    (src.match(/await import\(/g) || []).length >= 2 && /\} catch \{/.test(src));

  // Exercise Expo's actual production transform: Node's process.env alone
  // cannot catch a flag that disappears when installed on a phone.
  const { createRequire } = await import('node:module');
  const load = createRequire(import.meta.url);
  const { transformSync } = load('@babel/core');
  const { expoInlineEnvVars } = load('babel-preset-expo/build/inline-env-vars');
  const ts = load('typescript');
  process.env[ENV_KEY] = '100';
  const bundled = transformSync(src, {
    configFile: false, babelrc: false, filename: 'featureFlags.ts',
    parserOpts: { plugins: ['typescript'] },
    caller: { name: 'metro', isProduction: true },
    plugins: [expoInlineEnvVars],
  }).code;
  const output = ts.transpileModule(bundled, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const phone = { exports: {} as any };
  new Function('module', 'exports', 'require', 'process', output)(phone, phone.exports, load, { env: {} });
  check('production phone bundle retains the configured rollout without runtime env',
    phone.exports.configuredPercent(TRANSPORT_RUST) === 100);
  delete process.env[ENV_KEY];

  console.log(failures === 0 ? '\nAll feature-flag checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
});
