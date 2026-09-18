/**
 * lib/rowOverflow.selftest.ts
 *   run with: npx tsx lib/rowOverflow.selftest.ts
 *
 * ONE CLASS OF BUG: a row that lays out a variable number of FIXED-WIDTH
 * children, in a container that neither wraps nor scrolls.
 *
 * A row like that is correct on exactly the developer's phone and wrong on
 * everything narrower. The children do not shrink (flexShrink defaults to 0 in
 * Yoga) and the row does not wrap, so the overflow is simply not drawn — and
 * with `justifyContent: 'center'` it overflows BOTH ends, so the first and last
 * children are the ones that disappear. That is how the group call shipped with
 * Mute and End call off-screen: seven 60dp controls with a 22dp gap need 552dp,
 * against 369dp on the reference Honor and 320dp on the floor this app
 * supports.
 *
 * WHY A WIDTH GREP NEVER FOUND IT
 * -------------------------------
 * The width was not at the call site. `CtrlBtn` pins `width: 60` inside its own
 * component body, so `app/group-call-active.tsx` contained seven call sites
 * with no width on any of them. Section 1 below therefore resolves a child's
 * width three ways: a referenced style, an inline style, and a component
 * DEFINED IN THE SAME FILE that pins its own width.
 *
 * WHAT THIS DOES NOT SEE, stated plainly rather than implied:
 *   - a child component imported from another file. Resolving that needs a
 *     module graph, which a source scan does not have.
 *   - a row whose children are `.map`ped over runtime data. The count is
 *     unbounded, so the honest demand is unbounded, but asserting that flags
 *     ~50 rows of 8dp dots and 26dp avatars that are fine in practice. Counting
 *     literal children keeps this check at zero false positives, which is the
 *     only state in which it stays useful.
 *   - a child with no width at all, sized by its own text. That one is real
 *     (text grows with the OS font scale while fixed padding does not) and is
 *     what section 2 pins by hand.
 *
 * So section 1 is the class and section 2 is the sites the class cannot reach.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

/** Narrowest window this app supports. A row wider than this is broken there. */
const FLOOR_DP = 320;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'dist', 'android', 'ios'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

const styleMap = (src: string) =>
  new Map([...src.matchAll(/(\w+)\s*:\s*\{([^{}]*)\}/g)].map((x) => [x[1], x[2]] as [string, string]));

/**
 * The width a child DEMANDS, or 0 if it has none.
 *
 * `flex` wins outright — a flexing child is by definition not fixed-width, and
 * flexing is one of the three cures. `minWidth` counts: it is a floor the child
 * cannot go under, which is exactly what makes a row overflow.
 */
function pinnedWidth(body: string): number {
  if (/(^|[^a-zA-Z])flex:\s*[1-9]/.test(body)) return 0;
  const w = body.match(/(?<!min)(?<!max)\bwidth:\s*(\d+)/) ?? body.match(/\bminWidth:\s*(\d+)/);
  return w ? Number(w[1]) : 0;
}

/**
 * End index of the opening tag at `i`, and whether it self-closes.
 * Brace depth is tracked so a `style={{ width: 8 }}` cannot end the tag early.
 */
function openTagEnd(src: string, i: number): [number, boolean] {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return [k, src[k - 1] === '/'];
  }
  return [src.length, true];
}

/**
 * Body of the `function Name(...)` declaration at `at`.
 *
 * A fixed-size slice is not good enough and the difference is the whole check:
 * `CtrlBtn` is the last function in group-call-active.tsx, so any window wide
 * enough to hold it also swallowed the `makeStyles` below it — whose very first
 * entry is `screen: { flex: 1 }`. `pinnedWidth` then read that `flex` as the
 * child's own and returned 0, and the 552dp row scanned clean.
 */
function functionBody(src: string, at: number): string {
  const open = src.indexOf('{', src.indexOf(')', at));
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(open, k + 1);
  }
  return '';
}

/** Source text of the element opened at `start`, up to its matching close tag. */
function region(src: string, start: number, tag: string): string {
  const marks: Array<[number, number]> = [];
  for (const m of src.matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))) {
    if (m.index! < start) continue;
    // A self-closing element opens and closes at once. Counting it as an open
    // made every region run to the end of the file and produced nonsense.
    if (!openTagEnd(src, m.index!)[1]) marks.push([m.index!, 1]);
  }
  for (const m of src.matchAll(new RegExp(`</${tag}>`, 'g'))) if (m.index! >= start) marks.push([m.index!, -1]);
  marks.sort((a, b) => a[0] - b[0]);
  let d = 0;
  for (const [i, x] of marks) { d += x; if (d === 0) return src.slice(start, i); }
  return '';
}

// ── 1. No non-wrapping row demands more than the narrowest screen ────
const overflowing: string[] = [];

