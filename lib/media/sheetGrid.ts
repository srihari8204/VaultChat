// lib/media/sheetGrid.ts — layout maths for DocView's spreadsheet / table grid.
//
// A worksheet arrives from lib/docBlocks.ts as ONE block, so the document's
// outer list cannot window its rows. Big sheets therefore get their own row
// pane: a bounded-height, virtualised list of rows inside the grid's single
// horizontal scroller (components/DocView.tsx). Everything here is pure so the
// sizing rules can be checked without a renderer (sheetGrid.selftest.ts).

import { columnWidth } from '../docs/zoom';

/**
 * Sheets with more rows than this get the virtualised row pane. Smaller ones
 * flow into the page exactly as before: a nested scroller is worse to use than
 * a few hundred plain rows, and those mount cheaply.
 */
export const VIRTUAL_MIN_ROWS = 200;

/** The row pane's share of the window height, and its floor on short screens. */
const PANE_SHARE = 0.6;
const PANE_MIN = 240;

/** The widest row decides the column count: ragged rows are padded with blank cells. */
export function gridCols(rows: string[][]): number {
  let n = 0;
  for (const r of rows) if (r.length > n) n = r.length;
  return n;
}

/**
 * The longest cell (in characters) in each column, over the WHOLE sheet.
 * Measured once per sheet, independent of zoom, so a pinch only re-runs
 * `columnWidths` — and never from the rows currently on screen, or the columns
 * would jump while scrolling.
 */
export function longestCells(rows: string[][], cols: number): number[] {
  const w: number[] = new Array(cols).fill(0);
  for (const r of rows) {
    for (let c = 0; c < cols; c++) {
      const len = (r[c] ?? '').length;
      if (len > w[c]) w[c] = len;
    }
  }
  return w;
}

/** Pixel width of each column at a zoom (content-sized and clamped: lib/docs/zoom). */
export function columnWidths(longest: number[], zoom: number): number[] {
  return longest.map(len => columnWidth(len, zoom));
}

export function sumWidths(widths: number[]): number {
  return widths.reduce((a, b) => a + b, 0);
}

/**
 * How a grid is laid out.
 * - `virtual`: rows live in the bounded, virtualised pane.
 * - `pinned`: rows drawn ABOVE the pane (the header), so they stay put while the
 *   body scrolls vertically and move with it horizontally (same scroller).
 * - `wide`: the grid does not fit the page and needs the horizontal scroller.
 *   Only then: wrapping every grid in one steals the vertical pan near the edges.
 */
export function gridPlan(rowCount: number, header: boolean, totalWidth: number, pageWidth: number) {
  const virtual = rowCount > VIRTUAL_MIN_ROWS;
  return { virtual, pinned: virtual && header ? 1 : 0, wide: totalWidth > pageWidth };
}

/** Height cap for the virtualised row pane, so the page around it stays scrollable. */
export function rowPaneHeight(windowHeight: number): number {
  return Math.max(PANE_MIN, Math.round(windowHeight * PANE_SHARE));
}
