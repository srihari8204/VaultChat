// components/chattools/reminderStore.ts — the message-reminder list on this
// device (app/message-reminder.tsx's composer writes it, RemindersList reads
// and cancels from it).
//
// Storage: AsyncStorage list of { id, chatId, messageId, when } — NO message
// text. The text is re-read from the local message cache (sealed SQLite) when
// it is shown, so no decrypted body sits in plain storage.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Alert } from 'react-native';
import { getCachedMessagesByIds } from '../../lib/localDb';
import { looksEncrypted } from '../../lib/chatService';
import { E2EE_UNDECRYPTABLE, e2eeGetCached } from '../../services/crypto/e2eeSession.rn';
import { isMessageReminderRequest } from '../../lib/messageReminderReset';

const STORAGE_KEY = 'vc_message_reminders_v1';

export interface ReminderRow {
  id:        string;     // expo-notifications identifier
  chatId:    string;
  messageId: string;
  /** Legacy rows only; never written now. Display text is read at list time. */
  preview?:  string;
  when:      string;     // ISO timestamp
  createdAt: string;
}

// Throws when the stored list cannot be read, so callers can tell "no
// reminders" apart from "could not read them" (the list shows an error, the
// composer undoes the notification it just scheduled).
export async function loadReminders(): Promise<ReminderRow[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const list = JSON.parse(raw) as ReminderRow[];
  if (!Array.isArray(list)) throw new Error('Reminder list is unreadable');
  // Drop any rows whose scheduled time has already passed (the notification
  // either fired or was cancelled; we don't need to keep them around), and
  // the plaintext preview older builds stored. Persist when either changed,
  // so expired rows and old plaintext do not accumulate.
  const now = Date.now();
  const kept = list
    .filter(r => new Date(r.when).getTime() > now - 60_000)
    .map(({ preview: _drop, ...r }) => r);
  if (kept.length !== list.length || list.some(r => r.preview)) {
    await saveReminders(kept).catch(() => {});
  }
  return kept;
}

/** Shown instead of the text of a view-once / Invisible Ink message. */
export const PROTECTED_TEXT = 'View-once or Invisible Ink message — text hidden';

// The message text for display, from the local message cache. Null when the
// message is not cached on this device or not readable.
export async function cachedText(r: Pick<ReminderRow, 'chatId' | 'messageId'>): Promise<string | null> {
  try {
    const [m] = await getCachedMessagesByIds(r.chatId, [Number(r.messageId)]);
    // View-once / Invisible Ink text is never shown outside its bubble.
    if (m?.meta?.viewOnce || m?.meta?.invisibleInk) return PROTECTED_TEXT;
    const t = m?.type === 'text' ? m.content : null;
    if (!t) return null;
    if (!looksEncrypted(t)) return t;
    // Still stored as an envelope: the bubble's own decrypt cached the text,
    // checked against this ciphertext.
    const pt = await e2eeGetCached(r.chatId, Number(r.messageId), t);
    return pt && pt !== E2EE_UNDECRYPTABLE ? pt : null;
  } catch { return null; }
}

/** Shown instead of the message text for a reminder in a locked or hidden chat. */
export const LOCKED_TEXT = '🔒 Locked chat';

export async function saveReminders(list: ReminderRow[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Recovery for a list that cannot be read: its rows hold the cancel ids, so
 *  cancel every pending notification this screen scheduled (matched by its
 *  fixed body + chat/message data), then drop the stored list. */
async function clearReminders(): Promise<void> {
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(pending.filter(isMessageReminderRequest)
    .map(r => Notifications.cancelScheduledNotificationAsync(r.identifier)));
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/** Confirm, then clear the unreadable list; `after` runs once it is cleared. */
export function offerClearReminders(after: () => void) {
  Alert.alert(
    'Saved reminders can\'t be read',
    'The reminder list on this device is damaged, so reminders can\'t be saved or cancelled here. Clearing it cancels every message reminder you have set.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Clear reminders', style: 'destructive', onPress: async () => {
        try { await clearReminders(); }
        catch { Alert.alert('Could not clear reminders', 'Please try again.'); return; }
        after();
      } },
    ],
  );
}
