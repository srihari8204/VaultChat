// lib/media/sheetPaneNesting.selftest.ts — run: npx tsx lib/media/sheetPaneNesting.selftest.ts
//
// DocView's row pane for a big sheet is a vertical FlatList that sits inside
// the document's own vertical FlatList. In the installed RN 0.81 a
// same-orientation list found in VirtualizedListContext makes the inner list
// "nested": it windows from the PAGE's scroll metrics, not its own, so rows
// scroll in blank. DocView wraps the pane in PaneRoot, which resets that
// context (and ScrollView's) the way RN's Modal does. Source-level, like
// lib/hiddenChatMask.selftest.ts: it proves the reset is wired and that the
// installed library still behaves the way the fix relies on — not that a
// device renders it (that needs a long second worksheet on a phone).

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── DocView wires the reset around the pane, and only the pane ─────────
const doc = code('components/DocView.tsx');
assert.match(doc, /require\('@react-native\/virtualized-lists'\)\.default\s*\.VirtualizedListContextResetter/,
  'the resetter is the installed package export, not a home-made context');
assert.match(doc, /const ScrollViewContext = \(ScrollView as unknown as \{ Context: React\.Context<unknown> \}\)\.Context;/);
const paneRoot = doc.slice(doc.indexOf('function PaneRoot'), doc.indexOf('type DocStyles'));
assert.match(paneRoot, /<VirtualizedListContextResetter>\s*(?:\{\}\s*)?<ScrollViewContext\.Provider value=\{null\}>\{children\}<\/ScrollViewContext\.Provider>\s*<\/VirtualizedListContextResetter>/,
  'PaneRoot nulls both contexts, as Modal does');

const grid = doc.slice(doc.indexOf('function Grid('), doc.indexOf('const rowKey'));
const pane = grid.match(/<PaneRoot>([\s\S]*?)<\/PaneRoot>/);
assert.ok(pane, 'the row pane is wrapped in PaneRoot');
assert.match(pane[1], /^\s*<GHFlatList\s+data=\{body\}/, 'PaneRoot wraps the row list directly');
assert.match(pane[1], /maxHeight: paneHeight/, 'the pane stays bounded, so it scrolls itself');
assert.match(pane[1], /nestedScrollEnabled/, 'Android hands the vertical drag to the pane');
// The header stays pinned ABOVE the pane, inside the same grid view and the
// one shared horizontal scroller.
assert.ok(grid.indexOf('plan.pinned === 1 && <GridRow') < grid.indexOf('<PaneRoot>'), 'header row is drawn above the pane');
assert.equal((grid.match(/<ScrollView horizontal/g) ?? []).length, 1, 'one horizontal scroller per grid');
assert.ok(grid.indexOf('<ScrollView horizontal') > grid.indexOf('const grid ='), 'the scroller wraps the whole grid (header + pane)');
// The page itself stays a windowed list (a 500-page document still needs it),
// and it is NOT inside a PaneRoot.
const page = doc.slice(doc.indexOf('export function DocView'));
assert.match(page, /<GHFlatList[\s\S]*?data=\{blocks\}/);
assert.ok(!/<PaneRoot>/.test(page), 'only the pane is reset');

// ── The installed library behaves as the fix assumes ──────────────────
const VL = 'node_modules/@react-native/virtualized-lists';
assert.match(read(`${VL}/index.js`),
  /get VirtualizedListContextResetter\(\)[^{]*\{\s*const VirtualizedListContext = require\('\.\/Lists\/VirtualizedListContext'\);\s*return VirtualizedListContext\.VirtualizedListContextResetter;/,
  'the package still exports the resetter on its default object');
assert.match(read(`${VL}/Lists/VirtualizedListContext.js`),
  /export function VirtualizedListContextResetter\([\s\S]*?<VirtualizedListContext\.Provider value=\{null\}>/,
  'the resetter provides a null list context');
const list = read(`${VL}/Lists/VirtualizedList.js`);
assert.match(list,
  /_isNestedWithSameOrientation\(\): boolean \{\s*const nestedContext = this\.context;\s*return !!\(\s*nestedContext &&/,
  'nesting is decided from the list context alone, so a null context makes the pane a root list');
assert.match(list, /_convertParentScrollMetrics/, 'nested lists still take the parent\'s scroll metrics (why the reset is needed)');
assert.match(list, /<ScrollView\.Context\.Consumer>[\s\S]{0,400}this\.context == null/,
  'the dev nesting warning reads ScrollView.Context, which PaneRoot nulls');
const modal = read('node_modules/react-native/Libraries/Modal/Modal.js');
assert.match(modal, /<VirtualizedListContextResetter>\s*<ScrollView\.Context\.Provider value=\{null\}>/,
  'PaneRoot copies RN Modal\'s own reset');

// One copy: the context the resetter clears must be the one RN's FlatList reads.
const fromApp = createRequire(path.join(ROOT, 'package.json'));
const rnDir = path.dirname(fromApp.resolve('react-native/package.json'));
const fromRN = createRequire(path.join(rnDir, 'package.json'));
assert.equal(
  realpathSync(fromApp.resolve('@react-native/virtualized-lists/package.json')),
  realpathSync(fromRN.resolve('@react-native/virtualized-lists/package.json')),
  'the app and react-native resolve the same @react-native/virtualized-lists',
);

console.log('sheetPaneNesting selftest: ok');
