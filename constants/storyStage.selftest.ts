// constants/storyStage.selftest.ts — run: npx tsx constants/storyStage.selftest.ts
//
// Every text ink on the always-black story stage must be AA (4.5:1). The gate's
// hint and wrong-answer lines are 12–13 px, so there is no large-text allowance.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { STORY_STAGE } from './storyStage';

const alphaOf = (c: string) => {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(c);
  if (!m) return { hex: c, a: 1 };
  const hex = '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('');
  return { hex, a: Number(m[4]) };
};

for (const key of ['ink', 'faint', 'error'] as const) {
  const { hex, a } = alphaOf(STORY_STAGE[key]);
  const r = contrastOn(hex, STORY_STAGE.bg, a);
  assert.ok(r >= 4.5, `STORY_STAGE.${key} on the stage is ${r.toFixed(2)}:1, under 4.5:1`);
  console.log(`  ✓ ${key} ${r.toFixed(2)}:1`);
}
// The field fill must stay faint enough that white typed text on it is still AA.
const field = alphaOf(STORY_STAGE.field);
const fieldGround = Math.round(255 * field.a).toString(16).padStart(2, '0').repeat(3);
assert.ok(contrastOn(STORY_STAGE.ink, '#' + fieldGround) >= 4.5, 'typed text on the field fill is under 4.5:1');

const GATE = readFileSync(join(__dirname, '..', 'components', 'status', 'GateChallenge.tsx'), 'utf8');
assert.ok(/STORY_STAGE\./.test(GATE), 'GateChallenge no longer reads STORY_STAGE');
assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(GATE), 'GateChallenge has an inline hex colour again');

console.log('storyStage: every stage ink is AA on black');
