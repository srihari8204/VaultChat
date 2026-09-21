// lib/appTextWeight.selftest.ts — run: npx tsx lib/appTextWeight.selftest.ts
//
// The brand fonts are per-weight STATIC files (Sora_700Bold,
// NunitoSans_600SemiBold ...), each registered under its own family name. Give
// Android one of those families AND a fontWeight and it hunts for a weighted
// variant that does not exist, then falls back to Roboto — so a heading that
// asked for extra weight is the one place the brand font disappears.
//
// components/ui/Text.tsx avoided this in its BASE style from the start, but a
// style prop merges on top and puts the weight back. Six call sites do exactly
// that (app/live.tsx, components/ui/Avatar.tsx).
//
// The resolution rule is asserted here as source, because the component needs
// React to run. The mapping itself is small enough to state exactly.

import assert from 'node:assert/strict';
import fs from 'node:fs';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

const src = fs.readFileSync('components/ui/Text.tsx', 'utf8');
const theme = fs.readFileSync('constants/theme.ts', 'utf8');

ok('the brand families are still per-weight static faces',
   theme.includes("heading:     'Sora_700Bold'") && theme.includes("bodySemibold:'NunitoSans_600SemiBold'"));

ok('AppText flattens the incoming style before reading it', src.includes('StyleSheet.flatten(style)'));
ok('it only intervenes once the brand fonts are ready', /if \(ready && merged && merged\.fontWeight != null/.test(src));
ok('it leaves an explicit fontFamily alone', src.includes('merged.fontFamily == null'));
ok('the weight itself is dropped, never passed alongside a family', /const \{ fontWeight, \.\.\.rest2 \} = merged;/.test(src));
ok('headings resolve to a Sora face', src.includes('w >= 800 ? FONT.headingBold : FONT.heading'));
ok('body resolves across all three Nunito faces',
   src.includes('w >= 700 ? FONT.bodyBold : w >= 600 ? FONT.bodySemibold : FONT.body'));

// The base style must still be the fallback-only form this depends on.
ok('base still sets family when ready and weight only when not',
   src.includes('...(ready ? { fontFamily: t.family } : { fontWeight: t.fontWeight })'));

ok('named bold weight resolves to a registered face', src.includes("fontWeight === 'bold' ? 700"));
ok('custom font sizes get proportional line boxes unless explicitly supplied', src.includes('merged?.fontSize != null && merged.lineHeight == null') && src.includes('Math.ceil(merged.fontSize * t.lineHeight / t.fontSize)'));

// The call sites that triggered this must still be covered by it.
const live = fs.readFileSync('app/live.tsx', 'utf8');
const avatar = fs.readFileSync('components/ui/Avatar.tsx', 'utf8');
ok('app/live.tsx still passes weights through AppText', /<AppText style=\{\{[^}]*fontWeight/.test(live));
ok('Avatar still passes a weight through AppText', /fontWeight: '800'/.test(avatar));

console.log(`\nappTextWeight.selftest: ${n} assertions passed`);
