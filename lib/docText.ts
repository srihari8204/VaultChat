// lib/docText.ts — pull READABLE TEXT out of documents (Office + PDF).
//
// Scope, deliberately narrow: this exists so a user can READ a document that
// arrived in a chat. It is not a renderer. No layout, no fonts, no page count,
// no tables, no images, no styling — those cost a heavy native dependency and
// buy nothing for "what does this say?".
//
// docx / xlsx / pptx are ZIP containers of XML, and fflate (already shipped for
// the archive viewer) unzips them in pure JS. So the whole feature is: unzip,
// pick the right parts, strip tags. No new dependency, no native module.
//
// PDF is handled too, by the same principle: inflate its content streams (fflate
// again) and read the text operators. It works for generated documents, which is
// most of what arrives in a chat. It CANNOT do scanned pages (no text layer) or
// custom font encodings — those return empty, and the caller then offers the
// device's PDF app, which renders them properly.
//
// PURE (no react-native imports) so it is Node-testable — see docText.selftest.ts.

import { unzipSync, strFromU8, inflateSync, unzlibSync } from 'fflate';

/** Biggest document we will pull into memory to read. */
export const MAX_DOC_BYTES = 32 * 1024 * 1024;

export type DocKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'unsupported';

export function docKind(filename: string): DocKind {
  const e = filename.split('.').pop()?.toLowerCase() ?? '';
  if (e === 'docx') return 'docx';
  if (e === 'xlsx') return 'xlsx';
  if (e === 'pptx') return 'pptx';
  if (e === 'pdf') return 'pdf';
  return 'unsupported';   // .doc/.xls/.ppt are the old binary formats, not ZIPs
}

/** Decode the XML entities that survive tag stripping. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');   // LAST: else "&amp;lt;" would become "<"
}

/**
 * Text of every <tag>...</tag> in document order.
 * Office XML puts each text run in its own element, so this is the whole job.
 */
function textOf(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    out.push(decodeEntities(m[1].replace(/<[^>]*>/g, '')));
  }
  return out;
}

/** Word: paragraphs are <w:p>, text runs inside them are <w:t>. */
export function docxText(xml: string): string {
  const paras = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  return paras
    .map(p => {
      // <w:br/> and <w:tab/> carry real whitespace that tag-stripping would eat.
      // They must be rewritten INTO <w:t> runs, not just swapped for the
      // character: only <w:t> content is collected below, so a bare "\n" sitting
      // between runs was dropped and lines ran together ("Secondafter break").
      const withBreaks = p
        .replace(/<w:br\s*\/?>/g, '<w:t>\n</w:t>')
        .replace(/<w:tab\s*\/?>/g, '<w:t>\t</w:t>');
      return textOf(withBreaks, 'w:t').join('');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')   // collapse the runs of empty formatting paragraphs
    .trim();
}

/** PowerPoint: every text run on a slide is <a:t>. One slide per block. */
export function pptxSlideText(xml: string): string {
  return textOf(xml, 'a:t').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Excel: cells live in <c>, either as an index into the shared-string table
 * (t="s") or as an inline value in <v>. Rows become tab-separated lines, which
 * is enough to read a sheet without reimplementing a grid.
 */
export function xlsxSheetText(sheetXml: string, shared: string[]): string {
  const rows = sheetXml.match(/<row(?:\s[^>]*)?>[\s\S]*?<\/row>/g) ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.match(/<c(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
    const vals: string[] = [];
    for (const c of cells) {
      const isShared = /\st="s"/.test(c);
      const inline = textOf(c, 'is');            // t="inlineStr"
      const v = textOf(c, 'v')[0] ?? '';
      if (isShared) {
        const idx = Number(v);
        vals.push(Number.isFinite(idx) ? (shared[idx] ?? '') : '');
      } else {
        vals.push(inline.length ? inline.join('') : v);
      }
    }
    if (vals.some(v => v !== '')) lines.push(vals.join('\t'));
  }
  return lines.join('\n').trim();
}

/** Sheet part names, in workbook order (sheet1, sheet2, … not lexical). */
export function orderedSheetPaths(paths: string[]): string[] {
  return paths
    .filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => (Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1])));
}

export function orderedSlidePaths(paths: string[]): string[] {
  return paths
    .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => (Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1])));
}

// ── PDF ───────────────────────────────────────────────────────────────────
//
// A PDF's text lives in content streams, usually Flate-compressed, as operands
// of the text operators Tj / TJ / ' / ". Pulling those out needs an inflate
// (fflate, already here) and a small operator scan — no native module.
//
// What this CANNOT do, by design: fonts with custom encodings (text comes out
// as mojibake), scanned pages (there is no text, only an image), and anything
// needing layout. Callers therefore treat an empty or junk result as "cannot
// read" and offer the device's PDF app, which handles all of that properly.

