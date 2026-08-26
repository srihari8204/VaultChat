// lib/media/compressMedia.ts — run the decisions in ./compress against the
// real files. The arithmetic lives there (pure, selftested); this is the part
// that touches native modules and the filesystem.
//
// ONE RULE ABOVE ALL: COMPRESSION MUST NEVER FAIL A POST.
//
// Every path here falls back to the ORIGINAL uri. A status that goes up large
// is a bad status; a status that does not go up because the encoder disliked a
// file is a bug the user cannot work around, and they have already chosen the
// photo and typed the caption by the time we run. So every failure is caught
// and swallowed by design, not by accident.
//
// IMAGES use expo-image-manipulator, already a dependency (it renders PDF
// pages in lib/docs/pdf.ts). No new native code, so this half cannot break the
// build.
//
// VIDEO needs a transcoder, which Expo does not provide: expo-image-picker's
// videoQuality/videoExportPreset are UIImagePickerController options and do
// NOTHING on Android. react-native-compressor wraps MediaCodec / AVAsset­Export
// and is required at runtime rather than imported, so its ABSENCE degrades to
// "upload the original" instead of breaking the screen — the same shape as
// quick-crypto falling back to @noble in lib/mediaCrypto, and the Rust
// VaultBeam core falling back to Kotlin.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { targetSize, shouldCompressVideo, JPEG_QUALITY } from './compress';

/** Loaded once. null when the native module is absent — then video passes through. */
let VideoCompressor: any = null;
try {
  const m = require('react-native-compressor');
  VideoCompressor = typeof m?.Video?.compress === 'function' ? m.Video : null;
} catch {
  VideoCompressor = null;
}

/** Is video compression available on this build? Surfaced so callers can log it. */
export function videoCompressionAvailable(): boolean {
  return VideoCompressor !== null;
}

async function sizeOf(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true } as any);
    return (info as any)?.size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Resize + re-encode a photo. Returns the ORIGINAL uri when nothing should
 * change — a small image, unknown dimensions, or any failure.
 *
 * `width`/`height` come from the picker asset. When the picker does not report
 * them, targetSize() returns null and we leave the file alone rather than
 * guessing at a resize.
 */
export async function compressImage(
  uri: string,
  width?: number,
  height?: number,
): Promise<string> {
  const target = targetSize({ width: width ?? 0, height: height ?? 0 });
  if (!target) return uri;
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: target.width, height: target.height } }],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    return out?.uri || uri;
  } catch {
    return uri;   // never block the post
  }
}

/**
 * Transcode a video when it is big enough to be worth it AND the native module
 * is present. Returns the original uri otherwise.
 *
 * 'auto' lets the library pick a bitrate from the source rather than pinning a
 * number that would be wrong for both a screen recording and a camera clip.
 */
export async function compressVideo(uri: string): Promise<string> {
  if (!VideoCompressor) return uri;
  const bytes = await sizeOf(uri);
  if (!shouldCompressVideo(bytes)) return uri;
  try {
    const out = await VideoCompressor.compress(uri, { compressionMethod: 'auto' });
    return out || uri;
  } catch {
    return uri;   // never block the post
  }
}

/**
 * The one call the status screen makes. Images and videos both go through it so
 * the caller does not branch, and so a future caller (chat attachments) gets the
 * same behaviour for free.
 */
export async function compressForStatus(a: {
  uri: string;
  type: 'image' | 'video';
  width?: number;
  height?: number;
}): Promise<string> {
  return a.type === 'video'
    ? compressVideo(a.uri)
    : compressImage(a.uri, a.width, a.height);
}

export default {};
