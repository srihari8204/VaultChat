// lib/camera/cameraMode.ts — the pure decisions behind the one camera screen.
//
// app/camera.tsx is a single screen with three modes. The parts that can break
// silently are not the pixels, they are these: which permission a mode needs,
// what the flash cycles to, and exactly which params travel back to the chat.
// They live here so a selftest can hold them still.

export type CameraMode = 'SCAN' | 'PHOTO' | 'VIDEO';

/** Tab order, left to right. The one list the tabs and the selftest share. */
export const captureModes: CameraMode[] = ['SCAN', 'PHOTO', 'VIDEO'];
export type Flash = 'off' | 'auto' | 'on';

/** Flash cycles off → auto → on → off. The icon carries the state. */
export function nextFlash(f: Flash): Flash {
  return f === 'off' ? 'auto' : f === 'auto' ? 'on' : 'off';
}

/**
 * Only VIDEO records audio, so only VIDEO may ask for the microphone — and
 * only when the user first switches to it, never when the screen opens.
 */
export function needsMic(mode: CameraMode): boolean {
  return mode === 'VIDEO';
}

/** CameraView takes 'picture' | 'video'. SCAN keeps the preview in picture mode. */
export function previewMode(mode: CameraMode): 'picture' | 'video' {
  return mode === 'VIDEO' ? 'video' : 'picture';
}

export interface ReturnTarget {
  chatId?: string;
  peerUid?: string;
  peerName?: string;
}

export interface Capture {
  uri: string;
  /** 'file' is a scanned PDF; 'video-note' is the round composer capture. */
  type: 'image' | 'video' | 'video-note' | 'file';
  viewOnce?: boolean;
  filename?: string;
}

/**
 * The params the camera hands back to the chat. The chat is addressed by id,
 * never by popping the stack — a camera opened from a notification deep link
 * has no chat underneath it to pop back to.
 *
 * With no capture (the ✕ path) the captured* keys are absent, so dismissing
 * can never stage a stale attachment in the composer.
 */
export function returnParams(to: ReturnTarget, capture?: Capture): Record<string, string> {
  const p: Record<string, string> = {};
  // chat.tsx resolves `params.id ?? params.chatId`, and a pop-to REPLACES the
  // target's params rather than merging them — so send both keys and the chat
  // resolves to the same conversation whichever one it reads.
  if (to.chatId) { p.chatId = to.chatId; p.id = to.chatId; }
  if (to.peerUid) p.peerUid = to.peerUid;
  if (to.peerName) p.peerName = to.peerName;
  if (!capture) return p;
  p.capturedUri = capture.uri;
  p.capturedType = capture.type;
  // View-once marks image/video bytes on send; a PDF has nothing to mark.
  p.capturedViewOnce = capture.viewOnce && capture.type !== 'file' ? '1' : '0';
  if (capture.filename) p.capturedName = capture.filename;
  return p;
}

/** ML Kit hands back bare paths on some devices; the RN Image/upload layer needs a scheme. */
export function fileUri(path: string): string {
  return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}
