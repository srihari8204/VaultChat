// lib/spaces/sosOutbox.ts — keeps a driver's emergency alert on the phone until
// the server has it. The rules (who sends, when it is too old, what counts as
// final) are lib/spaces/sosQueue.ts; this file stores and sends.
//
// Sent from three places, all while crazzychat is open (there is no background
// fetch in this app):
//   - the moment it is pressed (app/space-run-driver.tsx),
//   - every 30 s while the driver screen shows one waiting,
//   - on every return to the foreground and every 2 minutes, from the root
//     (useSpaceDeviceAgent in lib/spaces/deviceAgent.ts), so an alert pressed
//     before the app was closed goes out when it is next opened.
//
// The server has no idempotency key for incidents, so a request that reached it
// but whose answer was lost is sent again: two alerts for one press. That is
// the safe direction for an emergency.
//
// Not cleared on sign-out (app/(constants)/authService purgeAccountData): a
// session that expires while a driver is offline must not take the alert with
// it. An entry holds only ids and a time, and only the account that pressed it
// ever sends it (sosQueue dueSos).

import { getCachedUser } from '../api';
import { fileIncident } from './api';
import { errMsg, errStatus } from './errors';
import {
  parseSosQueue, dueSos, afterAttempt, markExpired, sosForRun, type PendingSos,
} from './sosQueue';

const KEY = 'vc_space_sos_queue_v1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;

const listeners = new Set<() => void>();
/** Called after every change to the stored queue. Returns the unsubscribe. */
export function onSosQueueChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function load(): Promise<PendingSos[]> {
  try { return parseSosQueue(await storage().getItem(KEY)); } catch { return []; }
}

// Every read-modify-write goes through one chain, so a press during a flush
// cannot be overwritten by the flush's older copy of the list.
let chain: Promise<unknown> = Promise.resolve();
function mutate(fn: (q: PendingSos[]) => PendingSos[]): Promise<void> {
  const next = chain.then(async () => {
    const before = await load();
    const after = fn(before);
    if (after === before) return;
    // A failed write is thrown to the caller: an emergency that was not saved
    // must not be reported as saved.
    await storage().setItem(KEY, JSON.stringify(after));
    listeners.forEach((l) => { try { l(); } catch { /* a listener's problem */ } });
  });
  chain = next.catch(() => {});
  return next;
}

const myId = async () => {
  const u = await getCachedUser().catch(() => null) as { id?: string | number } | null;
  return u?.id != null ? String(u.id) : '';
};

/**
 * Keep one emergency alert for this run, then try to send it. Resolves to its
 * local id, whether the server has it now, and why it never will (`dead`).
 * Throws only if the phone could not save it.
 */
export async function queueSos(
  spaceId: string, runId: string, fallbackReporter = '',
): Promise<{ id: string; sent: boolean; dead?: string }> {
  const reporterId = (await myId()) || fallbackReporter;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await mutate((q) => [...q, { id, spaceId, runId, reporterId, at: Date.now() }]);
  // A flush already under way read the list before this entry existed.
  if (flushing) await flushing;
  await flushSos();
  const left = (await load()).find((e) => e.id === id);
  return { id, sent: !left, dead: left?.dead };
}

let flushing: Promise<void> | null = null;

/** Send every waiting alert of the signed-in account. Never throws. */
export function flushSos(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const me = await myId();
      const { send, expire } = dueSos(await load(), me, Date.now());
      if (expire.length) await mutate((q) => markExpired(q, new Set(expire.map((e) => e.id))));
      for (const e of send) {
        try {
          await fileIncident(e.spaceId, { category: 'sos', runId: e.runId, note: '' });
          await mutate((q) => afterAttempt(q, e.id, null));
        } catch (err) {
          await mutate((q) => afterAttempt(q, e.id, { status: errStatus(err), message: errMsg(err) }));
        }
      }
    } catch { /* storage unreadable: the next flush tries again */ } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** This driver's waiting and undeliverable alerts for one run. */
export async function sosForThisRun(spaceId: string, runId: string): Promise<PendingSos[]> {
  return sosForRun(await load(), spaceId, runId, await myId());
}

/** Remove an entry the driver has seen was not delivered. */
export function dismissSos(id: string): Promise<void> {
  return mutate((q) => q.filter((e) => e.id !== id));
}
