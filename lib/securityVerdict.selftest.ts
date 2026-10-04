// lib/securityVerdict.selftest.ts — run: npx tsx lib/securityVerdict.selftest.ts
//
// /blocked enforces only a verdict an in-app scan held here, never one from a
// URL. Pins: nothing is held until a scan says so, only restrict/wipe hold, and
// the screen reads this module rather than its route params.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clearRestrictVerdict, holdSecurityVerdict, securityVerdict } from './securityVerdict';

let failures = 0;
function ok(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}

console.log('securityVerdict — /blocked trusts the scan, not the link\n');

ok('nothing held at launch, so a crafted link gets the neutral view', securityVerdict() === null);

holdSecurityVerdict({ level: 'clean', threats: [] });
ok('a clean report holds nothing', securityVerdict() === null);
holdSecurityVerdict({ level: 'monitor', threats: [{ type: 'ADB_ENABLED', detail: '' }] });
ok('a monitor report holds nothing (monitor allows)', securityVerdict() === null);

holdSecurityVerdict({ level: 'restrict', threats: [{ type: 'EMULATOR_DETECTED', detail: 'x' }] });
ok('a restrict report is held with its threats',
  securityVerdict()?.level === 'restrict' && securityVerdict()?.threats.length === 1);

clearRestrictVerdict();
ok('a clean re-scan releases a held restrict verdict', securityVerdict() === null);

holdSecurityVerdict({ level: 'wipe', threats: undefined });
ok('a wipe report is held; missing threats become []',
  securityVerdict()?.level === 'wipe' && securityVerdict()?.threats.length === 0);

holdSecurityVerdict({ level: 'clean', threats: [] });
ok('a later clean report does not lift a held verdict (only a new process does)',
  securityVerdict()?.level === 'wipe');
clearRestrictVerdict();
ok('clearRestrictVerdict never releases a wipe verdict', securityVerdict()?.level === 'wipe');

const screen = readFileSync(join(__dirname, '..', 'app', 'blocked.tsx'), 'utf8');
console.log('\nThe wiring in app/blocked.tsx:');
ok('the screen reads the held verdict', /useState\(securityVerdict\)/.test(screen));
ok('and no longer takes the level from its route params', !/params\.level/.test(screen));
ok('a clean re-check releases only restrict, then leaves',
  /if \(report\.clean\) \{ clearRestrictVerdict\(\); leave\(\); return; \}/.test(screen));
const layout = readFileSync(join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
ok('the launch scan holds its report, then routes to /blocked after the launch gate',
  /holdSecurityVerdict\(report\);[\s\S]{0,400}await launchAllowed;\s*router\.replace\('\/blocked'/.test(layout));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
