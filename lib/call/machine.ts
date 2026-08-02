// lib/call/machine.ts — the call lifecycle, as a pure reducer.
//
// WHY A REDUCER, AND WHY PURE
// ---------------------------
// The transition rules already existed — spread across three screens as inline
// guards like `if (state !== 'connected')`, `if (pcRef.current.signalingState
// !== 'have-local-offer')`, `if (!loggedRef.current)`. They were correct, hard
// won, and impossible to test: reproducing them needs a peer, a socket, a TURN
// server and two phones.
//
// Extracting them here makes the rules explicit and checkable in Node. Nothing
// in this file imports react, react-native or WebRTC; `now` is passed in rather
// than read from the clock, so every transition is deterministic.
//
// INVARIANTS THIS ENCODES (each one is a bug that has bitten this code before)
//   1. `ended` is terminal. A late webrtc_end, an ICE failure racing teardown,
//      or an unmount after hangUp can never resurrect or mutate a finished call.
//   2. Connecting is idempotent. The callee re-sends its answer up to 5x and
//      the caller re-rings up to 9x, so "we are connected" arrives repeatedly;
//      only the first stamps connectedAt. Duration must not restart.
//   3. `ringing` is outgoing-only. An incoming call is answering, not ringing.
//   4. endReason is write-once — the FIRST cause wins. A local hangup that
//      triggers an ICE 'failed' a moment later is still a local hangup.
//   5. Unchanged input returns the SAME object reference, so useSyncExternalStore
//      does not wake subscribers for a no-op.

import {
  IDLE_SNAPSHOT, MAX_CALL_CHAT, MAX_CALL_REACTIONS,
  type CallChatMessage, type CallReaction, type CallRole, type CallSnapshot,
  type EndReason, type Participant,
} from './types';

/** Local device toggles that never affect the lifecycle. */
export type CallFlag = 'muted' | 'speaker' | 'cameraOff' | 'sharing' | 'peerSharing' | 'held';

export type CallEvent =
  /** Outgoing offer is on the wire (also fired on each re-ring — idempotent). */
  | { type: 'offer_sent' }
  /** Our local media is up; `url` feeds the self-preview. */
  | { type: 'local_stream'; url: string | null }
  /** Remote media arrived for a peer — the authoritative "connected" signal. */
  | { type: 'remote_stream'; uid: string; url: string | null; name?: string }
  /** Remote SDP applied. Connects even before the first frame (audio calls). */
  | { type: 'answer_applied' }
  /** A mesh peer left. In 1:1 this ends the call; the engine decides that. */
  | { type: 'peer_left'; uid: string }
  | { type: 'peer_muted'; uid: string; muted: boolean }
  | { type: 'flag'; key: CallFlag; value: boolean }
  /** One line of in-call chat, ours or a peer's. */
  | { type: 'chat'; message: CallChatMessage }
  /** The chat sheet is open — clear the unread badge. */
  | { type: 'chat_read' }
  /** A tapped reaction, ours or a peer's. */
  | { type: 'reaction'; reaction: CallReaction }
  /**
   * Our own uid, once identity resolves. Separate from `startSnapshot` because
   * a call begins rendering BEFORE the cached user is read — the screen must
   * show "connecting" immediately, not after an await — and the reducer needs
   * this to tell a role/hand event about US from one about a peer.
   */
  | { type: 'me'; uid: string }
  /** The server session opened (B2). Carries our own role. */
  | { type: 'session'; sessionId: string; myRole?: CallRole }
  /** A role changed — ours or someone else's. */
  | { type: 'role'; uid: string; role: CallRole }
  /** A hand went up or down. `at` is 0 for lowered. */
  | { type: 'hand'; uid: string; at: number }
  | { type: 'error'; message: string }
  | { type: 'end'; reason: EndReason };

export interface StartParams {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: CallSnapshot['kind'];
  direction: CallSnapshot['direction'];
  transport?: CallSnapshot['transport'];
  /** Our own uid, when known at start. The engine fills it in via 'session'. */
  meId?: string;
}

/** The snapshot a freshly started call begins from. */
export function startSnapshot(p: StartParams): CallSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    status: 'connecting',
    kind: p.kind,
    direction: p.direction,
    transport: p.transport ?? 'mesh',
    chatId: p.chatId,
    peerUid: p.peerUid,
    peerName: p.peerName,
    meId: p.meId ?? '',
    // Video calls default to speaker, voice calls to earpiece — the shipped
    // behaviour of app/videocall.tsx and app/voicecall.tsx respectively.
    speaker: p.kind === 'video',
    participants: {},
  };
}

function withParticipant(
  s: CallSnapshot, uid: string, patch: Partial<Participant>,
): Readonly<Record<string, Participant>> {
  const prev = s.participants[uid];
  const next: Participant = {
    uid,
    name: prev?.name ?? '',
    streamUrl: prev?.streamUrl ?? null,
    role: prev?.role ?? 'speaker',
    muted: prev?.muted ?? false,
    handRaisedAt: prev?.handRaisedAt ?? 0,
    ...patch,
  };
  if (prev && prev.name === next.name && prev.streamUrl === next.streamUrl
      && prev.role === next.role && prev.muted === next.muted
      && prev.handRaisedAt === next.handRaisedAt) {
    return s.participants;   // no-op: keep the reference
  }
  return { ...s.participants, [uid]: next };
}

