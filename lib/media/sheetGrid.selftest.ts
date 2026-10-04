// lib/media/sheetGrid.selftest.ts — run: npx tsx lib/media/sheetGrid.selftest.ts
//
// DocView virtualises a big sheet's rows inside ONE horizontal scroller. That
// only lines up if every row uses the same fixed column widths, measured from
// the whole sheet (not the rows on screen), and the pane is bounded so the page
// around it still scrolls.

import assert from 'node:assert/strict';
import { columnWidth } from '../docs/zoom';
import {
  VIRTUAL_MIN_ROWS, columnWidths, gridCols, gridPlan, longestCells, rowPaneHeight, sumWidths,
} from './sheetGrid';

// Column count: the widest (ragged) row.
assert.equal(gridCols([]), 0);
assert.equal(gridCols([['a'], ['a', 'b', 'c'], ['a', 'b']]), 3);

// Longest cell per column, over EVERY row — the widest cell sits far below any
// sample the old renderer measured (it read only the first 500 rows).
const rows: string[][] = Array.from({ length: 2000 }, (_, i) => [String(i), 'x']);
rows[1999] = ['1999', 'a much longer note at the bottom'];
const longest = longestCells(rows, 3);
assert.deepEqual(longest, [4, 'a much longer note at the bottom'.length, 0]);

// Pixel widths come from lib/docs/zoom and scale with the zoom; the sum is the grid width.
const w1 = columnWidths(longest, 1);
assert.deepEqual(w1, longest.map(l => columnWidth(l, 1)));
assert.equal(w1[2], 64, 'an empty column keeps the minimum width');
const w2 = columnWidths(longest, 2);
assert.ok(w2.every((w, i) => w >= w1[i]), 'zooming in never narrows a column');
assert.equal(sumWidths(w1), w1[0] + w1[1] + w1[2]);
assert.equal(sumWidths([]), 0);

// Plan: small grids flow into the page, big ones get the pane with the header pinned above it.
assert.deepEqual(gridPlan(VIRTUAL_MIN_ROWS, true, 300, 400), { virtual: false, pinned: 0, wide: false });
assert.deepEqual(gridPlan(VIRTUAL_MIN_ROWS + 1, true, 300, 400), { virtual: true, pinned: 1, wide: false });
assert.deepEqual(gridPlan(50_000, false, 900, 400), { virtual: true, pinned: 0, wide: true });
assert.equal(gridPlan(10, true, 400, 400).wide, false, 'exactly fitting needs no horizontal scroller');

// Pane height: 60% of the window, never below 240 so a landscape phone still shows rows.
assert.equal(rowPaneHeight(800), 480);
assert.equal(rowPaneHeight(300), 240);
assert.ok(rowPaneHeight(800) < 800, 'the pane never fills the window: the page must stay scrollable around it');

console.log('sheetGrid selftest: ok');
