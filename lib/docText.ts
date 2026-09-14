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

/**
 * Cap on the DECOMPRESSED size of a docx/xlsx/pptx.
 *
 * Bounding the input alone is not a bound. A 32 MB zip of repeated bytes
 * expands to many gigabytes, and unzipSync allocates all of it before anything
 * here gets a chance to look at it — the app is killed by the OS, which reads
 * to a user as "opening that file crashed VaultChat", not as a hostile file.
 * fflate's filter runs per entry BEFORE inflating it and sees the entry's
 * declared original size, so the running total is checked there and the whole
 * read is abandoned the moment it goes over.
 */
export const MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;

/** Thrown out of the unzip filter; callers turn it into the usual plain text. */
export const DOC_BOMB_MESSAGE = 'This document is too large to open here.';

/**
 * fflate `filter` that aborts once the declared uncompressed total exceeds
 * MAX_UNZIPPED_BYTES. One instance per unzip call — it is stateful.
 */
export function unzipBudget(): (f: { originalSize: number }) => boolean {
  let total = 0;
  return (f) => {
    total += f.originalSize || 0;
    if (total > MAX_UNZIPPED_BYTES) throw new Error(DOC_BOMB_MESSAGE);
    return true;
  };
}

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
/**
 * Excel column index (1-based) from a cell reference: A->1, B->2, AA->27.
 *
 * Shared with lib/docBlocks.ts rather than written twice. The flat reader below
 * used to ignore `r=` entirely and just push cells in encounter order — but
 * Excel OMITS an empty cell, so a sheet with a gap shifted every later column
 * one place left and a header stopped lining up with its own data. The
 * structured reader had it right; keeping the rule in ONE place is what stops
 * the two from disagreeing again.
 */
export function colIndexFromRef(ref: string): number {
  let col = 0;
  for (let i = 0; i < ref.length; i++) col = col * 26 + (ref.charCodeAt(i) - 64);
  return col;
}

