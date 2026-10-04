// components/chat/chatErrorText.ts — the text for a failed SEND-side action in
// the chat (send, react, forward, upload, VaultBeam, GIF).
//
// lib/userErrorText, except that a local Error's own message is kept rather
// than replaced by the fallback: these paths throw deliberate user copy
// ("Could not save this message — try again." in lib/messageQueue, "File
// exceeds the 12 GB limit." in lib/vaultBeamController, the view-once rule in
// lib/forwardPayload). Server copy still passes through and a request with no
// HTTP answer still reads as connection copy.

import { userErrorText } from '../../lib/userErrorText';

export function chatActionErrorText(e: unknown, fallback: string): string {
  return userErrorText(e, (e instanceof Error && e.message) || fallback);
}
