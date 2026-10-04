// lib/spaces/sosOutbox.ts — keeps a driver's emergency alert on the phone until
// the server has it. The rules (who sends, when it is too old, what counts as
// final) are lib/spaces/sosQueue.ts; the outbox itself is sosOutboxCore.ts
// (tested through stubs); this file wires it to AsyncStorage and lib/api and
// says app-wide what became of an alert nobody is waiting on.
//
// Sent from three places, all while crazzychat is open (there is no background
// fetch in this app):
//   - the moment it is pressed (components/spaces/DriverSos),
//   - every 30 s while the driver screen shows one waiting,
//   - on every return to the foreground and every 2 minutes, from the root
//     (useSpaceDeviceAgent in lib/spaces/deviceAgent.ts), so an alert pressed
//     before the app was closed goes out when it is next opened.
//
// Each alert carries its own key (a uuid) and its press time. A server with
// migration 146 files one incident per key and tells the run when it was
// pressed; today's server ignores both, so on it a request that reached the
// server but whose answer was lost is sent again: two alerts for one press.
// That is the safe direction for an emergency.
//
// Who "I" am is the subject of the token the request goes out with (falling
// back to the cached user), and the request is sent with expectedUserId set to
// the reporter: another account's token is refused before anything is sent.
//
// Not cleared on sign-out (app/(constants)/authService purgeAccountData): a
// session that expires while a driver is offline must not take the alert with
// it. An entry holds only ids and a time, only the account that pressed it
// ever sends it, and another account's entries are pruned after a day.

import { Alert } from 'react-native';
import * as Crypto from 'expo-crypto';
import { getAccessToken, getCachedUser } from '../api';
import { tokenSubject } from '../tokenIdentity';
import { fileIncident, getRun } from './api';
import { createSosOutbox, type SosEvent } from './sosOutboxCore';
import { sosBody, deliveredText, undeliveredText } from './sosQueue';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;

async function me(): Promise<string> {
  let tokenFailed = false;
  try {
    const sub = tokenSubject(await getAccessToken());
    if (sub) return sub;
  } catch { tokenFailed = true; }
  const u = (await getCachedUser()) as { id?: string | number } | null; // throws when unreadable
  if (u?.id != null && String(u.id)) return String(u.id);
  if (tokenFailed) throw new Error('Signed-in account unreadable');
  return '';
}

const box = createSosOutbox({
  store: {
    getItem: (k) => storage().getItem(k),
    setItem: (k, v) => storage().setItem(k, v),
  },
  me,
  send: (e, expectedUserId) => fileIncident(e.spaceId, sosBody(e), expectedUserId ? { expectedUserId } : undefined),
  runStatus: async (spaceId, runId) => (await getRun(spaceId, runId)).run?.status,
  now: () => Date.now(),
  newId: () => Crypto.randomUUID(),
});

export const {
  queueSos, flushSos, sendUnkept, sosForThisRun, dismissSos, withdrawSos, onSosQueueChange,
} = box;
export { SosNotKept, SosUnknown, type PressResult } from './sosOutboxCore';

/** Say any of my alerts that will never be delivered and have not been said
 *  this session, wherever the driver is in the app. Never throws. */
export async function tellUndeliveredSos(): Promise<void> {
  const list = await box.undeliveredToTell().catch(() => []);
  if (!list.length) return;
  Alert.alert(
    list.length === 1 ? 'Emergency alert not delivered' : 'Emergency alerts not delivered',
    undeliveredText(list),
    [
      { text: 'Later', style: 'cancel' },
      { text: 'Dismiss', onPress: () => { list.forEach((e) => { void box.dismissSos(e.id).catch(() => {}); }); } },
    ],
  );
}

/**
 * Mount once, at the root (lib/spaces/deviceAgent). A retry nobody is waiting
 * on is said here: its delivery once (with when it was pressed), and its
 * refusal or expiry. A press says its own result (components/spaces/DriverSos).
 */
export function watchSosOutcomes(): () => void {
  return box.onSosEvent((e: SosEvent) => {
    if (e.by === 'press') return;
    if (e.type === 'sent') Alert.alert('Emergency alert delivered', deliveredText(e.entry, e.at, e.runEnded));
    else void tellUndeliveredSos();
  });
}
