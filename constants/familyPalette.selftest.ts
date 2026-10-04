// constants/familyPalette.selftest.ts — run: npx tsx constants/familyPalette.selftest.ts
//
// The fixed Family colours exist because text sits on them in a place the app
// theme does not reach (the map's WebView page, the crash alarm). This holds
// that text to WCAG AA (4.5:1). The map's marker ink lives in FamilyMap's
// MARKER_CSS, so it is read from that source rather than copied here, where a
// copy could drift from what the page really draws.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { FAMILY_MAP_MEMBER, FAMILY_MAP_TRACK, CRASH_ALARM } from './familyPalette';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };
const AA = 4.5;
const HEX6 = /^#[0-9A-F]{6}$/i;

// Light-map member ink: the rule the page applies to every non-self marker and cluster.
const mapSrc = readFileSync(join(__dirname, '..', 'components', 'family', 'FamilyMap.tsx'), 'utf8');
const ink = /\.mk:not\(\.self\),\.cl:not\(\.self\)\{color:(#[0-9A-Fa-f]{6})\}/.exec(mapSrc)?.[1];
ok('FamilyMap MARKER_CSS still sets the light-map marker ink', !!ink);

ok('eight member hues, all distinct', FAMILY_MAP_MEMBER.length === 8 && new Set(FAMILY_MAP_MEMBER).size === 8);
for (const c of FAMILY_MAP_MEMBER) {
  ok(`${c} is a 6-digit hex (the page and contrastOn both need it)`, HEX6.test(c));
  const r = contrastOn(ink!, c);
  ok(`member initials ${ink} on ${c}: ${r.toFixed(2)}:1 >= ${AA}`, r >= AA);
}

for (const c of Object.values(FAMILY_MAP_TRACK)) ok(`track colour ${c} is a 6-digit hex`, HEX6.test(c));
ok('track start and end are told apart', new Set<string>([FAMILY_MAP_TRACK.start, FAMILY_MAP_TRACK.end]).size === 2);

for (const [k, fill] of [['ok', CRASH_ALARM.ok], ['send', CRASH_ALARM.send]] as const) {
  const r = contrastOn(CRASH_ALARM.ink, fill);
  ok(`crash "${k}" label ${CRASH_ALARM.ink} on ${fill}: ${r.toFixed(2)}:1 >= ${AA}`, r >= AA);
}

console.log(`familyPalette.selftest: ${n} checks passed`);
