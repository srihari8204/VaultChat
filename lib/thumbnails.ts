// lib/thumbnails.ts — small media thumbnails (WhatsApp-style).
//
// The SENDER generates a tiny JPEG thumbnail from the local file and embeds it
// in the message (meta.thumb, base64). The receiver renders it INSTANTLY — no
// full download needed for the preview, which is the whole point for video. Kept
// small (~a few KB) so it rides in the message meta without bloat.

import * as ImageManipulator from 'expo-image-manipulator';
import { requestPdfThumb } from '../components/PdfThumbnailer';
import * as VideoThumbnails from 'expo-video-thumbnails';

const THUMB_WIDTH = 240;

/** First-page preview of a PDF as a base64 JPEG.
 *  Disabled: `react-native-pdf-thumbnail` fails to compile on Expo SDK 54
 *  (Kotlin 2.0), breaking the Android build. PDFs fall back to a generic doc
 *  icon (callers already treat a null thumb as "no preview"). Re-enable with a
 *  build-compatible thumbnailer when one is available. */
export async function makePdfThumb(localUri: string): Promise<string | null> {
  return (await makePdfPreview(localUri))?.b64 ?? null;
}

/**
 * Page 1 of a PDF as a base64 JPEG, plus its page count — the two things the
 * document bubble shows. Rendering happens in an offscreen WebView because
 * pdf.js needs a canvas and React Native has none; null means no renderer, an
 * unreadable file, or too slow, and the bubble falls back to its icon row.
 */
export async function makePdfPreview(localUri: string): Promise<{ b64: string; pages: number } | null> {
  try {
    return await requestPdfThumb(localUri);
  } catch {
    return null;
  }
}

/** Returns a base64 JPEG thumbnail for an image/video local file, or null. */
export async function makeThumb(localUri: string, kind: 'image' | 'video' | string): Promise<string | null> {
  try {
    let frameUri = localUri;
    if (kind === 'video') {
      // Grab a frame ~1s in (avoids black first frames).
      const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, { time: 1000, quality: 0.6 });
      frameUri = uri;
    } else if (kind !== 'image') {
      return null; // only image/video get thumbnails
    }
    const r = await ImageManipulator.manipulateAsync(
      frameUri,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    return r.base64 ?? null;
  } catch {
    return null;
  }
}

/** Wrap a base64 JPEG for use as an <Image> source uri. */
export function thumbDataUri(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

export default {};
