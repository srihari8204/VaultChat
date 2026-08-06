/**
 * Excel (.xlsx / .xls) parsing — entirely on-device.
 *
 * The file is decoded from base64 in memory and never leaves the vault, which is
 * the whole point: the previous implementation handed the URL to Google's
 * document viewer, which cannot read local or encrypted files and would have
 * meant shipping vault contents to a third party.
 */
import * as XLSX from 'xlsx';
import type { CellValue, SheetData, WorkbookData } from './types';
import { OfficeParseError } from './types';

/** Excel serial date -> ISO-ish display string. */
function excelDateToString(serial: number): string {
  // Excel's epoch is 1899-12-30 (accounting for its 1900 leap-year bug).
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  return d.toISOString().slice(0, 10);
}

function normalizeCell(cell: XLSX.CellObject | undefined): CellValue {
  if (!cell) return null;
  if (cell.t === 'z') return null;
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  if (cell.t === 'n' && typeof cell.v === 'number') {
    // Dates come through as numbers with a date format mask.
    if (cell.z && typeof cell.z === 'string' && /[dmy]/i.test(cell.z) && !/[#0]/.test(cell.z)) {
      return excelDateToString(cell.v);
    }
    return cell.v;
  }
  if (cell.t === 'b') return Boolean(cell.v);
  if (cell.v == null) return null;
  return String(cell.v);
}

/** Parse the frozen-pane setting a sheet carries, if any. */
function readFrozen(ws: XLSX.WorkSheet): { rows: number; cols: number } {
  const pane = (ws as any)['!freeze'] ?? (ws as any)['!panes'];
  // SheetJS exposes freezes inconsistently across writers; fall back to the
  // top-left cell reference form ("B2" means one frozen row and column).
  const ref = typeof pane === 'string' ? pane : pane?.topLeftCell ?? pane?.xSplit ?? null;
  if (typeof ref === 'string' && /^[A-Z]+\d+$/.test(ref)) {
    const decoded = XLSX.utils.decode_cell(ref);
    return { rows: decoded.r, cols: decoded.c };
  }
  return { rows: 0, cols: 0 };
}

export function parseWorkbook(base64: string): WorkbookData {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(base64, { type: 'base64', cellDates: false, cellFormula: true, cellNF: true });
  } catch (e) {
    throw new OfficeParseError('This spreadsheet could not be read.', e);
  }

  const hiddenSheetNames: string[] = [];
  const sheets: SheetData[] = wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const meta = wb.Workbook?.Sheets?.[i];
    // 0 = visible, 1 = hidden, 2 = very hidden
    const hidden = Boolean(meta?.Hidden);
    if (hidden) hiddenSheetNames.push(name);

    const ref = ws?.['!ref'];
    if (!ws || !ref) {
      return { name, hidden, rows: [], formulas: {}, frozenRows: 0, frozenCols: 0, colCount: 0, rowCount: 0 };
    }

    const range = XLSX.utils.decode_range(ref);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;

    const rows: CellValue[][] = [];
    const formulas: Record<string, string> = {};

    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: CellValue[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr] as XLSX.CellObject | undefined;
        if (cell?.f) formulas[addr] = String(cell.f);
        row.push(normalizeCell(cell));
      }
      rows.push(row);
    }

    const frozen = readFrozen(ws);
    return {
      name,
      hidden,
      rows,
      formulas,
      frozenRows: frozen.rows,
      frozenCols: frozen.cols,
      colCount,
      rowCount,
    };
  });

  if (!sheets.length) throw new OfficeParseError('This workbook has no sheets.');
  return { sheets, hiddenSheetNames };
}

/** Spreadsheet-style column label: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLabel(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** A1-style reference for a zero-based row/column pair. */
export function cellRef(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

/** Display helper: right-align numbers, keep text as-is. */
export function formatCell(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

export function isNumeric(v: CellValue): boolean {
  return typeof v === 'number';
}
