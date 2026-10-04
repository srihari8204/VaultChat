// Run: npx tsx lib/tabsContactsRound8.selftest.ts
//
// Round-8 wiring for the tabs / contacts batch (source pins; the behaviour
// behind each needs a device to see):
//   * contacts: one scan at a time — the AppState re-check on return from
//     Settings cannot start a second scan while the first is still asking for
//     permission (a ref, because both callers would read `scanning` stale);
//   * Chats: the invitation listener is persistent like the other realtime
//     listeners, so it re-arms on a socket replaced under the screen;
//   * contact-info: every section title is a heading for screen readers;
//   * every QR this app draws has a light quiet zone (the box behind it is the
//     theme surface, dark in dark mode);
//   * invite-link: rows take the screen's styles instead of building their own;
//   * profile: no state write after the screen is gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const contacts = read('app', 'contacts.tsx');
const scanAt = contacts.indexOf('const scan = useCallback(async () => {');
const scanBody = contacts.slice(scanAt, contacts.indexOf('  }, []);', scanAt));
assert.match(contacts, /const scanningRef = useRef\(false\);/);
assert.match(scanBody, /^const scan = useCallback\(async \(\) => \{\s*if \(scanningRef\.current\) return;\s*scanningRef\.current = true;/,
  'scan returns while one is running and takes the latch first');
assert.match(scanBody, /\} finally \{\s*scanningRef\.current = false;/, 'scan releases the latch in finally');

const chats = read('app', '(tabs)', 'chats.tsx');
assert.match(chats, /addPersistentListener\('invitation_created', \(\) => \{ refreshInvites\(\); \}\)/,
  'the invitation listener is persistent');
assert.doesNotMatch(chats, /on\('invitation_created'/, 'no plain on() left for it');

const info = read('app', 'contact-info.tsx');
const titles = info.match(/<Text style=\{s\.sectionTitle\}[^>]*>/g) ?? [];
assert.ok(titles.length >= 6, `found ${titles.length} section titles`);
for (const t of titles) assert.match(t, /accessibilityRole="header"/, `section title is a header: ${t}`);

for (const f of ['qr-contact.tsx', 'invite-link.tsx', 'verify-contact.tsx']) {
  const src = read('app', f);
  const qrs = src.match(/<QRCode [^>]*\/>/g) ?? [];
  assert.ok(qrs.length >= 1, `${f}: draws a QR`);
  for (const q of qrs) assert.match(q, /\{\.\.\.QR_COLORS\} quietZone=\{\d+\}/, `${f}: QR has a quiet zone in QR_COLORS' white`);
}

const invite = read('app', 'invite-link.tsx');
const rowAt = invite.indexOf('const LinkRow = memo(');
const rowBody = invite.slice(rowAt, invite.indexOf('export default function', rowAt));
assert.doesNotMatch(rowBody, /useS\(\)/, 'LinkRow does not build a StyleSheet per row');
assert.match(invite, /<LinkRow item=\{item\} revokeBusy=\{revokingId != null\} s=\{s\}/, 'the screen passes its styles down');

const profile = read('app', '(tabs)', 'profile.tsx');
assert.doesNotMatch(profile.replace(/if \(alive\.current\) setProfile\(updated\);/g, ''), /setProfile\(updated\)/,
  'every setProfile(updated) after an await is guarded by alive');

console.log('tabsContactsRound8 selftest: OK');
