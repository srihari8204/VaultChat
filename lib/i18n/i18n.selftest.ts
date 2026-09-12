// lib/i18n/i18n.selftest.ts — run: npx tsx lib/i18n/i18n.selftest.ts
//
// AUDIT F8. Two things have to hold, and both fail quietly:
//
//   1. A missing translation must render the ENGLISH string, never a blank and
//      never a raw key like "terms.agree". A blank button is a screen the user
//      cannot operate, and it looks like a rendering bug rather than a missing
//      translation, so nobody reports it as one.
//   2. A key that exists in a translation but NOT in English is a key no
//      fallback can save and no reviewer will notice — usually a typo in one
//      catalog that silently never renders.
//
// The engine imports react-native and AsyncStorage, so the pure parts are
// exercised through a local re-implementation of the ONE rule that matters
// (lookup with per-key fallback), and the catalogs themselves are checked as
// data — which is where the real risk is, since they are edited by hand.

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * Pull a catalog out of the source as data.
 *
 * Reading the file rather than importing it: lib/i18n/index.ts imports the
 * engine, which imports react-native. The catalogs are plain object literals,
 * so the keys are extractable without evaluating anything — and the keys are
 * the whole subject of this test.
 */
function keysOf(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name}: Catalog = {`);
  if (start < 0) return [];
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
}

const APP = read('lib/i18n/index.ts');
const ENGINE = read('lib/i18n/engine.ts');
const SHOP = read('lib/shopbookI18n.ts');

console.log('\nApp i18n self-test\n');

const enKeys = keysOf(APP, 'en');
const hiKeys = keysOf(APP, 'hi');
const teKeys = keysOf(APP, 'te');

console.log('The reference catalog is the reference:');
check('English has keys at all', enKeys.length > 20, `found ${enKeys.length}`);
check('no duplicate keys in English', new Set(enKeys).size === enKeys.length,
  'a duplicate silently wins and the earlier value is unreachable');

for (const [lang, keys] of [['hi', hiKeys], ['te', teKeys]] as const) {
  const orphans = keys.filter((k) => !enKeys.includes(k));
  check(`every ${lang} key exists in English`, orphans.length === 0,
    orphans.length ? `orphans: ${orphans.join(', ')}` : undefined);
  check(`no duplicate keys in ${lang}`, new Set(keys).size === keys.length);
}

// Deliberately NOT asserting that every English key is translated. A partial
// translation is the normal state of a living catalog and falls back per key;
// demanding completeness would make adding an English string a blocked change,
// which is exactly how a translation layer stops being used.
const hiCoverage = Math.round((hiKeys.filter((k) => enKeys.includes(k)).length / enKeys.length) * 100);
const teCoverage = Math.round((teKeys.filter((k) => enKeys.includes(k)).length / enKeys.length) * 100);
console.log(`\n  (coverage — hi ${hiCoverage}%, te ${teCoverage}%; partial is fine, it falls back per key)`);

console.log('\nThe fallback chain cannot produce a blank:');
// The one rule that matters, re-implemented from the engine so this runs under
// plain Node. If the engine's line changes shape, the source check below fails.
const cat = { en: { a: 'A' }, hi: {} as Record<string, string> };
const look = (lang: 'en' | 'hi', key: string) => cat[lang]?.[key] ?? cat.en?.[key] ?? key;
check('a translated key uses the translation', look('en', 'a') === 'A');
check('an untranslated key falls back to English', look('hi', 'a') === 'A');
check('an unknown key returns the KEY, not a blank', look('hi', 'zz') === 'zz',
  'a blank button looks like a rendering bug and is never reported as a missing string');
check('the engine implements exactly that chain',
  /known\[current\]\?\.\[key\] \?\? known\[fallback\]\?\.\[key\] \?\? key/.test(ENGINE));

console.log('\nThere is ONE engine:');
check('Shop Book uses the shared engine', /createI18n<SBLang>\(\{/.test(SHOP));
check('Shop Book no longer carries its own store', !/const listeners = new Set/.test(SHOP),
  'two copies of the same machinery is how they drift');
check('the app catalog uses it too', /createI18n<AppLang>\(\{/.test(APP));
check("Shop Book's public API is unchanged",
  ['initShopBookLang', 'getShopBookLang', 'setShopBookLang', 'useShopBookLang', 'speechLocale']
    .every((fn) => SHOP.includes(`export const ${fn}`) || SHOP.includes(`export function ${fn}`)),
  'every Shop Book call site must keep working without an edit');

console.log('\nDirection is a property of a language, not an assumption:');
check('the engine exposes a direction', /dir: \(\) => Direction/.test(ENGINE));
check('every app language declares one', (APP.match(/dir: 'ltr'/g) ?? []).length === 3);

console.log('\nIt is wired, not decorative:');
const LAYOUT = read('app/_layout.tsx');
check('the language loads at boot', /initLang\(\)\.catch\(\(\) => \{\}\);/.test(LAYOUT));
const GATE = read('components/TermsGate.tsx');
check('a real screen renders through t()', /t\('terms\.agree'\)/.test(GATE));
check('that screen re-renders on a language change', /useLang\(\);/.test(GATE));
check('its hard-coded English is gone', !/>I agree</.test(GATE));

console.log(failures === 0 ? '\nAll i18n checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
