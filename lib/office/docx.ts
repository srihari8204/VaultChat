/**
 * Word (.docx) parsing — on-device, no upload.
 *
 * Reads word/document.xml out of the package and turns the body into an ordered
 * list of blocks (headings, paragraphs, list items, tables) that the renderer
 * can lay out natively.
 */
import type { DocBlock, DocRun, DocumentData } from './types';
import { OfficeParseError } from './types';
import { asArray, openZip, parseXml, readEntry } from './ooxml';

/** Pull the text of a single run, honouring tabs and explicit breaks. */
function runText(r: any): string {
  let out = '';
  for (const [key, value] of Object.entries(r)) {
    if (key === 'w:t') {
      for (const t of asArray<any>(value)) {
        out += typeof t === 'string' ? t : (t?.['#text'] ?? '');
      }
    } else if (key === 'w:tab') {
      out += '\t';
    } else if (key === 'w:br' || key === 'w:cr') {
      out += '\n';
    }
  }
  return out;
}

function runsOf(p: any): DocRun[] {
  const runs: DocRun[] = [];
  for (const r of asArray<any>(p?.['w:r'])) {
    const text = runText(r);
    if (!text) continue;
    const props = r['w:rPr'] ?? {};
    runs.push({
      text,
      bold: 'w:b' in props || undefined,
      italic: 'w:i' in props || undefined,
      underline: 'w:u' in props || undefined,
    });
  }
  return runs;
}

/** Word encodes headings as style names like "Heading1"/"Title". */
function headingLevel(p: any): number | null {
  const style = p?.['w:pPr']?.['w:pStyle']?.['@w:val'];
  if (typeof style !== 'string') return null;
  const m = /^Heading(\d)$/i.exec(style);
  if (m) return Math.min(6, Number(m[1]));
  if (/^Title$/i.test(style)) return 1;
  if (/^Subtitle$/i.test(style)) return 2;
  return null;
}

function listLevel(p: any): number | null {
  const numPr = p?.['w:pPr']?.['w:numPr'];
  if (!numPr) return null;
  const lvl = numPr['w:ilvl']?.['@w:val'];
  return Number.isFinite(Number(lvl)) ? Number(lvl) : 0;
}

function tableRows(tbl: any): string[][] {
  const rows: string[][] = [];
  for (const tr of asArray<any>(tbl?.['w:tr'])) {
    const cells: string[] = [];
    for (const tc of asArray<any>(tr?.['w:tc'])) {
      const text = asArray<any>(tc?.['w:p'])
        .map((p) => runsOf(p).map((r) => r.text).join(''))
        .join(' ')
        .trim();
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * The body's children are order-sensitive (a table between two paragraphs must
 * stay between them), and fast-xml-parser groups siblings by tag name, so the
 * original order is recovered from the raw XML instead.
 */
function bodyOrder(xml: string): ('p' | 'tbl')[] {
  const order: ('p' | 'tbl')[] = [];
  const re = /<w:(p|tbl)[\s>]/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  // Track nesting so paragraphs inside table cells are not counted twice.
  const tokens = xml.match(/<\/?w:(p|tbl)[\s>\/]/g) ?? [];
  for (const tok of tokens) {
    const closing = tok.startsWith('</');
    const isTbl = /w:tbl/.test(tok);
    if (closing) {
      if (isTbl) depth = Math.max(0, depth - 1);
      continue;
    }
    if (isTbl) {
      if (depth === 0) order.push('tbl');
      depth++;
    } else if (depth === 0) {
      order.push('p');
    }
  }
  void re;
  void m;
  return order;
}

export function parseDocument(base64: string): DocumentData {
  const zip = openZip(base64);
  const xml = readEntry(zip, 'word/document.xml');
  if (!xml) throw new OfficeParseError('This document is missing its main body.');

  const doc = parseXml(xml);
  const body = doc?.['w:document']?.['w:body'];
  if (!body) throw new OfficeParseError('This document has no readable content.');

  const paragraphs = asArray<any>(body['w:p']);
  const tables = asArray<any>(body['w:tbl']);
  const order = bodyOrder(xml);

  const blocks: DocBlock[] = [];
  let pi = 0;
  let ti = 0;
  for (const kind of order) {
    if (kind === 'tbl') {
      const rows = tableRows(tables[ti++]);
      if (rows.length) blocks.push({ kind: 'table', rows });
      continue;
    }
    const p = paragraphs[pi++];
    if (!p) continue;
    const runs = runsOf(p);
    if (!runs.length) continue;

    const h = headingLevel(p);
    if (h != null) {
      blocks.push({ kind: 'heading', level: h, runs });
      continue;
    }
    const li = listLevel(p);
    if (li != null) {
      blocks.push({ kind: 'listItem', level: li, runs });
      continue;
    }
    blocks.push({ kind: 'paragraph', runs });
  }

  const wordCount = blocks.reduce((n, b) => {
    if (b.kind === 'table') return n + b.rows.flat().join(' ').split(/\s+/).filter(Boolean).length;
    return n + b.runs.map((r) => r.text).join('').split(/\s+/).filter(Boolean).length;
  }, 0);

  return { blocks, wordCount, approxPages: Math.max(1, Math.ceil(wordCount / 350)) };
}
