// lib/legacyRefreshParity.selftest.ts — run: npx tsx lib/legacyRefreshParity.selftest.ts
//
// AUDIT F05/F06/F07, LEGACY SIDE.
//
// The Node backend is not dead code and is not serving traffic either: it is
// the ROLLBACK TARGET (docker-compose `profiles: ["legacy"]`). That makes it
// the worst possible place for these three bugs to survive, because a rollback
// happens during an incident, when nobody has spare attention:
//
//   F05  refresh scanned the newest 500 live rows ACROSS ALL USERS and
//        bcrypt-compared each. Past 500 rows a valid older token stops being
//        found and the user is signed out. A row limit, not a user limit.
//   F06  "sign out other devices" hashed the presented token afresh and
//        compared with SQL equality. bcrypt salts every hash, so the caller's
//        row never matched, was never excluded, and was revoked too.
//   F07  the 30-second rotation grace keyed off revoked_at alone, so a device
//        kicked from the sessions screen kept minting credentials for 30s.
//
// Both files are CommonJS Express routes that require a database at import
// time, so this reads the source. That is the right depth for the risk: what
// must not come back is a specific SQL shape, and a specific SQL shape is
// exactly what a source check can see.

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const AUTH = read('vaultchat-backend/routes/auth.js');
const USER = read('vaultchat-backend/routes/user.js');

console.log('\nLegacy (rollback) refresh-token parity self-test\n');

console.log('F05 — a token is FOUND by an indexed equality, not by scanning:');
check('issueTokens writes token_lookup', /INSERT INTO refresh_tokens \(user_id, token_hash, expires_at, user_agent, ip, token_lookup\)/.test(AUTH));
check('the lookup uses the same keyed primitive as Go', /vault\.lookupHash\('refresh:' \+ token\)/.test(AUTH));
check('refresh selects on token_lookup', /WHERE token_lookup = \$2 AND expires_at > NOW\(\)/.test(AUTH));
check('the 500-row scan is fenced to pre-127 rows only',
  /WHERE token_lookup IS NULL AND expires_at > NOW\(\)[\s\S]{0,120}LIMIT 500/.test(AUTH),
  'an unfenced LIMIT 500 is the F05 bug itself');
check('bcrypt still authorises the row the lookup found',
  /token_lookup = \$2[\s\S]{0,400}compareRefresh\(presented, hit\.rows\[0\]\.token_hash\)/.test(AUTH),
  'the lookup must find the row, never authorise it');

console.log('\nF06 — the current session is identified by ROW ID:');
check('hashCurrentRefresh is gone', !/hashCurrentRefresh/.test(USER));
check('currentSessionId replaces it', /async function currentSessionId\(userId, rawHeader\)/.test(USER));
check('GET /sessions marks the current row by id', /id = \$2 AS is_current/.test(USER));
check('the never-matching bcrypt equality is gone', !/token_hash = \$2 AS is_current/.test(USER));
check('sign-out-others excludes by id', /AND id <> \$2/.test(USER));
// Anchored to the SQL, not the bare string: the doc comment above
// currentSessionId quotes `token_hash <> $2` while explaining why it was wrong,
// and a test that cannot tell the fix from its own explanation is noise.
check('it no longer excludes by token_hash', !/revoked_at IS NULL AND token_hash <> \$2/.test(USER),
  'this matched every row including the caller — the whole F06 bug');
check('an unplaceable token REFUSES instead of revoking everything',
  /if \(!currentId\) \{[\s\S]{0,160}status\(400\)/.test(USER));

console.log('\nF07 — only rotation earns the grace window:');
check('the grace clause requires revoked_reason = rotated',
  /revoked_reason = 'rotated'\s*\n?\s*AND revoked_at > NOW\(\) - \(\$1/.test(AUTH));
check('rotation records that reason', /SET revoked_at = NOW\(\), revoked_reason = 'rotated'/.test(AUTH));
check('revoking one device records a DIFFERENT reason', /revoked_reason = 'revoked_by_user'/.test(USER));
check('signing out other devices records a different reason', /revoked_reason = 'signed_out_other_devices'/.test(USER));
check("no explicit revocation writes 'rotated'", !/revoked_reason = 'rotated'/.test(USER),
  'an explicit revocation that claims rotation buys itself the grace window');

console.log(failures === 0 ? '\nAll legacy refresh checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
