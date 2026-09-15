// utils/financeIO.ts — export/share helpers for the Vault Finance hub.
//
// PDF via expo-print, Excel/CSV via a lightweight SpreadsheetML writer (opens in
// Excel/Sheets without a native dependency), sharing via expo-sharing. All local.

import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { formatINR } from './interest';

// ── PDF ─────────────────────────────────────────────────────────────
/** Render an HTML string to a PDF and open the share sheet. Returns the file uri. */
export async function sharePdf(html: string, _name = 'vault-finance'): Promise<string | null> {
  const { uri } = await Print.printToFileAsync({ html });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share PDF' });
  }
  return uri;
}

/** Minimal PDF-friendly HTML document with the Vault Finance look. */
export function pdfDocument(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#171320;padding:28px}
    h1{font-size:22px;margin:0 0 4px;color:#6D3FA8}
    .sub{color:#6B6478;font-size:12px;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    th{text-align:left;background:#F4F0FA;color:#6B6478;padding:8px 10px;border-bottom:1px solid #E7E2EE;text-transform:uppercase;font-size:10px;letter-spacing:.06em}
    td{padding:8px 10px;border-bottom:1px solid #EFEAF5}
    .k{color:#6B6478} .v{font-weight:700;text-align:right}
    .tot{font-weight:800;color:#171320}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#EFE7FA;color:#6D3FA8;font-size:11px;font-weight:700}
  </style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">crazzychat · Vault Finance · generated ${new Date().toLocaleString('en-IN')}</div>
  ${bodyHtml}
  </body></html>`;
}

export function kvTable(rows: { k: string; v: string; tot?: boolean }[]): string {
  return `<table>${rows.map(r => `<tr><td class="k">${escapeHtml(r.k)}</td><td class="v ${r.tot ? 'tot' : ''}">${escapeHtml(r.v)}</td></tr>`).join('')}</table>`;
}

export function htmlTable(headers: string[], rows: (string | number)[][]): string {
  const head = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('');
  return `<table>${head}${body}</table>`;
}

// ── Spreadsheet (Excel / CSV) ───────────────────────────────────────
/** Escape a value for CSV (quote if it contains a comma/quote/newline). */
function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
}

/** SpreadsheetML 2003 (.xls) — opens natively in Excel & Google Sheets, no lib. */
export function toExcelXml(sheetName: string, headers: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const num = typeof v === 'number' && Number.isFinite(v);
    return `<Cell><Data ss:Type="${num ? 'Number' : 'String'}">${escapeHtml(String(v))}</Data></Cell>`;
  };
  const row = (cells: (string | number)[]) => `<Row>${cells.map(cell).join('')}</Row>`;
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${escapeHtml(sheetName)}"><Table>
${row(headers)}
${rows.map(row).join('\n')}
</Table></Worksheet></Workbook>`;
}

/** Write a text file to cache and open the share sheet. */
export async function shareTextFile(filename: string, content: string, mime: string): Promise<string | null> {
  const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
  const uri = `${dir}${filename}`;
  await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: `Share ${filename}` });
  }
  return uri;
}

export function exportCsv(name: string, headers: string[], rows: (string | number)[][]) {
  return shareTextFile(`${name}.csv`, toCsv(headers, rows), 'text/csv');
}
export function exportExcel(name: string, headers: string[], rows: (string | number)[][]) {
  return shareTextFile(`${name}.xls`, toExcelXml(name, headers, rows), 'application/vnd.ms-excel');
}

export { formatINR };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
