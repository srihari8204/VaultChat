// lib/reader.ts — Chat Reader: the pure logic behind "this message is easier
// as a page" (design: docs/design/mobile/m18-reader-detect, m19-reader).
//
// A long message in a bubble is hostile to read: 66%-width, no paragraph
// rhythm, and it pushes the rest of the conversation off screen. The Reader
// re-renders that same text as a page with real typography.
//
// PURE — no react-native imports — so it is Node-tested (reader.selftest.ts),
// the same model as services/crypto/e2ee.ts and lib/vaultBeam/manager.ts.
// Persistence lives in lib/readerSettings.ts, the screen in app/reader.tsx.

/** Words per minute for the "N min read" estimate. 200 is the usual figure for
 *  adult silent reading of non-technical prose; it is a rounded-up estimate,
 *  never a promise. */
export const WPM = 200;

/** Below this a message reads fine as a bubble and the Reader is not offered.
 *  ~1,400 words is the design's example of a long read; 220 is roughly a
 *  minute, the point where a bubble starts to lose the reader. */
export const MIN_READER_WORDS = 220;

/** Words per page in paged layout. Chosen so a page fills a phone screen at the
 *  default text size without the last line being orphaned. */
export const WORDS_PER_PAGE = 260;

export interface ReadStats {
  words: number;
  minutes: number;
  pages: number;
  /** True when the message is long enough that the Reader is worth offering. */
  longRead: boolean;
}

const WORD_RE = /[^\s]+/g;

/** Word count of the message body. Deliberately counts any run of non-space as
 *  one word, so CJK text (no spaces) under-counts rather than over-counts — a
 *  wrong "45 min read" is worse than not offering the Reader at all. */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return (text.match(WORD_RE) ?? []).length;
}

export function readStats(text: string | null | undefined): ReadStats {
  const words = countWords(text);
  return {
    words,
    minutes: words === 0 ? 0 : Math.max(1, Math.round(words / WPM)),
    pages: words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_PAGE)),
    longRead: words >= MIN_READER_WORDS,
  };
}

/** "6 min read · 3 pages · 1,412 words" — the design's subtitle. */
export function formatStats(s: ReadStats): string {
  return `${s.minutes} min read · ${s.pages} page${s.pages === 1 ? '' : 's'} · ${s.words.toLocaleString()} words`;
}

// ── Structure ──────────────────────────────────────────────────────────
//
// Chat prose is plain text, so the only structure available is blank lines and
// the shape of a line. Headings are inferred conservatively: a SHORT line with
// no terminal punctuation, followed by a blank line. Getting this wrong turns a
// normal sentence into a headline, so the bar is deliberately high.

export type BlockKind = 'heading' | 'bullet' | 'quote' | 'paragraph';
export interface Block { kind: BlockKind; text: string }

const MAX_HEADING_WORDS = 9;

function isHeading(line: string, next: string | undefined): boolean {
  const t = line.trim();
  if (!t || t.length > 72) return false;
  if (countWords(t) > MAX_HEADING_WORDS) return false;
  if (/[.!?,;:]$/.test(t)) return false;         // a sentence, not a heading
  if (next !== undefined && next.trim() !== '') return false;  // must be followed by a break
  return true;
}

/** Split plain chat text into renderable blocks. Never throws, never drops
 *  content: every non-empty line lands in exactly one block. */
export function toBlocks(text: string | null | undefined): Block[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) { out.push({ kind: 'paragraph', text: para.join(' ').trim() }); para = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { flush(); continue; }

    const bullet = t.match(/^[-*•]\s+(.*)$/);
    if (bullet) { flush(); out.push({ kind: 'bullet', text: bullet[1].trim() }); continue; }

    const quote = t.match(/^>\s?(.*)$/);
    if (quote) { flush(); out.push({ kind: 'quote', text: quote[1].trim() }); continue; }

    if (isHeading(t, lines[i + 1])) { flush(); out.push({ kind: 'heading', text: t }); continue; }

    para.push(t);
  }
  flush();
  return out;
}

/** Group blocks into pages for the paged layout, keeping a heading with the
 *  block that follows it — a heading alone at the foot of a page is the one
 *  pagination artifact readers actually notice. */
export function paginate(blocks: Block[], wordsPerPage = WORDS_PER_PAGE): Block[][] {
  if (!blocks.length) return [];
  const pages: Block[][] = [];
  let page: Block[] = [];
  let count = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const w = countWords(b.text);

    // A heading is glued to the block it introduces: measure the pair, so a
    // heading that cannot keep its body on this page moves to the next one
    // WITH it, rather than being stranded alone at the foot of a page.
    const next = blocks[i + 1];
    const fitWeight = b.kind === 'heading' && next ? w + countWords(next.text) : w;

    if (count > 0 && count + fitWeight > wordsPerPage) {
      pages.push(page); page = []; count = 0;
    }
    page.push(b);
    count += w;
  }
  if (page.length) pages.push(page);
  return pages;
}

export default {};