export function xlsxSheetText(sheetXml: string, shared: string[]): string {
  const rows = sheetXml.match(/<row(?:\s[^>]*)?>[\s\S]*?<\/row>/g) ?? [];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.match(/<c(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
    const vals: string[] = [];
    for (const c of cells) {
      // Pad out any columns Excel left out, so the cell lands where it belongs.
      const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1];
      if (ref) { const col = colIndexFromRef(ref); while (vals.length < col - 1) vals.push(''); }
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
/**
 * ASCII85 (Adobe variant), as used in a PDF `/Filter` chain.
 *
 * Five printable characters encode four bytes, base 85 from '!'. 'z' is a
 * shorthand for four zero bytes, whitespace is ignored, and a trailing partial
 * group is padded with 'u' and yields one byte fewer than it holds characters.
 *
 * Returns null on anything malformed, so the caller can skip the stream rather
 * than surface a decode error for one bad object in an otherwise fine document.
 */
export function ascii85Decode(s: string): Uint8Array | null {
  let body = s.trim();
  if (body.startsWith('<~')) body = body.slice(2);
  const end = body.indexOf('~>');
  if (end >= 0) body = body.slice(0, end);

  const out: number[] = [];
  let group = 0, n = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 122 /* z */ && n === 0) { out.push(0, 0, 0, 0); continue; }
    if (c <= 32 || c === 127) continue;                  // whitespace
    if (c < 33 || c > 117) return null;                  // outside '!'..'u'
    group = group * 85 + (c - 33);
    if (++n === 5) {
      out.push((group >>> 24) & 0xff, (group >>> 16) & 0xff, (group >>> 8) & 0xff, group & 0xff);
      group = 0; n = 0;
    }
  }
  if (n === 1) return null;                              // a lone char cannot end a group
  if (n > 1) {
    for (let i = n; i < 5; i++) group = group * 85 + 84; // pad with 'u'
    const full = [(group >>> 24) & 0xff, (group >>> 16) & 0xff, (group >>> 8) & 0xff, group & 0xff];
    out.push(...full.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

/**
 * Is this harvested text real prose, or binary that merely parsed like text?
 *
 * Prose in ANY language -- Telugu, Hindi, emoji -- contains no C0/C1 control
 * characters beyond tab/newline; binary harvested by mistake is 60%+ of them.
 * Measured over 32 real PDFs the two populations do not overlap at all: every
 * genuine document scored 0%, every mis-parse 62-65%.
 */
function isReadableText(s: string): boolean {
  if (!s) return false;
  let ctl = 0;
  for (const ch of s) {
    const n = ch.codePointAt(0)!;
    if ((n < 32 && ch !== '\n' && ch !== '\t' && ch !== '\r') || (n >= 127 && n <= 159)) ctl++;
  }
  return ctl / s.length <= 0.05;
}

/**
 * Every decoded content stream that actually carries text operators, in file
 * order — roughly one per page.
 *
 * Split out of pdfText so a structured reader (lib/docBlocks.ts) can work per
 * page and per font size instead of on one concatenated blob, without owning a
 * second copy of the stream-decoding rules.
 */
export function pdfPageStreams(bytes: Uint8Array): string[] {
  // Latin1 keeps byte values intact, so stream offsets stay byte-accurate.
  let raw = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    raw += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as any);
  }

  const out: string[] = [];
  const re = /stream\r?\n?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const header = raw.slice(Math.max(0, m.index - 400), m.index);

    // A real stream is always preceded by its dictionary, so the bytes before
    // the keyword end in `>>`. Without this the scanner also matched the six
    // letters "stream" occurring BY CHANCE inside compressed binary; such a hit
    // carries no `/Filter` in its header, so it fell through to the
    // "uncompressed content stream" branch below and the raw compressed bytes
    // were then harvested as text. That is why real-world PDFs opened as pages
    // of mojibake -- 14 of 32 test documents, including every Hetzner invoice
    // and a 2.4 MB reference doc that yielded 2,473,052 characters of noise.
    if (!/>>\s*$/.test(header)) continue;

    const body = bytes.subarray(start, end);

    let text = '';
    // `/Filter` is a LIST, applied in order — `[ /ASCII85Decode /FlateDecode ]`
    // means "un-ascii85, then inflate". Testing only for FlateDecode and
    // inflating the raw bytes fails on every ReportLab PDF, which is most
    // server-generated invoices and statements.
    if (/FlateDecode/.test(header)) {
      let payload: Uint8Array | null = body;
      if (/ASCII85Decode/.test(header)) payload = ascii85Decode(raw.slice(start, end));
      if (!payload) continue;
      try { text = strFromU8(unzlibSync(payload)); }
      catch {
        try { text = strFromU8(inflateSync(payload)); } catch { continue; }
      }
    } else if (/ASCII85Decode/.test(header)) {
      const payload = ascii85Decode(raw.slice(start, end));
      if (!payload) continue;
      text = strFromU8(payload);
    } else if (!/\/Filter/.test(header)) {
      text = raw.slice(start, end);          // uncompressed content stream
    } else {
      continue;                              // DCT/CCITT/etc — an image, not text
    }
    // The two bytes "Tj" also appear by chance in binary, so carrying text
    // OPERATORS is not proof this is a content stream -- what it YIELDS has to
    // read as text. This also drops the CID-font streams whose glyph codes are
    // meaningless without a /ToUnicode map (5 of 32 documents): the viewer's
    // "no text layer" path then offers the device's PDF app, which beats
    // showing the user mojibake.
    if (/\bTJ\b|\bTj\b/.test(text) && isReadableText(pdfStreamText(text))) out.push(text);
    // Advance ONLY here, on the path that consumed the stream.
    //
    // Moving this above the `continue`s looks obviously right and measurably is
    // not: tried three ways against 40 real PDFs, every variant recovered some
    // documents (a bank statement went 0 → 26k chars) and lost others (five
    // invoices and a 336k-char report went to zero). Net was worse each time, so
    // the scanner keeps the behaviour that reads the most real documents.
    // ponytail: the principled fix is to frame streams by /Length from the dict
    // instead of searching for "endstream" — worth doing with a PDF corpus to
    // measure against, not by reasoning.
    re.lastIndex = end;
  }
  return out;
}

export function pdfText(bytes: Uint8Array): string {
  // One scanner, not two. This used to carry its own copy of the stream-decoding
  // loop; when pdfPageStreams was added for the structured reader the two drifted
  // within the hour — the copy kept a different lastIndex rule and silently
  // dropped page two of every two-page document while this one read it fine.
  return pdfPageStreams(bytes)
    .map(pdfStreamText)
    .filter(Boolean)
    .join('\n\n')
    .trim();
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
    files = unzipSync(bytes, { filter: unzipBudget() });
  } catch (e: any) {
    // Distinguish "this is not a zip" from "this zip is a bomb" — the second is
    // not a malformed file and must not be reported as one.
    if (e?.message === DOC_BOMB_MESSAGE) throw e;
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
