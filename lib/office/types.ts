/**
 * Shared shapes for the on-device Office parsers.
 *
 * Everything here is plain data: the parsers never touch React Native APIs, so
 * they can be unit-tested in Node and reused by any renderer.
 */

/* ---------------- Excel ---------------- */

export type CellValue = string | number | boolean | null;

export interface SheetData {
  name: string;
  /** True when the sheet is marked hidden/veryHidden in the workbook. */
  hidden: boolean;
  /** Row-major grid, already padded to a rectangle. */
  rows: CellValue[][];
  /** Formulas keyed by A1 reference, e.g. { D14: 'SUM(D2:D13)' }. */
  formulas: Record<string, string>;
  /** 0-based index of the last frozen row / column, or 0 for none. */
  frozenRows: number;
  frozenCols: number;
  colCount: number;
  rowCount: number;
}

export interface WorkbookData {
  sheets: SheetData[];
  /** Names of sheets flagged hidden, for the "N hidden" affordance. */
  hiddenSheetNames: string[];
}

/* ---------------- Word ---------------- */

export type DocRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };

export type DocBlock =
  | { kind: 'heading'; level: number; runs: DocRun[] }
  | { kind: 'paragraph'; runs: DocRun[] }
  | { kind: 'listItem'; level: number; runs: DocRun[] }
  | { kind: 'table'; rows: string[][] };

export interface DocumentData {
  blocks: DocBlock[];
  /** Rough page estimate so the reader can show "x of y". */
  approxPages: number;
  wordCount: number;
}

/* ---------------- PowerPoint ---------------- */

export interface SlideData {
  index: number;
  /** First title-ish text frame on the slide, when one exists. */
  title: string | null;
  /** Remaining text frames, in document order. */
  body: string[];
  notes: string | null;
  hasMedia: boolean;
}

export interface DeckData {
  slides: SlideData[];
}

/* ---------------- Errors ---------------- */

export class OfficeParseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'OfficeParseError';
  }
}
