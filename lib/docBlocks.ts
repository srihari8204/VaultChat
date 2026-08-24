// lib/docBlocks.ts — read a document as STRUCTURE, not as one flat string.
//
// lib/docText.ts answers "what does this say?" and returns a paragraph blob. That
// is the right answer for search and for a preview line, and the wrong one for
// actually reading a document: a spreadsheet arrives as tab-separated soup, a
// report loses every heading, and a deck's slides run together.
//
// This module answers "how is it laid out?" — headings, bold/italic runs, lists,
// tables, sheets, slides, PDF pages — so the viewer can render a spreadsheet as a
// grid and a report as a report. It reuses the same fflate unzip and the same
// tag-stripping; the extra cost is a few regexes, not a dependency.
//
// PURE (no react-native import) so the whole thing is Node-testable — see
// docBlocks.selftest.ts. The renderer lives in components/DocView.tsx.

import { unzipSync, strFromU8 } from 'fflate';
import {
  decodeEntities, docKind, orderedSheetPaths, orderedSlidePaths,
  pdfPageStreams, MAX_DOC_BYTES,
} from './docText';

// ─── Model ───────────────────────────────────────────────────────────

/** A span of text carrying the emphasis Word recorded for it. */
export interface Run { text: string; b?: boolean; i?: boolean }

export type Block =
  /** A heading. `level` is clamped to 1..3 — deeper ones read as body text anyway. */
  | { t: 'h'; level: 1 | 2 | 3; runs: Run[] }
  | { t: 'p'; runs: Run[] }
  /** A list item. `level` is the indent depth (0-based). */
  | { t: 'li'; ordered: boolean; level: number; runs: Run[] }
  /** A Word table. First row is treated as the header when it looks like one. */
  | { t: 'table'; rows: string[][] }
  /** One worksheet, as a real grid. */
  | { t: 'sheet'; name: string; rows: string[][] }
  /** One slide: its title (may be '') and the rest of its text. */
  | { t: 'slide'; n: number; title: string; lines: string[] }
  /** A PDF page boundary. Emitted before that page's paragraphs. */
  | { t: 'page'; n: number };

export interface BlocksResult {
  blocks: Block[];
  /** True when the document parsed but carries nothing readable. */
  empty: boolean;
}

// ─── Word ────────────────────────────────────────────────────────────

/** Word writes emphasis in <w:rPr>. Read it per run so bold survives. */
function docxRuns(paraXml: string): Run[] {
  const runs: Run[] = [];
  // A break can sit INSIDE a run or BETWEEN two of them, and Word emits both.
  // Matching only runs drops the between-runs case and joins the lines
  // ("Line ALine B"), so the alternation picks up bare breaks as well.
  const re = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>|<w:br\s*\/?>|<w:tab\s*\/?>/g;
  for (let m = re.exec(paraXml); m; m = re.exec(paraXml)) {
    if (m[1] === undefined) {                       // a bare <w:br/> or <w:tab/>
      const ws = m[0].startsWith('<w:tab') ? '\t' : '\n';
      if (runs.length) runs[runs.length - 1].text += ws;
      else runs.push({ text: ws });
      continue;
    }
    const body = m[1];
    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? '';
    // <w:b/> sets bold; <w:b w:val="0"/> explicitly clears it, and a theme can
    // do exactly that, so the val must be checked rather than the tag's presence.
    const on = (tag: string) => {
      const t = new RegExp(`<w:${tag}(?:\\s+w:val="([^"]*)")?\\s*/?>`).exec(props);
      return !!t && t[1] !== '0' && t[1] !== 'false';
    };
    let text = '';
    // <w:br/> and <w:tab/> carry whitespace that tag-stripping would swallow.
    const withWs = body.replace(/<w:br\s*\/?>/g, '\n').replace(/<w:tab\s*\/?>/g, '\t');
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|\n|\t/g;
    for (let tm = tre.exec(withWs); tm; tm = tre.exec(withWs)) {
      text += tm[1] !== undefined ? decodeEntities(tm[1].replace(/<[^>]*>/g, '')) : tm[0];
    }
    if (text) runs.push({ text, ...(on('b') ? { b: true } : {}), ...(on('i') ? { i: true } : {}) });
  }
  return runs;
}

