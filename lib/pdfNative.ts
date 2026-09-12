// lib/pdfNative.ts — the JS face of the native PDF renderer.
//
// The native side is plugins/android/VaultPdfModule.kt (android.graphics.pdf,
// i.e. the platform's own pdfium). React Native runs its @ReactMethod calls on
// the native module executor, so page rendering happens off both the UI thread
// and the JS thread — which is the whole reason this exists. See the module's
// header for why pdf.js in a WebView could not do that.
//
// Rendered pages are written to disk by the native side and referenced here by
// path. Nothing page-sized ever crosses the bridge.

import { NativeModules, Platform } from 'react-native';

const Native = (NativeModules as any).VaultPdf as
  | {
      info(path: string): Promise<{ pageCount: number; width?: number; height?: number }>;
      renderPage(
        path: string, pageIndex: number, targetWidth: number, outPath: string,
      ): Promise<{ uri: string; width: number; height: number }>;
    }
  | undefined;

/**
 * Whether native rendering is usable on this build.
 *
 * False on iOS (no module yet) and on an Android build made before the config
 * plugin was added — an APK can be newer than the native code inside it, and a
 * missing module must degrade to the text reader rather than throw.
 */
export const pdfNativeAvailable = Platform.OS === 'android' && !!Native;

/** Distinguishable failures — the UI must not treat these alike. */
export type PdfErrorCode =
  | 'PASSWORD_REQUIRED'   // encrypted; asking for a password is a real recovery
  | 'CORRUPT'             // truncated or not a PDF
  | 'TOO_LARGE'           // out of memory at this width; retry smaller
  | 'RANGE'
  | 'RENDER_FAILED'
  | 'UNAVAILABLE';        // no native module in this build

export class PdfError extends Error {
  constructor(public code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

function wrap(e: any): PdfError {
  const code = (e?.code as PdfErrorCode) || 'RENDER_FAILED';
  return new PdfError(code, e?.message || 'This PDF could not be opened.');
}

export interface PdfInfo {
  pageCount: number;
  /** First page, in PDF points — the aspect ratio to reserve space with. */
  width: number;
  height: number;
}

/**
 * Page count and first-page geometry, WITHOUT rendering anything.
 *
 * Also the cheapest validity check there is: a corrupt or password-protected
 * file fails here in microseconds, instead of after a render timeout.
 */
export async function pdfInfo(path: string): Promise<PdfInfo> {
  if (!Native) throw new PdfError('UNAVAILABLE', 'Native PDF rendering is not available in this build.');
  try {
    const r = await Native.info(path);
    return { pageCount: r.pageCount ?? 0, width: r.width ?? 612, height: r.height ?? 792 };
  } catch (e) {
    throw wrap(e);
  }
}

/**
 * Render one page and return a file:// uri for the image.
 *
 * `targetWidth` is the memory budget in pixels: height follows the page's own
 * aspect ratio, so a document can never decide how much memory it takes.
 * `cacheDir` must be app-private — a rendered page is plaintext of an
 * attachment and is subject to the same cleanup as the rest (see
 * lib/mediaCacheGC.purgeDocumentCache).
 */
export async function renderPdfPage(
  path: string, pageIndex: number, targetWidth: number, cacheDir: string, key: string,
): Promise<{ uri: string; width: number; height: number }> {
  if (!Native) throw new PdfError('UNAVAILABLE', 'Native PDF rendering is not available in this build.');
  const out = `${cacheDir.replace(/\/$/, '')}/${key}_p${pageIndex}_w${Math.round(targetWidth)}.jpg`;
  try {
    return await Native.renderPage(path, pageIndex, Math.round(targetWidth), out);
  } catch (e) {
    throw wrap(e);
  }
}

export default { pdfNativeAvailable, pdfInfo, renderPdfPage };
