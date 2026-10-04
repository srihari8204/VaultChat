// components/chat/protectedText.ts — what a View-once or Invisible Ink message
// may show OUTSIDE its own bubble (reply bar, quoted reply, Memory banner,
// in-chat search). The bubble alone decides when the text is revealed, so
// everywhere else names the kind and never carries the text, including in
// accessibility labels. Same rule as exports, Remind and Star
// (lib/chatExportFormat.ts, useMessageActions.ts).

export interface ProtectableMessage {
  meta?: { viewOnce?: boolean; invisibleInk?: boolean } | null;
}

export function isProtectedMessage(m: ProtectableMessage | null | undefined): boolean {
  return !!(m?.meta?.viewOnce || m?.meta?.invisibleInk);
}

/** `text` for an ordinary message; a fixed label for a protected one. */
export function previewText(m: ProtectableMessage | null | undefined, text: string): string {
  if (m?.meta?.invisibleInk) return 'Invisible Ink message';
  if (m?.meta?.viewOnce) return 'View once message';
  return text;
}
