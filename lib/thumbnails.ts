// lib/thumbnails.ts — small media thumbnails (WhatsApp-style).
//
// The SENDER generates a tiny JPEG thumbnail from the local file and embeds it
// in the message (meta.thumb, base64). The receiver renders it INSTANTLY — no
// full download needed for the preview, which is the whole point for video. Kept
// small (~a few KB) so it rides in the message meta without bloat.

import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import PdfThumbnail from 'react-native-pdf-thumbnail';

const THUMB_WIDTH = 240;

/** First-page preview of a PDF as a base64 JPEG (WhatsApp-style doc preview). */
export async function makePdfThumb(localUri: string): Promise<string | null> {
  try {
    const { uri } = await PdfThumbnail.generate(localUri, 0);   // page 1 (0-indexed)
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 320 } }],
      { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    return r.base64 ?? null;
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
