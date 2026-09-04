// lib/msgEnvelope.selftest.ts — run: npx tsx lib/msgEnvelope.selftest.ts
//
// WHAT THIS PROTECTS
//
// msgEnvelope decides what the server is allowed to learn about a message. Get
// it wrong in one direction and a base64 JPEG of every photo goes to the server
// in the clear; get it wrong in the other and the server loses a field it needs
// to route, authorise or validate — and the failure shows up as "polls stopped
// working" or "mentions no longer override mute", not as anything pointing here.
//
// msgEnvelope.ts imports nothing at runtime (its only import is `import type`),
// so unlike most of lib/ it runs directly under Node.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { META_PUBLIC_KEYS, splitMeta, wrapEnvelope, unwrapEnvelope } from './msgEnvelope';

const HERE = dirname(fileURLToPath(import.meta.url));
const NUL = String.fromCharCode(0);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── the leak this module exists to close ──────────────────────────────────
console.log('\nContent-bearing meta never reaches the server:');
const rich = {
  attachmentId: 'a1', encrypted: true,          // routing — must be sent
  thumb: 'BASE64JPEG', filename: 'holiday.jpg', // content — must not be
  mime: 'image/jpeg', width: 1200, height: 800,
  waveform: [1, 2, 3], durationMs: 4200,
  linkPreview: { u: 'https://x', t: 'T' },
  invisibleInk: true,
};
const { pub, priv } = splitMeta(rich);
for (const leak of ['thumb', 'filename', 'mime', 'width', 'height', 'waveform', 'durationMs', 'linkPreview', 'invisibleInk']) {
  check(`${leak} stays private`, !(leak in (pub ?? {})), `leaked: ${JSON.stringify(pub)}`);
}
check('attachmentId is sent (uploads.go authorises downloads by it)', pub?.attachmentId === 'a1');
check('encrypted is sent (render hint needed before the body)', pub?.encrypted === true);
check('the private half carries the thumbnail', priv?.thumb === 'BASE64JPEG');

// ── derivations the server depends on ─────────────────────────────────────
console.log('\nThe server gets a count, never the option text:');
const poll = splitMeta({ options: ['Pizza', 'Pasta', 'Salad'], allowMultiple: true });
check('option TEXT is private', !('options' in (poll.pub ?? {})));
check('optionCount is derived for the vote handler', poll.pub?.optionCount === 3);
check('allowMultiple is sent', poll.pub?.allowMultiple === true);
check('the options themselves travel privately', Array.isArray(poll.priv?.options));

console.log('\nMention ids go, mention names stay home:');
const men = splitMeta({ mentions: [{ userId: 'u9', name: 'Bob' }, { userId: 'u8', name: 'Cara' }] });
check('display names are private', JSON.stringify(men.pub ?? {}).includes('Bob') === false);
check('ids are derived for the push override', JSON.stringify(men.pub?.mentionUserIds) === '["u9","u8"]');
// A malformed mention must not produce a null/undefined id in the public array.
const badMen = splitMeta({ mentions: [{ name: 'NoId' }, { userId: 'u1' }] });
check('mentions without a userId are skipped', JSON.stringify(badMen.pub?.mentionUserIds) === '["u1"]');

// ── wire compatibility ────────────────────────────────────────────────────
console.log('\nAn ordinary message keeps the exact wire it had before:');
check('no meta -> nothing to send, nothing to fold',
  splitMeta(null).pub === null && splitMeta(null).priv === null);
const onlyPublic = splitMeta({ attachmentId: 'a1' });
check('all-public meta folds nothing', onlyPublic.priv === null);
check('and the plaintext is returned untouched',
  wrapEnvelope('hello', onlyPublic.priv) === 'hello');
check('an empty private object also folds nothing', wrapEnvelope('hello', {}) === 'hello');

// ── round trip ────────────────────────────────────────────────────────────
console.log('\nRound trip:');
const wire = wrapEnvelope('see this photo', priv);
check('the wrapper is NUL-prefixed (cannot collide with user text)', wire.startsWith(NUL));
const back = unwrapEnvelope(wire);
check('text survives', back.text === 'see this photo');
check('private meta survives intact', JSON.stringify(back.pm) === JSON.stringify(priv));
check('unwrapping plain text is a no-op', unwrapEnvelope('just text').text === 'just text');
check('and yields no private meta', unwrapEnvelope('just text').pm === null);

// Text that merely CONTAINS a NUL, or a truncated/corrupt wrapper, must render
// as itself rather than throwing inside a render pass.
console.log('\nCorrupt input degrades to raw text, never a throw:');
check('a truncated wrapper is returned verbatim',
  unwrapEnvelope(NUL + 'vc1:{"t":').text === NUL + 'vc1:{"t":');
check('a wrapper with no text field is returned verbatim',
  unwrapEnvelope(NUL + 'vc1:{"pm":{}}').text === NUL + 'vc1:{"pm":{}}');
check('null/undefined are handled', unwrapEnvelope(null).text === '' && unwrapEnvelope(undefined).pm === null);

// ── legacy history already on devices ─────────────────────────────────────
console.log('\nThe superseded lp1: wrapper is still readable:');
const legacy = NUL + 'lp1:' + JSON.stringify({ t: 'look', lp: { u: 'https://x', t: 'Title' } });
const lread = unwrapEnvelope(legacy);
check('its text is recovered', lread.text === 'look');
check('its preview comes back as private meta', (lread.pm as any)?.linkPreview?.t === 'Title');
const legacyNoLp = NUL + 'lp1:' + JSON.stringify({ t: 'plain' });
check('a legacy wrapper without a preview yields no meta',
  unwrapEnvelope(legacyNoLp).text === 'plain' && unwrapEnvelope(legacyNoLp).pm === null);

// ── the two allow-lists must not drift ────────────────────────────────────
// The client decides what is SENT; the server decides what is KEPT when it
// reclaims a delivered body. If they disagree, either the client sends
// something the server will strip (a field that silently stops working) or the
// server keeps something the client considers private (a silent leak).
console.log('\nClient and server allow-lists agree:');
const goSrc = readFileSync(join(HERE, '..', 'vaultchat-backend-go', 'internal', 'jobs', 'meta_public.go'), 'utf8');
const block = goSrc.match(/var MetaPublicKeys = \[\]string\{([\s\S]*?)\n\}/)?.[1] ?? '';
const goKeys = [...block.matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]);
check('the Go list was found and parsed', goKeys.length > 0, `parsed: ${goKeys.length}`);
const ts = [...META_PUBLIC_KEYS].sort();
const go = [...goKeys].sort();
check(`both lists have the same ${ts.length} keys`, JSON.stringify(ts) === JSON.stringify(go),
  `ts=${JSON.stringify(ts)} go=${JSON.stringify(go)}`);

// Server code reads these by name; losing one from the list breaks a feature
// quietly, so they are pinned individually rather than only by set equality.
for (const required of ['attachmentId', 'viewOnce', 'silent', 'groupId', 'game', 'room', 'optionCount', 'mentionUserIds']) {
  check(`${required} is public (server code reads it)`, META_PUBLIC_KEYS.includes(required));
}

assert.ok(true);
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
