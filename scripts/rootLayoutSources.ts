// scripts/rootLayoutSources.ts — the files that together hold the root layout's
// launch gate, veil and boot sequence, for the selftests that pin their text.
//
// app/_layout.tsx used to hold all of it inline. The boot sequence moved to
// components/root/useBootSequence.ts, and a pin that kept reading only the
// layout would either fail or, for an "X is absent" check, pass vacuously.
// Reading this list keeps every pin — presence, absence and order — aimed at
// the code that runs. Add a file here when more of the root moves out.
//
// Node-only (selftests); nothing in the app imports this.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** In boot order: the layout first, so its module scope and gate precede the sequence. */
export const ROOT_LAYOUT_SOURCES = [
  'app/_layout.tsx',
  'components/root/useBootSequence.ts',
] as const;

/** The listed files' text, joined in list order. */
export function readRootLayout(): string {
  return ROOT_LAYOUT_SOURCES.map((f) => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n');
}
