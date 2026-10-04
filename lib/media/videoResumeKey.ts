// lib/media/videoResumeKey.ts — where app/video-player keeps a video's resume
// position in AsyncStorage.
//
// lib/videoSeek.resumeKey stored `vc_video_pos_` + the first 40 base64 chars of
// the file URI. That kept a readable prefix of the path in plain storage, and
// every video under the same ~30-character directory (the media cache) shared
// ONE key, so one video's position resumed another. A hash of the whole URI
// fixes both. PURE (no react-native import).

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function videoResumeKey(uri: string): string {
  return `vc_video_pos_h_${bytesToHex(sha256(utf8ToBytes(uri))).slice(0, 32)}`;
}

export default {};
