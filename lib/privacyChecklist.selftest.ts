// lib/privacyChecklist.selftest.ts — run: npx tsx lib/privacyChecklist.selftest.ts
import assert from 'node:assert/strict';
import { privacyChecklist, privacyScore, type PrivacyFacts } from './privacyChecklist';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log('  ok  ' + label); };

const ALL_OFF: PrivacyFacts = {
  e2ee: false, screenshotsBlocked: false, deviceMfa: false, pinSet: false,
  trustedContacts: false, lastSeenHidden: false, readReceiptsOff: false,
};
const ALL_ON: PrivacyFacts = {
  e2ee: true, screenshotsBlocked: true, deviceMfa: true, pinSet: true,
  trustedContacts: true, lastSeenHidden: true, readReceiptsOff: true,
};

ok('every fact gets exactly one row, each with its own key', () => {
  const rows = privacyChecklist(ALL_OFF);
  assert.deepEqual(rows.map((r) => r.key).sort(), Object.keys(ALL_OFF).sort());
});

ok('E2E encryption reads the e2ee fact, not some other key', () => {
  // The old dashboard bound "E2E Encryption" to the screenshotProtection key.
  const rows = privacyChecklist({ ...ALL_OFF, e2ee: true });
  assert.equal(rows.find((r) => r.key === 'e2ee')!.on, true);
  assert.equal(rows.find((r) => r.key === 'screenshotsBlocked')!.on, false);
});

ok('the score is 0 with everything off and 100 with everything on', () => {
  assert.equal(privacyScore(privacyChecklist(ALL_OFF)), 0);
  assert.equal(privacyScore(privacyChecklist(ALL_ON)), 100);
});

ok('a row the platform cannot provide is left out, not counted as a failure', () => {
  const ios = privacyChecklist({ ...ALL_ON, screenshotsBlocked: null });
  assert.equal(privacyScore(ios), 100);
  const half = privacyChecklist({ ...ALL_OFF, e2ee: true, deviceMfa: true, pinSet: true, screenshotsBlocked: null });
  assert.equal(privacyScore(half), 50);   // 3 of the 6 applicable rows
});

ok('fixed rows have no route; every changeable row says where it is changed and why', () => {
  for (const r of privacyChecklist(ALL_OFF)) {
    if (r.fixed) assert.equal(r.route, undefined, r.key);
    else { assert.ok(r.route?.startsWith('/'), r.key); assert.ok(r.suggestion, r.key); }
  }
});

ok('a fact that could not be checked is left out of the score and never counts as on', () => {
  const rows = privacyChecklist({ ...ALL_ON, trustedContacts: 'unknown', lastSeenHidden: 'unknown' });
  assert.equal(rows.find((r) => r.key === 'trustedContacts')!.on, 'unknown');
  assert.equal(privacyScore(rows), 100);
  const mixed = privacyChecklist({ ...ALL_OFF, e2ee: true, deviceMfa: 'unknown', pinSet: 'unknown' });
  assert.equal(privacyScore(mixed), 20);  // 1 of the 5 checked rows
  assert.equal(privacyScore(privacyChecklist({
    e2ee: 'unknown' as never, screenshotsBlocked: null, deviceMfa: 'unknown', pinSet: 'unknown',
    trustedContacts: 'unknown', lastSeenHidden: 'unknown', readReceiptsOff: 'unknown',
  })), 0);
});

console.log(`\nprivacyChecklist.selftest: ${n} passed`);
