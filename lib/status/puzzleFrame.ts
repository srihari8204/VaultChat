// lib/status/puzzleFrame.ts — the image a puzzle gate is cut from.
//
// An image status is its own puzzle. A VIDEO is not: a jigsaw needs a still, so
// one frame is extracted and cut up instead.
//
// The 1s-then-0 fallback is copied from lib/thumbnails.ts rather than reinvented,
// because it encodes something learned the hard way there: a frame at t=0 is
// routinely black (encoders open on a blank frame), but seeking to 1s THROWS on
// some decoders for clips shorter than that. Trying 1s first and falling back to
// 0 gets a useful frame for normal clips without losing sub-second ones
// entirely — and a black puzzle is unsolvable in the most frustrating way
// possible, because every piece looks identical.

import * as VideoThumbnails from 'expo-video-thumbnails';

/**
 * A still to build the puzzle from, or null when none can be produced.
 *
 * null is a real answer: GateChallenge treats a missing preview as "let them
 * through", which is correct because the puzzle was never protection. Trapping
 * a viewer behind a board that cannot render would deny access the gate never
 * guarded in the first place.
 */
export async function puzzleFrameUri(
  localUri: string,
  kind: 'image' | 'video' | 'text',
): Promise<string | null> {
  if (kind === 'image') return localUri;
  if (kind !== 'video') return null;   // a text status has nothing to cut up

  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, { time: 1000, quality: 0.7 });
    return uri;
  } catch {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(localUri, { time: 0, quality: 0.7 });
      return uri;
    } catch {
      return null;   // no frame — let the viewer through rather than strand them
    }
  }
}

export default {};
