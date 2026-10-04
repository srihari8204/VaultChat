// constants/inkPalette.selftest.ts — run: npx tsx constants/inkPalette.selftest.ts
//
// The drawing tools' inks are a fixed palette (constants/inkPalette.ts). Each
// swatch is a radio labelled by its ink's name, so a duplicate hex would make
// two swatches select together and a duplicate name would make two sound alike.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_INKS, WHITEBOARD_INKS, inkNames } from './inkPalette';

for (const [label, inks] of [['whiteboard', WHITEBOARD_INKS], ['editor', EDITOR_INKS]] as const) {
  assert.ok(inks.length > 0, `${label}: no inks`);
  for (const i of inks) {
    assert.match(i.hex, /^#[0-9A-Fa-f]{6}$/, `${label}: ${i.hex} is not a 6-digit hex colour`);
    assert.ok(i.name.trim() && !i.name.startsWith('#'), `${label}: ${i.hex} has no spoken name`);
  }
  assert.equal(new Set(inks.map(i => i.hex.toUpperCase())).size, inks.length, `${label}: duplicate ink colour`);
  assert.equal(new Set(inks.map(i => i.name)).size, inks.length, `${label}: duplicate ink name`);
  assert.equal(Object.keys(inkNames(inks)).length, inks.length);
}
// The image editor's default brush/text colour is white, the first ink.
assert.equal(EDITOR_INKS[0].hex, '#FFFFFF');

// The screens must take their inks from here, not inline literals.
for (const f of ['whiteboard.tsx', 'image-editor.tsx']) {
  const src = readFileSync(join(__dirname, '..', 'app', f), 'utf8');
  assert.ok(/_INKS\b/.test(src), `app/${f} no longer reads constants/inkPalette`);
  assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(src), `app/${f} has an inline hex colour again`);
}

console.log(`inkPalette: ${WHITEBOARD_INKS.length} whiteboard + ${EDITOR_INKS.length} editor inks, all named and unique`);
