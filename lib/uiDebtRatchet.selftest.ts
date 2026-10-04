// lib/uiDebtRatchet.selftest.ts — run: npx tsx lib/uiDebtRatchet.selftest.ts
//
// A ratchet, not a rule. The 2026-10 screen audit added roles to touchables and
// moved colours onto theme tokens across every screen, but both still have
// deliberate exceptions (always-dark media/call screens, alarm and brand
// colours) and some untouched corners. A hard "zero" check would either fail
// today or need an exemption list longer than the code it guards. Instead this
// records, per file, how many of each remain, and fails when a file's count
// GOES UP. Lowering a count is free; regenerate the baseline afterwards with
//   npx tsx lib/uiDebtRatchet.selftest.ts --write
//
// Counted per .tsx file under app/ and components/:
//   unroled   — <TouchableOpacity|Pressable|TouchableHighlight|TouchableWithoutFeedback
//               opening tags with no accessibilityRole (spread props `{...x}` count
//               as roled: the role may come from the spread)
//   hex       — '#rgb' / '#rrggbb' / '#rrggbbaa' string literals

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'uiDebtRatchet.baseline.json');
const TAG = /<(TouchableOpacity|Pressable|TouchableHighlight|TouchableWithoutFeedback)\b/g;
const HEX = /['"`]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})['"`]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** The text of a JSX opening tag starting at `i`, to its closing `>` at brace depth 0. */
function openingTag(src: string, i: number): string {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

function count(src: string): { unroled: number; hex: number } {
  let unroled = 0;
  for (const m of src.matchAll(TAG)) {
    const tag = openingTag(src, m.index!);
    if (!/accessibilityRole\s*=/.test(tag) && !/\{\s*\.\.\./.test(tag)) unroled++;
  }
  return { unroled, hex: (src.match(HEX) ?? []).length };
}

const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))].sort();
const now: Record<string, { unroled: number; hex: number }> = {};
for (const f of files) {
  const c = count(fs.readFileSync(f, 'utf8'));
  if (c.unroled || c.hex) now[path.relative(ROOT, f).split(path.sep).join('/')] = c;
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(BASELINE, JSON.stringify(now, null, 1) + '\n');
  const t = Object.values(now).reduce((a, c) => ({ unroled: a.unroled + c.unroled, hex: a.hex + c.hex }), { unroled: 0, hex: 0 });
  console.log(`uiDebtRatchet: baseline written — ${t.unroled} unroled touchables, ${t.hex} hex literals`);
  process.exit(0);
}

const base: Record<string, { unroled: number; hex: number }> = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const worse: string[] = [];
for (const [f, c] of Object.entries(now)) {
  const b = base[f] ?? { unroled: 0, hex: 0 };
  if (c.unroled > b.unroled) worse.push(`${f}: unroled touchables ${b.unroled} -> ${c.unroled}`);
  if (c.hex > b.hex) worse.push(`${f}: hex colour literals ${b.hex} -> ${c.hex}`);
}
if (worse.length) {
  console.error('uiDebtRatchet: these files gained UI debt (add accessibilityRole / use theme tokens):\n  ' + worse.join('\n  '));
  process.exit(1);
}
const t = Object.values(now).reduce((a, c) => ({ unroled: a.unroled + c.unroled, hex: a.hex + c.hex }), { unroled: 0, hex: 0 });
console.log(`uiDebtRatchet: no file got worse (${t.unroled} unroled touchables, ${t.hex} hex literals remain)`);
