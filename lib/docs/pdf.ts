// lib/docs/pdf.ts — cropped page images → one real PDF.
//
// SCAN mode in app/camera.tsx needs exactly this and nothing else: ML Kit has
// already done the edge detection and the perspective-correct crop, so all that
// is left is to downscale each page and print them onto the paper the chosen
// style calls for (see lib/docs/docStyle.ts — that is where the layout lives,
// and where it can be tested without expo).
//
// ponytail: app/docscanner.tsx still carries its own inline copy of this, wired
// into its per-page progress UI. Left alone deliberately — it is a working
// screen and this change was scoped to not touch it. Fold it in when that
// screen is next opened for another reason.

import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import { type DocStyleId, docStyle } from './docStyle';

/** ~150 dpi across A4. Wide enough to read, small enough to send. */
const PAGE_WIDTH = 1240;

/**
 * Assembles `uris` into a PDF and returns its file:// uri.
 * Throws if the pages cannot be read or the PDF cannot be written.
 */
export async function pagesToPdf(uris: string[], style: DocStyleId): Promise<string> {
  if (!uris.length) throw new Error('No pages to build a PDF from.');
  const s = docStyle(style);
  const pages: string[] = [];
  for (const uri of uris) {
    const page = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: PAGE_WIDTH } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    pages.push(
      `<div class="p"><img src="data:image/jpeg;base64,${page.base64}"/></div>`,
    );
  }
  const html =
    `<html><head><meta name="viewport" content="width=device-width"/><style>` +
    `@page { ${s.page} }` +
    `body { margin:0; padding:0; }` +
    `.p { page-break-after: always; text-align: center; }` +
    `.p img { width: ${s.imageWidth}; height: auto; }` +
    `</style></head><body>${pages.join('')}</body></html>`;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
