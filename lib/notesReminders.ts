// lib/notesReminders.ts — OS alarms for note reminders.
//
// `reminder?: number` sat in the Note interface with nothing reading it: the
// screen advertised "Reminders on Notes" and had none. This is that feature.
//
// TIMESTAMP + allowWhileIdle, the same AlarmManager path leaveNowAlarm and
// scheduledRunner use, because a JS timer dies with the process and a reminder
// that only fires while the app is already open is not a reminder.
//
// WHAT THE NOTIFICATION MAY SAY
// Nothing from inside the vault. A note titled "Amex PIN" must not put that on
// a lock screen that anyone standing nearby can read — and a locked or
// sensitive note gives up its title entirely. This is the same reasoning as
// FLAG_SECURE: the vault's protection cannot end at a notification shade.

import { Platform } from 'react-native';
import notifee, { TriggerType, AndroidImportance } from '@notifee/react-native';

const CHANNEL_ID = 'vaultchat_note_reminders';
const alarmId = (noteId: string) => `note-${noteId}`;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.createChannel({ id: CHANNEL_ID, name: 'Note reminders', importance: AndroidImportance.DEFAULT });
  } catch {}
}

/** What the shade is allowed to show for this note. */
export function reminderBody(title: string, isSensitive: boolean, isLocked: boolean): string {
  if (isLocked || isSensitive) return 'A protected note is waiting for you.';
  const t = title.trim();
  if (!t) return 'A note is waiting for you.';
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

/**
 * Arm (or re-arm) a note's reminder. One alarm per note — re-arming replaces
 * it, so an edited time never leaves two alarms racing.
 *
 * Returns false when the time has already passed: a reminder for a moment in
 * the past is dropped rather than fired immediately, since unlike "leave now"
 * a late note reminder carries no urgency worth a surprise notification.
 */
export async function armNoteReminder(
  noteId: string, at: number, title: string, isSensitive: boolean, isLocked: boolean,
): Promise<boolean> {
  await cancelNoteReminder(noteId);
  if (!Number.isFinite(at) || at <= Date.now()) return false;
  try {
    await ensureChannel();
    await notifee.requestPermission();
    await notifee.createTriggerNotification(
      {
        id: alarmId(noteId),
        title: '📝 Note reminder',
        body: reminderBody(title, isSensitive, isLocked),
        data: { noteId },
        android: { channelId: CHANNEL_ID, pressAction: { id: 'default', launchActivity: 'default' } },
      },
      { type: TriggerType.TIMESTAMP, timestamp: at, alarmManager: { allowWhileIdle: true } },
    );
    return true;
  } catch {
    return false;
  }
}

export async function cancelNoteReminder(noteId: string): Promise<void> {
  try { await notifee.cancelNotification(alarmId(noteId)); } catch {}
}
