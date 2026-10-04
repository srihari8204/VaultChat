// lib/messageReminderReset.ts — recognise app/message-reminder's own scheduled
// notifications, so a damaged reminder list (whose rows hold the cancel ids)
// can still be cleared without touching any other feature's notifications.

/** The fixed body every message reminder is scheduled with. */
export const MESSAGE_REMINDER_BODY = 'You asked to be reminded about a message.';

type ScheduledLike = { content?: { body?: string | null; data?: Record<string, unknown> | null } | null };

/** True for a pending notification that app/message-reminder scheduled. */
export function isMessageReminderRequest(req: ScheduledLike): boolean {
  const c = req?.content;
  return !!c && c.body === MESSAGE_REMINDER_BODY && !!c.data?.chatId && !!c.data?.messageId;
}