function cellText(tcXml: string): string {
  return docxRuns(tcXml).map(r => r.text).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Word body → blocks, in document order.
 *
 * Paragraphs and tables are matched by ONE alternation rather than separately:
 * running two passes and concatenating would put every table after every
 * paragraph, which silently reorders the document.
 */
export function docxBlocks(xml: string): Block[] {
  const out: Block[] = [];
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const chunk = m[0];

    if (chunk.startsWith('<w:tbl')) {
      const rows: string[][] = [];
      const rre = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
      for (let rm = rre.exec(chunk); rm; rm = rre.exec(chunk)) {
        const cells: string[] = [];
        const cre = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
        for (let cm = cre.exec(rm[0]); cm; cm = cre.exec(rm[0])) cells.push(cellText(cm[0]));
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length) out.push({ t: 'table', rows });
      continue;
    }

    const runs = docxRuns(chunk);
    if (!runs.length || !runs.some(r => r.text.trim())) continue;

    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(chunk)?.[1] ?? '';
    const heading = /^Heading(\d)$/i.exec(style);
    if (heading) {
      out.push({ t: 'h', level: Math.min(3, Math.max(1, Number(heading[1]))) as 1 | 2 | 3, runs });
      continue;
    }
    if (/^Title$/i.test(style)) { out.push({ t: 'h', level: 1, runs }); continue; }
    if (/^Subtitle$/i.test(style)) { out.push({ t: 'h', level: 2, runs }); continue; }

    // <w:numPr> means the paragraph is in a list. numId tells us WHICH list, and
    // ilvl the indent depth. Distinguishing bulleted from numbered properly means
    // resolving numbering.xml; ordered-ness is inferred instead, which is wrong
    // only in the cosmetic direction.
    const num = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(chunk);
    if (num) {
      const level = Number(/<w:ilvl\s+w:val="(\d+)"/.exec(num[1])?.[1] ?? '0') || 0;
      // Always rendered as a bullet. Telling a numbered list from a bulleted one
      // means resolving numId through numbering.xml → abstractNumId → the level's
      // numFmt, which is three indirections for a glyph. A bullet where a "1."
      // belonged is a cosmetic miss; the indent and the item boundaries, which
      // are what make a list readable, are both correct.
      // ponytail: resolve numbering.xml if ordered lists ever actually matter.
      out.push({ t: 'li', ordered: false, level, runs });
      continue;
    }

    out.push({ t: 'p', runs });
  }
  return out;
}

// ─── Excel ───────────────────────────────────────────────────────────

/** Sheet display names, in workbook order. Falls back to "Sheet N". */
export function sheetNames(workbookXml: string): string[] {
  const out: string[] = [];
  const re = /<sheet\b[^>]*\bname="([^"]*)"/g;
  for (let m = re.exec(workbookXml); m; m = re.exec(workbookXml)) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * One worksheet as a rectangular grid.
 *
 * Cells carry their column letter in `r` ("C7"). Without honouring it, a row that
 * skips a column shifts everything after it one place to the left and silently
 * puts values under the wrong headings — the failure a spreadsheet reader must
 * not have.
 */
export function xlsxRows(sheetXml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/row>)/g;
  for (let rm = rowRe.exec(sheetXml); rm; rm = rowRe.exec(sheetXml)) {
    const cells: string[] = [];
    const cRe = /<c(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/c>)/g;
    for (let cm = cRe.exec(rm[0]); cm; cm = cRe.exec(rm[0])) {
      const c = cm[0];
      const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1];
      if (ref) {
        let col = 0;
        for (let i = 0; i < ref.length; i++) col = col * 26 + (ref.charCodeAt(i) - 64);
        while (cells.length < col - 1) cells.push('');
      }
      const inline = /<is>([\s\S]*?)<\/is>/.exec(c)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1] ?? '';
      if (/\st="s"/.test(c)) {
        const i = Number(v);
        cells.push(Number.isFinite(i) ? (shared[i] ?? '') : '');
      } else if (inline !== undefined) {
        cells.push(decodeEntities(inline.replace(/<[^>]*>/g, '')));
      } else {
        cells.push(decodeEntities(v.replace(/<[^>]*>/g, '')));
      }
    }
    if (cells.some(x => x !== '')) rows.push(cells);
  }
  // Pad to the widest row so the renderer can draw a real rectangle.
  const w = rows.reduce((n, r) => Math.max(n, r.length), 0);
  for (const r of rows) while (r.length < w) r.push('');
  return rows;
}

// ─── PowerPoint ──────────────────────────────────────────────────────

/** A slide's title (from its title placeholder) and its remaining text. */
export function pptxSlide(xml: string, n: number): Block {
  const shapes: Array<{ title: boolean; lines: string[] }> = [];
  const re = /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const sp = m[0];
    const isTitle = /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(sp);
    const lines: string[] = [];
    const pre = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g;
    for (let pm = pre.exec(sp); pm; pm = pre.exec(sp)) {
      const tre = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let line = '';
      for (let tm = tre.exec(pm[0]); tm; tm = tre.exec(pm[0])) {
        line += decodeEntities(tm[1].replace(/<[^>]*>/g, ''));
      }
      if (line.trim()) lines.push(line.trim());
    }
    if (lines.length) shapes.push({ title: isTitle, lines });
  }
  const titleShape = shapes.find(s => s.title);
  const title = titleShape?.lines.join(' ') ?? '';
  const lines = shapes.filter(s => s !== titleShape).flatMap(s => s.lines);
  return { t: 'slide', n, title, lines };
}

