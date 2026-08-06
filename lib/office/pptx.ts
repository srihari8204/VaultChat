/**
 * PowerPoint (.pptx) parsing — on-device, no upload.
 *
 * Each slide is its own XML part. Text lives in shape text bodies (<a:t>), the
 * title is whichever shape carries a title placeholder, and speaker notes live
 * in a parallel notesSlide part.
 */
import type { DeckData, SlideData } from './types';
import { OfficeParseError } from './types';
import { asArray, collectText, listEntries, openZip, parseXml, readEntry } from './ooxml';

/** Join the <a:t> runs inside one text body into paragraph strings. */
function paragraphsOf(txBody: any): string[] {
  const out: string[] = [];
  for (const p of asArray<any>(txBody?.['a:p'])) {
    const parts: string[] = [];
    for (const r of asArray<any>(p?.['a:r'])) {
      const t = r?.['a:t'];
      if (typeof t === 'string') parts.push(t);
      else if (t && typeof t['#text'] === 'string') parts.push(t['#text']);
    }
    // Some decks put text directly on the paragraph via a field or break.
    if (!parts.length) {
      const direct = collectText(p, 'a:t');
      if (direct.length) parts.push(direct.join(''));
    }
    const line = parts.join('').trim();
    if (line) out.push(line);
  }
  return out;
}

function isTitleShape(sp: any): boolean {
  const ph = sp?.['p:nvSpPr']?.['p:nvPr']?.['p:ph'];
  const type = ph?.['@type'];
  return type === 'title' || type === 'ctrTitle';
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

export function parseDeck(base64: string): DeckData {
  const zip = openZip(base64);
  const slidePaths = listEntries(zip, (p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  if (!slidePaths.length) throw new OfficeParseError('This presentation has no slides.');

  const slides: SlideData[] = slidePaths.map((path, i) => {
    const xml = readEntry(zip, path) ?? '';
    const doc = parseXml(xml);
    const tree = doc?.['p:sld']?.['p:cSld']?.['p:spTree'] ?? {};

    let title: string | null = null;
    const body: string[] = [];

    for (const sp of asArray<any>(tree['p:sp'])) {
      const lines = paragraphsOf(sp?.['p:txBody']);
      if (!lines.length) continue;
      if (title == null && isTitleShape(sp)) {
        title = lines[0];
        body.push(...lines.slice(1));
      } else {
        body.push(...lines);
      }
    }

    // Fall back to the first text found when no title placeholder exists.
    if (title == null && body.length) title = body.shift() ?? null;

    const n = slideNumber(path) || i + 1;
    const notesXml = readEntry(zip, `ppt/notesSlides/notesSlide${n}.xml`);
    let notes: string | null = null;
    if (notesXml) {
      const lines = collectText(parseXml(notesXml), 'a:t')
        .join('')
        .trim();
      // Skip the slide-number placeholder PowerPoint appends to notes.
      notes = lines && lines !== String(n) ? lines : null;
    }

    const hasMedia =
      /r:embed|<p:pic|<a:videoFile|<p:blipFill/.test(xml) ||
      Object.keys(zip).some((k) => k.startsWith('ppt/media/'));

    return { index: n, title, body, notes, hasMedia };
  });

  return { slides };
}