/** Decode a PDF literal string: escapes, octal, and line continuations. */
export function pdfLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n === '\n') { /* line continuation — emits nothing */ }
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n;   // \( \) \\ and anything else: the character itself
  }
  return out;
}

/**
 * Text from ONE decoded content stream.
 * Tj takes a single string; TJ takes an array of strings and kerning numbers —
 * a large negative kern is a word gap, so it becomes a space.
 */
export function pdfStreamText(content: string): string {
  let out = '';
  const re = /\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\)|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b|-?\d+(?:\.\d+)?/g;
  let pendingGap = false;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const t = m[0];
    if (t.startsWith('(')) {
      if (pendingGap) { out += ' '; pendingGap = false; }
      out += pdfLiteral(t.slice(1, -1));
    } else if (t === 'Td' || t === 'TD' || t === 'T*' || t === 'ET') {
      out += '\n';
      pendingGap = false;
    } else if (/^-?\d/.test(t)) {
      // Kerning inside a TJ array: a big negative shift is an inter-word space.
      if (Number(t) <= -100) pendingGap = true;
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract readable text from a whole PDF, or '' when there is none to get. */
export function pdfText(bytes: Uint8Array): string {
  // Latin1 keeps byte values intact, so stream offsets stay byte-accurate.
  let raw = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    raw += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as any);
  }

  const parts: string[] = [];
  const re = /stream\r?\n?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const header = raw.slice(Math.max(0, m.index - 400), m.index);
    const body = bytes.subarray(start, end);

    let text = '';
    if (/FlateDecode/.test(header)) {
      try { text = strFromU8(unzlibSync(body)); }
      catch {
        try { text = strFromU8(inflateSync(body)); } catch { continue; }
      }
    } else if (!/\/Filter/.test(header)) {
      text = raw.slice(start, end);          // uncompressed content stream
    } else {
      continue;                              // DCT/CCITT/etc — an image, not text
    }
    // Only content streams carry text operators; skip fonts, metadata, images.
    if (/\bTJ\b|\bTj\b/.test(text)) parts.push(pdfStreamText(text));
    re.lastIndex = end;
  }
  return parts.filter(Boolean).join('\n\n').trim();
}

export interface ExtractResult {
  text: string;
  /** Empty when the document genuinely has no text — worth telling the user. */
  empty: boolean;
}

/**
 * Extract readable text from the raw bytes of a docx/xlsx/pptx.
 * Throws with a plain message the UI can show directly.
 */
export function extractDocText(bytes: Uint8Array, filename: string): ExtractResult {
  if (bytes.byteLength > MAX_DOC_BYTES) {
    throw new Error('This document is too large to open here.');
  }
  const kind = docKind(filename);
  if (kind === 'unsupported') {
    throw new Error('Only .docx, .xlsx, .pptx and .pdf can be read in the app.');
  }

  // PDF is not a ZIP — handled before the unzip below.
  if (kind === 'pdf') {
    const t = pdfText(bytes);
    // A scanned page or a custom-encoded font yields nothing usable. Say so, so
    // the caller offers the device's PDF app instead of showing an empty screen.
    return { text: t, empty: t.trim().length === 0 };
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    // Every one of these formats is a ZIP; if it will not unzip it is not one.
    throw new Error('This file is not a readable document.');
  }

  const get = (p: string) => (files[p] ? strFromU8(files[p]) : '');
  let text = '';

  if (kind === 'docx') {
    text = docxText(get('word/document.xml'));
  } else if (kind === 'pptx') {
    const slides = orderedSlidePaths(Object.keys(files));
    text = slides
      .map((p, i) => {
        const body = pptxSlideText(strFromU8(files[p]));
        return body ? `— Slide ${i + 1} —\n${body}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  } else {
    const sharedXml = get('xl/sharedStrings.xml');
    // Shared strings are <si> entries, each holding one or more <t> runs.
    const shared = (sharedXml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) ?? [])
      .map(si => textOf(si, 't').join(''));
    const sheets = orderedSheetPaths(Object.keys(files));
    text = sheets
      .map((p, i) => {
        const body = xlsxSheetText(strFromU8(files[p]), shared);
        return body ? `— Sheet ${i + 1} —\n${body}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  return { text, empty: text.trim().length === 0 };
}

export default {};