// ─── PDF ─────────────────────────────────────────────────────────────

/**
 * One page's text as sized lines.
 *
 * `Tf` carries the font size in force, so a line set noticeably larger than the
 * page's usual size is a heading. That is the only structure a PDF's content
 * stream actually offers — there are no paragraph or heading markers in it — and
 * it is enough to stop an invoice rendering as one grey wall.
 */
export function pdfPageLines(content: string): Array<{ text: string; size: number }> {
  const lines: Array<{ text: string; size: number }> = [];
  let cur = '';
  let size = 0, curSize = 0, gap = false;

  const re = /\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\)|\/\w+\s+(-?[\d.]+)\s+Tf|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|-?\d+(?:\.\d+)?/g;
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) lines.push({ text: t, size: curSize || size });
    cur = ''; gap = false;
  };
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const tok = m[0];
    if (m[1] !== undefined) { size = Math.abs(Number(m[1])) || size; continue; }
    if (tok.startsWith('(')) {
      if (gap) { cur += ' '; gap = false; }
      if (!cur) curSize = size;
      cur += pdfLiteralLocal(tok.slice(1, -1));
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
      flush();
    } else if (/^-?\d/.test(tok)) {
      if (Number(tok) <= -100) gap = true;
    }
  }
  flush();
  return lines;
}

/** Local copy of docText's literal decoder — kept private to avoid widening its API. */
function pdfLiteralLocal(raw: string): string {
  return raw.replace(/\\(\d{1,3}|.)/g, (_m, c: string) => {
    if (/^\d+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    return c;
  });
}

/** Group a page's sized lines into heading/paragraph blocks. */
export function pdfBlocksFromLines(lines: Array<{ text: string; size: number }>): Block[] {
  if (!lines.length) return [];
  const sizes = lines.map(l => l.size).filter(s => s > 0).sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', runs: [{ text: para.join(' ') }] });
    para = [];
  };
  for (const l of lines) {
    // A line set 25% larger than the page's usual size reads as a heading. Below
    // that the difference is leading or a footnote, not structure.
    if (body > 0 && l.size >= body * 1.25) {
      flush();
      out.push({ t: 'h', level: l.size >= body * 1.6 ? 1 : 2, runs: [{ text: l.text }] });
    } else {
      para.push(l.text);
      if (/[.!?:;]$/.test(l.text) || l.text.length < 40) flush();
    }
  }
  flush();
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Read a document as blocks. Throws the same plain, user-facing messages
 * extractDocText does, so the viewer's error handling is unchanged.
 */
export function extractDocBlocks(bytes: Uint8Array, filename: string): BlocksResult {
  if (bytes.byteLength > MAX_DOC_BYTES) throw new Error('This document is too large to open here.');
  const kind = docKind(filename);
  if (kind === 'unsupported') throw new Error('Only .docx, .xlsx, .pptx and .pdf can be read in the app.');

  if (kind === 'pdf') {
    const blocks: Block[] = [];
    const pages = pdfPageStreams(bytes);
    pages.forEach((content, i) => {
      const b = pdfBlocksFromLines(pdfPageLines(content));
      if (!b.length) return;
      blocks.push({ t: 'page', n: i + 1 });
      blocks.push(...b);
    });
    return { blocks, empty: blocks.length === 0 };
  }

  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); }
  catch { throw new Error('This file is not a readable document.'); }
  const get = (p: string) => (files[p] ? strFromU8(files[p]) : '');

  if (kind === 'docx') {
    const blocks = docxBlocks(get('word/document.xml'));
    return { blocks, empty: blocks.length === 0 };
  }

  if (kind === 'pptx') {
    const blocks = orderedSlidePaths(Object.keys(files))
      .map((p, i) => pptxSlide(strFromU8(files[p]), i + 1))
      .filter(b => b.t === 'slide' && (b.title || b.lines.length));
    return { blocks, empty: blocks.length === 0 };
  }

  // xlsx
  const sharedXml = get('xl/sharedStrings.xml');
  const shared = (sharedXml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) ?? []).map(si => {
    let s = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    for (let m = re.exec(si); m; m = re.exec(si)) s += decodeEntities(m[1].replace(/<[^>]*>/g, ''));
    return s;
  });
  const names = sheetNames(get('xl/workbook.xml'));
  const blocks = orderedSheetPaths(Object.keys(files))
    .map((p, i) => ({ t: 'sheet' as const, name: names[i] || `Sheet ${i + 1}`, rows: xlsxRows(strFromU8(files[p]), shared) }))
    .filter(s => s.rows.length);
  return { blocks, empty: blocks.length === 0 };
}

export default {};
