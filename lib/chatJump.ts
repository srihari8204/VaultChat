// Cross-screen "jump to message" hand-off. In-chat search opens over the chat
// screen and, on tapping a result, sets a pending jump here, then navigates
// back. The chat screen consumes it on focus and scrolls to that message.
// In-memory + single-shot — the value is cleared as soon as it's read.

let pending: { chatId: string; messageId: number } | null = null;

export function setPendingJump(chatId: string, messageId: number): void {
  pending = { chatId, messageId };
}

// Returns the messageId to jump to for this chat (once), or null.
export function consumePendingJump(chatId: string): number | null {
  if (pending && pending.chatId === chatId) {
    const id = pending.messageId;
    pending = null;
    return id;
  }
  return null;
}
