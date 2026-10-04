// lib/scopedChoice.selftest.ts — run: npx tsx lib/scopedChoice.selftest.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveScoped, SCOPED_DEFAULT } from './scopedChoice';

assert.equal(resolveScoped(null, null), null, 'nothing set → app default');
assert.equal(resolveScoped(null, 'teal'), 'teal', 'global applies when the chat has no choice');
assert.equal(resolveScoped('rose', 'teal'), 'rose', 'per-chat wins');
assert.equal(resolveScoped(SCOPED_DEFAULT, 'teal'), null, 'explicit per-chat Default beats a global choice');
assert.equal(resolveScoped(undefined, SCOPED_DEFAULT), null);
assert.equal(resolveScoped('', 'teal'), 'teal', 'empty per-chat value is "unset"');

// Both readers must go through the rule, and both per-chat screens must store
// the explicit default rather than delete the key.
for (const f of ['app/chat-themes.tsx', 'app/chat-wallpaper.tsx']) {
  const src = readFileSync(f, 'utf8');
  assert.ok(src.includes('resolveScoped('), `${f} reads through resolveScoped`);
  assert.ok(src.includes('SCOPED_DEFAULT'), `${f} stores an explicit per-chat default`);
}
console.log('scopedChoice selftest: ok');
