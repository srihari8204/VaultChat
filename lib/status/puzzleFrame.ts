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
import * as FileSystem from 'expo-file-system/legacy';
import { withTimeout, THUMB_TIMEOUT_MS } from '../thumbnails';

/**
 * Extract one frame, retrying through a `.mp4`-named copy if the first try
 * finds nothing.
 *
 * WHY THE COPY EXISTS. Decrypted media is cached as `media_<attachmentId>`
 * with NO FILE EXTENSION (lib/mediaAttachments.ts). Everywhere else in the app
 * that pulls a video frame — makeThumb, on the send path — is handed the
 * SENDER's picked file, which is a real `.mp4` from the picker. So this is the
 * first caller to give the extractor an extension-less path, and Android's
 * retriever does not always sniff the container when the name tells it
 * nothing: it returns no frame, the board has nothing to cut up, and the
 * viewer is quietly handed the "Open" fallback instead of a puzzle. That is
 * the "video status puzzle does not work" report.
 *
 * The copy is a FALLBACK, not the default: status clips are capped at 30s but
 * are still megabytes, and paying a full file copy on every gated video when
 * the direct read usually works would be wasteful. It is deleted immediately —
 * the frame is a separate JPEG by then and does not reference it.
 */
async function extractFrame(uri: string): Promise<string | null> {
  const at = async (src: string): Promise<string | null> => {
    try {
      // ~1s in, because a frame at t=0 is routinely black.
      return (await VideoThumbnails.getThumbnailAsync(src, { time: 1000, quality: 0.7 })).uri;
    } catch {
      try {
        // Seeking past the end throws on some decoders — retry at 0 for clips
        // shorter than a second.
        return (await VideoThumbnails.getThumbnailAsync(src, { time: 0, quality: 0.7 })).uri;
      } catch {
        return null;
      }
    }
  };

  const direct = await at(uri);
  if (direct) return direct;
  if (/\.[A-Za-z0-9]{2,4}$/.test(uri)) return null;   // already had an extension; the copy would change nothing

  const named = `${(FileSystem as any).cacheDirectory}puzzle_${Date.now()}.mp4`;
  try {
    await FileSystem.copyAsync({ from: uri, to: named });
    return await at(named);
  } catch {
    return null;
  } finally {
    await FileSystem.deleteAsync(named, { idempotent: true }).catch(() => {});
  }
}

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

  // THE CLOCK IS NOT OPTIONAL.
  //
  // A `.catch()` only handles a REJECTED promise. A native decoder that wedges
  // on a malformed or exotic file returns one that NEVER SETTLES — and this
  // sits between the viewer opening a locked video and the board appearing, so
  // a wedge leaves "Getting the pieces ready…" on screen forever with no way
  // out but backing out of the story. lib/thumbnails.ts already learned this
  // (it wraps the identical call), so the same helper is reused rather than a
  // second timeout invented next to it.
  //
  // The budget covers BOTH attempts, deliberately: a viewer waiting on a
  // puzzle should not be made to sit through two full timeouts in series.
  return withTimeout(extractFrame(localUri), THUMB_TIMEOUT_MS, null);
}

export default {};
