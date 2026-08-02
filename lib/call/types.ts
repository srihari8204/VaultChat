// lib/call/types.ts — the vocabulary of a call.
//
// Deliberately platform-neutral and dependency-free: no react-native, no
// react-native-webrtc, no react. Everything else in lib/call/ imports from
// here, and lib/call/machine.ts can therefore be unit-tested under Node.

/**
 * Lifecycle. These four strings are EXACTLY the ones app/voicecall.tsx and
 * app/videocall.tsx already use, so the migrated screens render the same
 * status text from the same states and nothing user-visible shifts.
 *
 *   connecting — acquiring media / applying a remote offer
 *   ringing    — outgoing only: offer sent, waiting for an answer
 *   connected  — media flowing
 *   ended      — terminal; the screen pops shortly after
 */
export type CallStatus = 'connecting' | 'ringing' | 'connected' | 'ended';

export type CallKind = 'audio' | 'video';

/** Who started it — decides missed-call handling and the log direction. */
export type CallDirection = 'outgoing' | 'incoming';

/**
 * How media is carried. `mesh` is today's full-mesh (1:1 is mesh with a single
 * peer). `sfu` is the seam for a future media server: adding it means adding a
 * Transport implementation, not touching a screen.
 */
export type TransportKind = 'mesh' | 'sfu';

/** Roles exist so webinar/broadcast can land without reshaping the model. */
export type CallRole = 'host' | 'cohost' | 'speaker' | 'audience';

/** Why a call ended — drives the log entry and any user-facing message. */
export type EndReason =
  | 'local_hangup'      // we pressed End
  | 'remote_hangup'     // peer sent webrtc_end
  | 'failed'            // ICE/peer connection failed
  | 'setup_error'       // getUserMedia / signalling / crypto failed
  | 'replaced';         // superseded by another call

export interface Participant {
  uid: string;
  name: string;
  /** RTCView streamURL for this participant's remote media, when flowing. */
  streamUrl: string | null;
  role: CallRole;
  muted: boolean;
  /**
   * Epoch ms this participant raised their hand, or 0.
   *
   * A timestamp, not a boolean, so a host's queue orders by who asked FIRST.
   * With a boolean the order is whatever the roster happens to return, which
   * quietly favours whoever joined earliest — the opposite of fair.
   */
  handRaisedAt: number;
}

/**
 * One line of in-call text chat.
 *
 * In-call chat is NOT the chat thread: it lives for the duration of the call,
 * is never written to the message store, and leaves no trace on either device
 * afterwards. That is deliberate — it is the side-channel you use to paste a
 * link or say "you're muted", not a second place your history hides in.
 *
 * `mine` is resolved at dispatch time so the renderer never has to know its own
 * uid, and `uid` is the SERVER-stamped sender (see lib/call/signal.ts) rather
 * than anything the sender asserted about itself.
 */
export interface CallChatMessage {
  id: string;
  uid: string;
  name: string;
  text: string;
  at: number;
  mine: boolean;
}

/**
 * A tapped reaction, floating up over the video and gone. Held in the snapshot
 * only long enough for the UI to pick it up and animate it; `id` is what lets a
 * memoized burst component animate each one exactly once.
 */
export interface CallReaction {
  id: string;
  uid: string;
  emoji: string;
  at: number;
}

/** Bounds. A call cannot grow unbounded state no matter how long it runs. */
export const MAX_CALL_CHAT = 60;
export const MAX_CALL_REACTIONS = 8;

/**
 * The immutable snapshot screens render from. Replaced wholesale on every
 * change so `useSyncExternalStore` reference checks work; individual selectors
 * (hooks/useCall.ts) then narrow it so a mute toggle does not re-render video.
 *
 * NOTE what is NOT here: elapsed seconds. Duration is derived from
 * `connectedAt` by <CallTimer>, which is what keeps the 1 Hz tick out of the
 * screen's render path.
 */
export interface CallSnapshot {
  status: CallStatus;
  kind: CallKind;
  direction: CallDirection;
  transport: TransportKind;

  chatId: string;
  /** Primary peer (the only one, in 1:1). */
  peerUid: string;
  peerName: string;

  /** Epoch ms media started flowing; 0 until connected. */
  connectedAt: number;
  endReason: EndReason | null;
  /** User-facing setup failure, or null. */
  error: string | null;

  // Local device state.
  muted: boolean;
  speaker: boolean;
  cameraOff: boolean;
  sharing: boolean;
  /** The remote side is sharing THEIR screen (screen_share_start). */
  peerSharing: boolean;
  held: boolean;

  localUrl: string | null;
  /** Keyed by uid. In 1:1 this holds exactly one entry once media arrives. */
  participants: Readonly<Record<string, Participant>>;

  /** In-call chat, oldest first, capped at MAX_CALL_CHAT. */
  chat: readonly CallChatMessage[];
  /** Messages that arrived while the chat sheet was closed. */
  chatUnread: number;
  /** Recent reactions, capped at MAX_CALL_REACTIONS. */
  reactions: readonly CallReaction[];

  /**
   * The server-side call id (calls.id), or '' when this call has no session —
   * the flag is off, the server isn't migrated, or the request didn't land.
   * Everything role-related is inert without it, which is the graceful case.
   */
  sessionId: string;
  /** OUR role. Drives whether the moderation controls are shown at all. */
  myRole: CallRole;
  /** Epoch ms we raised our own hand, or 0. */
  myHandRaisedAt: number;
  /** Our own uid, so the reducer can tell "me" from a peer. */
  meId: string;
}

export const IDLE_SNAPSHOT: CallSnapshot = Object.freeze({
  status: 'ended',
  kind: 'audio',
  direction: 'outgoing',
  transport: 'mesh',
  chatId: '',
  peerUid: '',
  peerName: '',
  connectedAt: 0,
  endReason: null,
  error: null,
  muted: false,
  speaker: false,
  cameraOff: false,
  sharing: false,
  peerSharing: false,
  held: false,
  localUrl: null,
  participants: Object.freeze({}),
  chat: Object.freeze([]),
  chatUnread: 0,
  reactions: Object.freeze([]),
  sessionId: '',
  myRole: 'speaker',
  myHandRaisedAt: 0,
  meId: '',
});

export default {};