/**
 * Apply one event. Returns `s` unchanged (same reference) when the event is a
 * no-op, which is the common case during the re-send storms around setup.
 */
export function reduce(s: CallSnapshot, e: CallEvent, now: number): CallSnapshot {
  // Invariant 1: terminal.
  if (s.status === 'ended') return s;

  switch (e.type) {
    case 'offer_sent':
      // Invariant 3 + 2: outgoing only, and never demote a live call back to
      // ringing when a re-ring tick fires after connect.
      if (s.direction !== 'outgoing' || s.status !== 'connecting') return s;
      return { ...s, status: 'ringing' };

    case 'local_stream':
      if (s.localUrl === e.url) return s;
      return { ...s, localUrl: e.url };

    case 'remote_stream': {
      const patch: Partial<Participant> = { streamUrl: e.url };
      if (e.name) patch.name = e.name;
      const participants = withParticipant(s, e.uid, patch);
      const connecting = s.status !== 'connected';
      if (participants === s.participants && !connecting) return s;
      return {
        ...s,
        participants,
        status: 'connected',
        // Invariant 2: stamp once.
        connectedAt: s.connectedAt || now,
      };
    }

    case 'answer_applied':
      if (s.status === 'connected') return s;   // invariant 2
      return { ...s, status: 'connected', connectedAt: s.connectedAt || now };

    case 'peer_left': {
      if (!s.participants[e.uid]) return s;
      const next = { ...s.participants };
      delete next[e.uid];
      return { ...s, participants: next };
    }

    case 'peer_muted': {
      const participants = withParticipant(s, e.uid, { muted: e.muted });
      return participants === s.participants ? s : { ...s, participants };
    }

    case 'flag':
      if (s[e.key] === e.value) return s;
      return { ...s, [e.key]: e.value };

    case 'chat': {
      // Dropping the OLDEST keeps a long call bounded without ever losing the
      // line that just arrived — the opposite choice would silently discard
      // exactly the message the user is waiting to read.
      const chat = [...s.chat, e.message].slice(-MAX_CALL_CHAT);
      // Our own message can't be unread; it's on screen because we sent it.
      return { ...s, chat, chatUnread: e.message.mine ? s.chatUnread : s.chatUnread + 1 };
    }

    case 'chat_read':
      if (!s.chatUnread) return s;
      return { ...s, chatUnread: 0 };

    case 'reaction':
      return { ...s, reactions: [...s.reactions, e.reaction].slice(-MAX_CALL_REACTIONS) };

    case 'me':
      if (s.meId === e.uid) return s;
      return { ...s, meId: e.uid };

    case 'session': {
      const myRole = e.myRole ?? s.myRole;
      if (s.sessionId === e.sessionId && s.myRole === myRole) return s;
      return { ...s, sessionId: e.sessionId, myRole };
    }

    // A role or hand event names a uid that is EITHER a remote participant or
    // ourselves. Our own state does not live in `participants` — we are not our
    // own peer — so both cases must be handled here rather than at every call
    // site in the engine, which would otherwise repeat the same comparison and
    // eventually forget it in one place.
    case 'role': {
      if (e.uid && e.uid === s.meId) {
        return s.myRole === e.role ? s : { ...s, myRole: e.role };
      }
      const participants = withParticipant(s, e.uid, { role: e.role });
      return participants === s.participants ? s : { ...s, participants };
    }

    case 'hand': {
      if (e.uid && e.uid === s.meId) {
        return s.myHandRaisedAt === e.at ? s : { ...s, myHandRaisedAt: e.at };
      }
      const participants = withParticipant(s, e.uid, { handRaisedAt: e.at });
      return participants === s.participants ? s : { ...s, participants };
    }

    case 'error':
      if (s.error === e.message) return s;
      return { ...s, error: e.message };

    case 'end':
      return {
        ...s,
        status: 'ended',
        // Invariant 4: first cause wins.
        endReason: s.endReason ?? e.reason,
      };

    default:
      return s;
  }
}

/**
 * Seconds of connected media, for the call log. 0 when the call never
 * connected — which is exactly what marks it missed/cancelled.
 */
export function durationSeconds(s: CallSnapshot, now: number): number {
  if (!s.connectedAt) return 0;
  return Math.max(0, Math.round((now - s.connectedAt) / 1000));
}

/** True when this call should be logged as a missed incoming call. */
export function wasMissed(s: CallSnapshot): boolean {
  return s.direction === 'incoming' && !s.connectedAt;
}

/**
 * True when hanging up should also tell the callee's device to stop ringing
 * (which converts their ring into a "missed call"). Only meaningful for an
 * outgoing call abandoned before it was answered.
 */
export function shouldCancelRing(s: CallSnapshot): boolean {
  return s.direction === 'outgoing' && !s.connectedAt;
}

export default {};
