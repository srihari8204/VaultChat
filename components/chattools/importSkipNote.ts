// components/chattools/importSkipNote.ts — the "what was skipped" line on the
// import's Done screen. The counts alone ("Unsupported items: 3") did not say
// what was left out or whether the user could do anything about it. Pure, so it
// is Node-tested (lib/chatToolsRound8.selftest.ts).

export interface SkipCounts {
  duplicates: number; unsupported: number; missingMedia: number; mediaSkipped: number;
}

const n = (k: number, one: string, many: string) => `${k.toLocaleString()} ${k === 1 ? one : many}`;

/** One sentence naming each kind of skipped item, or null when nothing was skipped. */
export function importSkipNote(c: SkipCounts): string | null {
  const parts: string[] = [];
  if (c.duplicates > 0) parts.push(`${n(c.duplicates, 'message was', 'messages were')} already in this chat, so not added twice`);
  if (c.unsupported > 0) parts.push(`${n(c.unsupported, 'line', 'lines')} in the export did not read as a message`);
  if (c.missingMedia > 0) parts.push(`${n(c.missingMedia, 'media file is', 'media files are')} mentioned but not in the export — export the chat again with media to bring ${c.missingMedia === 1 ? 'it' : 'them'}`);
  if (c.mediaSkipped > 0) parts.push(`${n(c.mediaSkipped, 'media file was', 'media files were')} too large to copy`);
  return parts.length ? `Skipped: ${parts.join('; ')}.` : null;
}

export default importSkipNote;
