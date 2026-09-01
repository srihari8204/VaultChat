// hooks/useCall.ts — narrow subscriptions to the active call.
//
// The point of these is granularity. A screen that calls useCallSnapshot()
// re-renders on every change; one that calls useCallStatus() re-renders only
// when the lifecycle moves. That difference is what keeps a mute toggle from
// re-rendering a video surface, and it is why the store lives outside React
// (lib/call/store.ts) rather than in a screen's useState.
//
// Each hook selects a PRIMITIVE (or a stable reference the reducer preserves),
// so useSyncExternalStore's Object.is check does the filtering for free.

import { useMemo, useSyncExternalStore } from 'react';
import { getSnapshot, subscribe } from '../lib/call/store';
import { visibleOrder, type SpeakerTimes } from '../lib/call/visibleSet';
import type {
  CallChatMessage, CallReaction, CallRole, CallSnapshot, CallStatus, Participant,
} from '../lib/call/types';

function useSelect<T>(select: (s: CallSnapshot) => T): T {
  const read = () => select(getSnapshot());
  return useSyncExternalStore(subscribe, read, read);
}

/** Whole snapshot. Re-renders on ANY change — prefer a narrower hook. */
export function useCallSnapshot(): CallSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** connecting | ringing | connected | ended. */
export function useCallStatus(): CallStatus {
  return useSelect(s => s.status);
}

/**
 * Epoch ms the call connected, 0 before that. Feed straight into <CallTimer>,
 * which derives and renders the elapsed time itself — so the 1 Hz tick never
 * reaches the screen.
 */
export function useCallConnectedAt(): number {
  return useSelect(s => s.connectedAt);
}

export function useCallError(): string | null {
  return useSelect(s => s.error);
}

export function useCallLocalUrl(): string | null {
  return useSelect(s => s.localUrl);
}

/** One local device toggle. Changing `muted` will not re-render a camera view. */
export function useCallFlag(key: 'muted' | 'speaker' | 'cameraOff' | 'sharing' | 'peerSharing' | 'held'): boolean {
  return useSelect(s => s[key]);
}

/** A single participant, or null. Stable reference while that peer is unchanged. */
export function useParticipant(uid: string): Participant | null {
  return useSelect(s => s.participants[uid] ?? null);
}

/** Just this participant's stream URL — the narrowest useful video selector. */
export function useParticipantStreamUrl(uid: string): string | null {
  return useSelect(s => s.participants[uid]?.streamUrl ?? null);
}

/**
 * Participant uids, for a mesh grid. Selects a JOINED KEY STRING rather than the
 * participants object: that object is replaced on any per-peer change (a mute, a
 * track swap), whereas the grid only cares about join/leave. Selecting the
 * primitive means Object.is filters the rest out, and each tile subscribes to
 * its own peer via useParticipantStreamUrl(uid).
 */
export function useParticipantIds(): readonly string[] {
  const joined = useSelect(s => Object.keys(s.participants).join(' '));
  return useMemo(() => (joined ? joined.split(' ') : []), [joined]);
}

/** In-call chat, oldest first. The array reference changes only on a new line. */
export function useCallChat(): readonly CallChatMessage[] {
  return useSelect(s => s.chat);
}

/**
 * Unread in-call messages. Separate from useCallChat so the control bar's badge
 * updates on a new line without the (usually closed) sheet re-rendering, and so
 * clearing the badge doesn't touch the list.
 */
export function useCallChatUnread(): number {
  return useSelect(s => s.chatUnread);
}

/** Recent reactions. Bounded by the reducer; each is animated once, by id. */
export function useCallReactions(): readonly CallReaction[] {
  return useSelect(s => s.reactions);
}

/** Our own role. '' sessionId means no server session — see useCanModerate. */
export function useMyRole(): CallRole {
  return useSelect(s => s.myRole);
}

/** Whether our own hand is up. */
export function useMyHandRaised(): boolean {
  return useSelect(s => s.myHandRaisedAt > 0);
}

/**
 * Whether to show moderation controls at all.
 *
 * Requires a server session as well as the role: without one there is nothing
 * to promote against, and a button that silently does nothing is worse than no
 * button. The server re-checks the role on every action regardless — this is
 * what the user sees, not what they are permitted.
 */
export function useCanModerate(): boolean {
  return useSelect(s => !!s.sessionId && (s.myRole === 'host' || s.myRole === 'cohost'));
}

/**
 * Uids with a hand up, EARLIEST FIRST — the order they asked in.
 *
 * Selects a joined string so the common case (nobody's hand changed) is an
 * Object.is hit and costs no re-render, the same trick useParticipantIds uses.
 */
export function useRaisedHands(): readonly string[] {
  const joined = useSelect(s => Object.values(s.participants)
    .filter(p => p.handRaisedAt > 0)
    .sort((a, b) => a.handRaisedAt - b.handRaisedAt)
    .map(p => p.uid)
    .join(' '));
  return useMemo(() => (joined ? joined.split(' ') : []), [joined]);
}

/**
 * Who is sharing their screen, or null — name included, ready to render.
 *
 * A GROUP screen cannot use the `peerSharing` flag: that is dispatched only
 * when `s.peerUid === uid`, so it is always false in a group. Participants
 * carry a per-uid `sharing` flag instead.
 *
 * Selects a STRING for the same reason useParticipantIds does — the
 * participants object is replaced on every mute and every speaker stamp, and a
 * banner must re-render only when the SHARER changes, not 60 times a minute in
 * a full call.
 */
export function useSharingPeer(): { uid: string; name: string } | null {
  const key = useSelect(s => {
    const p = Object.values(s.participants).find(x => x.sharing);
    return p ? p.uid + '|' + (p.name || '') : '';
  });
  return useMemo(() => {
    if (!key) return null;
    // First separator only: a UUID never contains '|', but a display name can,
    // and split() would silently truncate it.
    const i = key.indexOf('|');
    const uid = key.slice(0, i);
    const name = key.slice(i + 1);
    return { uid, name: name || 'Someone' };
  }, [key]);
}

export default {};

/**
 * The uids that belong on screen, at most `size` of them.
 *
 * Active speakers first, then stable roster order — the rule itself is in
 * lib/call/visibleSet.ts, so it can be asserted without React or a device.
 *
 * Selects a JOINED KEY STRING for the same reason useParticipantIds does: the
 * participants object is replaced on any per-peer change, and this must
 * re-render the grid only when the PAGE changes. In a 64-person call the
 * speaker stamps churn constantly and almost never reorder the page; comparing
 * the string is what stops that churn from reaching the tiles.
 *
 * Recomputed on every store change rather than on a timer: a dwell window
 * lapsing with nobody speaking cannot reorder anything on its own (the fallback
 * is roster order, which is what is already rendered), so there is nothing for
 * a tick to discover.
 */
export function useVisibleParticipantIds(size: number): readonly string[] {
  const joined = useSelect(s => {
    const roster = Object.keys(s.participants);
    if (roster.length <= size) return roster.join(' ');
    const spoke: SpeakerTimes = new Map(roster.map(uid => [uid, s.participants[uid].spokeAt]));
    return visibleOrder(roster, spoke, size, Date.now()).join(' ');
  });
  return useMemo(() => (joined ? joined.split(' ') : []), [joined]);
}
