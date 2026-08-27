/**
 * lib/status/gateWiring.selftest.ts
 *   run with: npx tsx lib/status/gateWiring.selftest.ts
 *
 * Guards the wiring defects that each made the whole status-gate feature
 * silently inert. All of them were invisible to types, to lint, and to every
 * unit test, because nothing was WRONG anywhere — a value was simply never
 * carried from where it was produced to where it was read.
 *
 *   1. postPreview read `gate` but did not depend on it. The callback was
 *      rebuilt when the poster picked their media (previewAssets changed) and
 *      captured gate = {kind:'none'}; the poster then chose a lock INSIDE the
 *      preview modal, which changes no other dependency, so the callback was
 *      never rebuilt and posted the stale 'none'. Every status went out
 *      ungated regardless of what was selected. Confirmed against prod: the
 *      one row in `stories` was posted with the puzzle option visibly selected
 *      and stored gate_kind NULL.
 *
 *   2. feedStory dropped the four gate columns. The feed query selected them
 *      and the scan read them, then the struct literal threw them away — so
 *      the viewer was told there was no gate. Also covered by the Go test
 *      TestFeedCarriesTheGate; asserted here because the two halves are one
 *      feature and a reader of this file should see both ends of it.
 *
 *   3. The two grid ranges must agree, or a poster is offered a size the
 *      server refuses.
 *
 * SOURCE SCAN, deliberately: these invariants are about wiring — which
 * identifier appears in which dependency array, which field is copied into
 * which struct — and none is a pure value a runtime assertion can reach. A
 * source scan belongs in a *.selftest.ts and never inside a shipped module
 * (an fs require in app code breaks assembleRelease).
 *
 * NO `new RegExp(`...`)` IN THIS FILE. An earlier version of check 3 used one
 * and could never match: inside a template literal `\s` is just "s" and `\b`
 * is a backspace character, so the guard passed on every input and proved
 * nothing. Regex LITERALS keep their escapes and are fine; string-built ones
 * are not. Plain parsing is used instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const statusSrc = readFileSync(join(root, 'app', '(tabs)', 'status.tsx'), 'utf8');
const goSrc = readFileSync(
  join(root, 'vaultchat-backend-go', 'internal', 'routes', 'stories.go'), 'utf8');

// ── 1. The poster's choice must reach the post call ──────────────────
// Anchored to postPreview's own declaration, not a bare search for "gate", so
// that removing the dependency actually fails this.
const declAt = statusSrc.indexOf('const postPreview = useCallback');
assert.ok(declAt > 0, 'postPreview not found — was it renamed?');
const depsMatch = /\}, \[([^\]]*)\]\);/.exec(statusSrc.slice(declAt));
assert.ok(depsMatch, 'postPreview has no dependency array');
const deps = depsMatch[1].split(',').map(d => d.trim()).filter(Boolean);

assert.ok(
  deps.includes('gate'),
  `postPreview reads gate but does not depend on it (deps: ${deps.join(', ')}).\n` +
  "The poster picks the lock inside the preview modal, which changes no other\n" +
  "dependency — so the callback keeps the {kind:'none'} it captured when the\n" +
  'media was chosen, and EVERY status posts ungated. The picker becomes\n' +
  'decoration and nothing errors.',
);

// The reads this guard exists for. If they move out of postPreview, the
// dependency assertion above is no longer guarding anything.
const bodyEnd = declAt + depsMatch.index + depsMatch[0].length;
const body = statusSrc.slice(declAt, bodyEnd);
for (const read of ["gate.kind === 'question'", "gate.kind === 'puzzle'", 'gate.answer']) {
  assert.ok(body.includes(read), `postPreview no longer reads ${read} — re-check this guard`);
}

// ── 2. The server must hand the gate to the VIEWER, not just the poster ──
// publicStory is the POST response and goes back to the poster, who is never
// challenged by their own gate. feedStory is the only story payload a viewer
// ever reads, so it is the one that has to carry these.
const feedAt = goSrc.indexOf('func feedStoryFrom');
assert.ok(feedAt > 0, 'feedStoryFrom not found — was the mapping inlined again?');
// Whitespace-stripped: gofmt is free to realign these columns.
const feedMap = goSrc.slice(feedAt, feedAt + 900).replace(/\s+/g, '');
for (const f of ['GateKind', 'GateGrid', 'GatePrompt', 'GateSalt']) {
  assert.ok(
    feedMap.includes(`${f}:s.${f}`),
    `feedStoryFrom does not copy ${f} — every gated status opens ungated for viewers`,
  );
}

// ── 3. The client's grid range must match the server's ────────────────
// A poster offered a size the server rejects gets an opaque 400 at post time,
// AFTER the media has already uploaded.
const gateTs = readFileSync(join(root, 'lib', 'status', 'gate.ts'), 'utf8');
const min = /GRID_MIN\s*=\s*(\d+)/.exec(gateTs);
const max = /GRID_MAX\s*=\s*(\d+)/.exec(gateTs);
assert.ok(min && max, 'GRID_MIN/GRID_MAX not found in lib/status/gate.ts');

const goConst = (name: string): string | null => {
  const line = goSrc.split('\n').find(l => l.trim().startsWith(name + ' ='));
  if (!line) return null;
  const n = /(\d+)/.exec(line.split('=')[1] ?? '');
  return n ? n[1] : null;
};
const goMin = goConst('gateGridMin');
const goMax = goConst('gateGridMax');
assert.equal(
  `${goMin}..${goMax}`, `${min[1]}..${max[1]}`,
  `grid range disagrees: client ${min[1]}..${max[1]}, Go ${goMin}..${goMax}. ` +
  'A poster offered a size the server refuses gets an opaque 400 AFTER the ' +
  'media has already uploaded.',
);

console.log('gateWiring selftest: OK');
console.log(`  postPreview deps: [${deps.join(', ')}]`);
console.log(`  grid range ${min[1]}..${max[1]} agrees client <-> server`);