for (const file of [...walk('app'), ...walk('components')]) {
  const src = fs.readFileSync(file, 'utf8');
  const styles = styleMap(src);

  for (const [name, body] of styles) {
    if (!/flexDirection:\s*'row'/.test(body)) continue;
    // Cure 1: it wraps. Opt out in place with `layout-exempt:` and a reason,
    // matching the idiom the other layout guards already use.
    if (/flexWrap/.test(body) || body.includes('layout-exempt')) continue;

    const gap = Number((body.match(/(^|[^a-zA-Z])gap:\s*(\d+)/) ?? [0, 0, 0])[2]);

    for (const m of src.matchAll(
      new RegExp(`<(\\w+)([^>]*?)style=\\{\\[?[^}]*?\\b\\w+\\.${name}\\b[^}]*?\\}`, 'g'),
    )) {
      const tag = m[1];
      // Cure 2: it scrolls.
      if (/ScrollView|FlatList|SectionList/.test(tag)) continue;
      const r = region(src, m.index!, tag);
      if (!r) continue;

      // Every distinguishable fixed-width child, with how many of it this row
      // actually renders.
      const children: Array<[number, number]> = [];
      for (const ref of new Set([...r.matchAll(/\b\w+\.(\w+)\b/g)].map((x) => x[1]))) {
        if (ref === name || !styles.has(ref)) continue;
        const w = pinnedWidth(styles.get(ref)!);
        if (w) children.push([w, [...r.matchAll(new RegExp(`\\.${ref}\\b`, 'g'))].length]);
      }
      for (const t of new Set([...r.matchAll(/<([A-Z]\w+)[\s/>]/g)].map((x) => x[1]))) {
        const at = src.indexOf(`function ${t}(`);
        if (at < 0) continue;
        const w = pinnedWidth(functionBody(src, at));
        if (w) children.push([w, [...r.matchAll(new RegExp(`<${t}[\\s/>]`, 'g'))].length]);
      }

      for (const [w, count] of children) {
        const demand = count * w + (count - 1) * gap;
        if (demand <= FLOOR_DP) continue;
        overflowing.push(
          `${file}  ${name}: ${count} x ${w}dp + ${count - 1} x ${gap}dp gap = ${demand}dp > ${FLOOR_DP}dp`,
        );
      }
    }
  }
}

ok(
  overflowing.length === 0
    ? `no non-wrapping row demands more than ${FLOOR_DP}dp`
    : 'rows whose children cannot fit the narrowest supported screen ' +
      '(wrap the row, scroll it, or let the children flex):\n      ' + overflowing.join('\n      '),
  overflowing.length === 0,
);

// ── 2. The sites section 1 structurally cannot reach ─────────────────
//
// Two of the four repairs in this task are invisible to a width scan, for two
// different reasons. They are pinned by hand rather than left to rot.
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

// 2a. GifPicker's tabs have NO width. They size themselves from their label,
//     so nothing to sum - but fixed paddingHorizontal plus text that grows with
//     the OS font scale is the same bug arriving later. Every other tab row in
//     the app (15 of them) gives the tab flex:1; this was the one that did not.
const gif = read('components/GifPicker.tsx');
const gifTab = gif.split('\n').find((l) => l.trimStart().startsWith('tab:')) ?? '';
ok('GifPicker tabs share the row instead of sizing to their labels', /flex:\s*1/.test(gifTab));
ok('GifPicker tabs still centre their label once they flex', /alignItems:\s*'center'/.test(gifTab));

// 2b. The chat media/file/video cards are not a row at all - they are single
//     fixed-width children of a bubble capped at a PERCENTAGE of the row. Same
//     class (a fixed dp width in a slot that is not fixed), different shape, so
//     section 1 cannot see it. layoutMetrics.selftest runs the arithmetic;
//     responsiveLayout pins the file/poll/audio cards. The video player was
//     missed by both and is pinned here.
const chat = read('components/chat/chatStyles.ts');
for (const style of ['videoWrap', 'videoLoading']) {
  const line = chat.split('\n').find((l) => l.trimStart().startsWith(style + ':')) ?? '';
  ok(`${style} is capped by the bubble slot, not a literal 240`, /Math\.min\(240, m\.cardMax\)/.test(line));
}

// 2c. The two rows section 1 DOES catch, pinned by name so a revert is named in
//     the failure rather than reported as an anonymous count. group-call is the
//     one with real consequence: without the wrap, End call is off-screen and a
//     user cannot hang up.
for (const [file, style] of [
  ['app/group-call-active.tsx', 'controls'],
  ['app/call-recording.tsx', 'actionRow'],
] as const) {
  const line = read(file).split('\n').find((l) => l.trimStart().startsWith(style + ':')) ?? '';
  ok(`${file} ${style} still wraps`, /flexWrap:\s*'wrap'/.test(line));
}

console.log(`rowOverflow.selftest: ${n} assertions passed`);
