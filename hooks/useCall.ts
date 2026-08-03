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

export default {};
