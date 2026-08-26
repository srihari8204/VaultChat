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

/** Hard ceiling for one preview decode. See withTimeout. */
export const THUMB_TIMEOUT_MS = 12_000;

/**
 * Resolve to `fallback` if `p` has not settled within `ms`.
 *
 * Every caller here is BEST-EFFORT decoration — a poster frame, a PDF page —
 * but they sit on the send path between a finished upload and sendMessage. A
 * `.catch()` only handles a REJECTED promise; a native decoder that wedges on a
 * malformed or exotic file returns a promise that never settles at all, and
 * then the message is never sent, the bubble sits pending forever, and it looks
 * to the user like the app hung. A preview is never worth blocking delivery.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

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
    // The renderer is an offscreen WebView running pdf.js — if it never posts
    // back (huge or malformed PDF) the promise simply never settles, so this
    // needs the clock, not just the catch.
    return await withTimeout(requestPdfThumb(localUri), THUMB_TIMEOUT_MS, null);
  } catch {
    return null;
  }
}

/** Returns a base64 JPEG thumbnail for an image/video local file, or null. */
export async function makeThumb(localUri: string, kind: 'image' | 'video' | string): Promise<string | null> {
  return withTimeout(makeThumbInner(localUri, kind), THUMB_TIMEOUT_MS, null);
}

async function makeThumbInner(localUri: string, kind: 'image' | 'video' | string): Promise<string | null> {
  try {
    let frameUri = localUri;
    if (kind === 'video') {
      // Grab a frame ~1s in (avoids black first frames), but fall back to frame
      // 0 for clips SHORTER than that — seeking past the end throws on some
      // decoders, which cost the whole poster for every sub-second clip.
      try {
        const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, { time: 1000, quality: 0.6 });
        frameUri = uri;
      } catch {
        const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, { time: 0, quality: 0.6 });
        frameUri = uri;
      }
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
