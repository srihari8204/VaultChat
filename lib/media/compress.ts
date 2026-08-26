// lib/media/compress.ts — shrink status media before it is uploaded.
//
// WHY THIS EXISTS
//
// Nothing on the media path compressed anything. app/(tabs)/status.tsx passed
// `quality: 0.7` to expo-image-picker, which is the PICKER's own setting: it
// does not resize, and on Android it is widely ignored depending on the source.
// So a 12 MP phone photo went up at 4000x3000 and several megabytes — paid for
// three times over, because every byte is also encrypted (lib/mediaCrypto
// streams the whole file through AES-GCM) and then downloaded by every viewer.
//
// WHAT WHATSAPP ACTUALLY DOES, and what this copies: bound the LONG EDGE, keep
// the aspect ratio, re-encode as JPEG at moderate quality. It does not target a
// byte size, and neither do we — a fixed geometry is predictable, and the
// bytes fall out of it.
//
// A useful side effect worth stating: re-encoding DROPS EXIF, so the GPS
// coordinates baked into a camera photo do not travel to everyone on a contact
// list. That is a privacy win the old path silently failed to provide.
//
// PURE — takes numbers, returns numbers. No react-native import, so the
// decisions run under `npx tsx` and the callers supply the pixels.

/** The long edge we bound a status photo to. */
export const MAX_EDGE = 1600;

/** JPEG quality for the re-encode. 0.75 is the usual sharpness/size knee. */
export const JPEG_QUALITY = 0.75;

/**
 * Below this, compressing a video costs more than it saves — transcoding is
 * expensive and a short clip is already small. `videoMaxDuration: 30` in the
 * picker already bounds the worst case.
 */
export const VIDEO_MIN_BYTES = 2 * 1024 * 1024;

export interface Size {
  width: number;
  height: number;
}

/**
 * The geometry to resize a photo to, or null to leave it alone.
 *
 * null is a real answer and the common one for screenshots and already-small
 * images: re-encoding a small JPEG makes it WORSE, not smaller, because it
 * pays the generation loss for nothing. NEVER upscale — that invents pixels
 * and inflates the upload at the same time.
 *
 * The long edge is bounded whichever way the photo is turned, so a portrait
 * phone photo and the same photo rotated land on the same pixel budget.
 */
export function targetSize(src: Size, maxEdge: number = MAX_EDGE): Size | null {
  if (!(src.width > 0) || !(src.height > 0)) return null;   // unknown dims: don't guess
  const longEdge = Math.max(src.width, src.height);
  if (longEdge <= maxEdge) return null;                     // already small enough
  const scale = maxEdge / longEdge;
  // Round rather than floor: flooring both sides can shift the aspect ratio
  // enough to letterbox a tall photo. Clamp to >=1 so a pathological ratio
  // cannot produce a zero dimension the encoder would reject.
  return {
    width: Math.max(1, Math.round(src.width * scale)),
    height: Math.max(1, Math.round(src.height * scale)),
  };
}

/**
 * Is this video worth transcoding?
 *
 * Size is the only signal available before doing the work — duration would
 * need the file opened, and the picker already caps it at 30s.
 */
export function shouldCompressVideo(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= VIDEO_MIN_BYTES;
}

export default {};
