// lib/callHistory.ts — one call history from two sources.
//
// The device log (lib/callLog) and the server's record (lib/callSession) each
// know something the other does not, which is why this merges rather than
// replaces:
//
//   the device knows WHO      — peerName, peerPhoto, and the direction of a 1:1
//                               call. The server stores a chatId and a roster;
//                               it does not store "Ann called you".
//   the device knows OFFLINE  — a call made on a plane is in the log before the
//                               server ever hears about it, and after too.
//   the server knows EVERY DEVICE — and survives a reinstall, and is not capped
//                               at 300 entries.
//
// Replacing the local log with the server's would silently drop every call made
// before CALL_SESSIONS was enabled, plus anything logged while offline. So the
// device log stays authoritative for what it has, and the server fills in the
// calls this device never saw.
//
// DEDUPLICATION is by `callId`, not by timestamp. Both sides carry it for any
// call that opened a session, so a match is exact. Entries without one — older
// history, or a call whose session request never landed — are local-only and
// pass through untouched. There is no fuzzy time-window matching here on
// purpose: it would collapse two genuinely separate calls placed a few seconds
// apart, and getting that wrong deletes user history.

// TYPE-ONLY imports, and that is load-bearing: lib/callLog reaches AsyncStorage
// and lib/callSession reaches fetch, both of which drag in react-native. Type
// imports are erased at compile time, so this module stays pure JS and can be
// exercised under `tsx` in Node — which is the only reason the merge below has
// a self-test at all. Fetching lives in the caller (see loadCallHistory's note).
import type { CallLogEntry } from './callLog';
import type { ServerCallEntry } from './callSession';

/**
 * A history row, whatever it came from. This is a SUPERSET of CallLogEntry
 * rather than a new shape, so the calls screen renders both kinds through the
 * one path it already has and nothing downstream needs a branch.
 */
export interface CallHistoryEntry extends CallLogEntry {
  /** True when only the server knew about this call (another device made it). */
  remote?: boolean;
  /** This user's role, when the server told us. */
  role?: string;
}

export interface ChatNameLookup {
  /** chatId → display name, photo, and whether it is a 1:1 chat. */
  get(chatId: string): { name: string; photo?: string | null; direct?: boolean } | undefined;
}

/**
 * Turn a server row into the local shape.
 *
 * `direction` is the honest limitation: the server records that you were on a
 * call, not who rang whom, so the only thing derivable is whether YOU started
 * it. A call another device of yours received shows as incoming — which is what
 * it was from your side, even though we can't name the caller. `names` supplies
 * the chat's display name where the client knows it; that is why this takes a
 * lookup rather than inventing a placeholder.
 */
function fromServer(e: ServerCallEntry, meId: string, names: ChatNameLookup): CallHistoryEntry {
  const chat = names.get(e.chatId);
  const outgoing = e.startedBy === meId;
  return {
    id: `srv:${e.callId}`,
    callId: e.callId,
    chatId: e.chatId,
    // A 1:1 peer uid is not in the server row — the roster is per call, and
    // history does not fetch N rosters. The calls screen keys a group row by
    // chat anyway, and a 1:1 row resolves its peer from the chat list.
    peerUid: '',
    peerName: chat?.name || 'Call',
    peerPhoto: chat?.photo ?? null,
    kind: e.kind,
    // Never 'missed': the server only has rows for calls you actually joined.
    // A call that rang and was not answered leaves no participant row, so
    // claiming "missed" here would be inventing information.
    direction: outgoing ? 'outgoing' : 'incoming',
    at: Date.parse(e.joinedAt) || 0,
    durationSec: e.durationSec || 0,
    group: e.mode !== 'meeting' || !chat?.direct,
    remote: true,
    role: e.role,
  };
}

/**
 * Merge the device log with the server's history, newest first.
 *
 * Local wins on a callId collision — it has the peer name, photo and true
 * direction, and the server row would only blur them.
 */
export function mergeCallHistory(
  local: CallLogEntry[], server: ServerCallEntry[], meId: string, names: ChatNameLookup,
  /** Server calls this device has dismissed — see hideServerCalls(). */
  hidden?: ReadonlySet<string>,
): CallHistoryEntry[] {
  const seen = new Set<string>();
  for (const e of local) if (e.callId) seen.add(e.callId);

  const out: CallHistoryEntry[] = local.slice();
  for (const e of server) {
    if (!e?.callId || seen.has(e.callId) || hidden?.has(e.callId)) continue;
    seen.add(e.callId);
    out.push(fromServer(e, meId, names));
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// NOTE: there is deliberately no loadCallHistory() here that does the fetching.
// Keeping this module free of I/O is what keeps it testable in Node, and the
// composition is two lines the screen already had the pieces for:
//
//     const [local, server] = await Promise.all([getCallLog(), fetchCallHistory()]);
//     setLog(mergeCallHistory(local, server, meId, names));
//
// fetchCallHistory returns [] on ANY failure — flag off, unmigrated server,
// offline — so that expression degrades to exactly the local log, which is the
// behaviour that shipped before any of this existed.

export default {};
