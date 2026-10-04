// constants/syntaxPalette.selftest.ts — run: npx tsx constants/syntaxPalette.selftest.ts
//
// The code preview draws text in fixed token colours on a fixed dark canvas, so
// every one of them must clear WCAG AA (4.5:1) there, in either app theme.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { CODE_CANVAS, SYNTAX_TOKEN_COLORS } from './syntaxPalette';

let worst = Infinity;
for (const [token, ink] of Object.entries(SYNTAX_TOKEN_COLORS)) {
  const r = contrastOn(ink, CODE_CANVAS.bg);
  worst = Math.min(worst, r);
  assert.ok(r >= 4.5, `${token}: ${ink} on ${CODE_CANVAS.bg} is ${r.toFixed(2)}:1, under 4.5:1`);
}
const gutter = contrastOn(CODE_CANVAS.lineNum, CODE_CANVAS.gutterBg);
assert.ok(gutter >= 4.5, `line numbers are ${gutter.toFixed(2)}:1 on the gutter, under 4.5:1`);

// The screen must take its colours from here, not inline literals.
const SRC = readFileSync(join(__dirname, '..', 'app', 'file-preview.tsx'), 'utf8');
assert.ok(/SYNTAX_TOKEN_COLORS/.test(SRC) && /CODE_CANVAS\./.test(SRC), 'app/file-preview.tsx no longer reads the syntax palette');
assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(SRC), 'app/file-preview.tsx has an inline hex colour again');

console.log(`syntaxPalette: every token and the gutter clear 4.5:1 (worst token ${worst.toFixed(2)}:1, gutter ${gutter.toFixed(2)}:1)`);
