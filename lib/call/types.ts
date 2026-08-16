// lib/call/types.ts — the vocabulary of a call.
//
// Deliberately platform-neutral and dependency-free: no react-native, no
// react-native-webrtc, no react. Everything else in lib/call/ imports from
// here, and lib/call/machine.ts can therefore be unit-tested under Node.

/**
 * Lifecycle.
 *
 *   connecting   — acquiring media / applying a remote offer
 *   ringing      — outgoing only: offer sent, waiting for an answer
 *   connected    — media flowing
 *   reconnecting — media WAS flowing and the transport is being rebuilt
 *   ended        — terminal; the screen pops shortly after
 *
 * `reconnecting` is the only addition to the four strings the call screens
 * originally shared, and it exists because the recovery it names was already
 * happening invisibly. lib/call/peer.ts holds a dropped call open for
 * DISCONNECT_GRACE_MS (30 s), retrying an ICE restart every ICE_RETRY_MS and
 * escalating to relay-only — and reported none of it. The snapshot stayed
 * `connected` for the whole outage and then jumped straight to `ended` if the
 * budget ran out, so a recovery that was working looked identical to a frozen
 * call and users hung up before it completed.
 *
 * It is deliberately NOT a terminal or a setup state: you can only reach it
 * FROM `connected` (see machine.ts), because a call that never had media is
 * not reconnecting, it is still connecting.
 */
export type CallStatus = 'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'ended';

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
  | 'no_answer'         // the ring budget expired with no answer
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

// ── ring budget ───────────────────────────────────────────────────────
//
// lib/call/signal.ts sends the offer once and then repeats it RING_REPEATS
// times at RING_INTERVAL_MS, so the LAST offer lands at
// RING_REPEATS * RING_INTERVAL_MS. RING_TIMEOUT_MS must exceed that, or the
// timeout races the final offer and kills a call the callee was about to
// answer.
//
// These live HERE, not in engine.ts, for one reason: engine.ts imports React
// Native and cannot be loaded under Node, so a constant defined there is
// untestable. The relationship between them is the part that can actually be
// got wrong, and ringTimeout.selftest.ts asserts it.

/** Offer repeats after the initial send (lib/call/signal.ts ringAndOffer). */
export const RING_REPEATS = 9;
/** Delay between those repeats, ms. */
export const RING_INTERVAL_MS = 3_000;

/**
 * How long an unanswered outgoing call rings before it ends itself.
 *
 * MUST be greater than RING_REPEATS * RING_INTERVAL_MS (27s). Without this the
 * call sat in `ringing` forever: the repeat loop stopped and nothing ended the
 * call, so the mic and the foreground service stayed held with no failure and
 * no way out but the back gesture.
 */
export const RING_TIMEOUT_MS = 35_000;

/**
 * How long the CALLEE waits for a re-sealed offer after failing to open the
 * first one.
 *
 * When the callee cannot decrypt the sealed offer it resets its own session and
 * asks the caller to re-key (lib/callCrypto.ts openCallOffer). The caller's ring
 * loop notices the epoch move and re-seals, so a fresh, openable envelope is
 * already on its way — it simply has not arrived yet at the instant the first
 * decrypt failed. Failing the call right there threw away a recovery that was
 * seconds from completing, and the next redial failed identically because the
 * user redialled before the re-key landed. That is the loop the two test devices
 * were stuck in.
 *
 * Bounded by two relationships, both asserted in offerRefresh.selftest.ts:
 *
 *   ≥ 2 * RING_INTERVAL_MS — the re-seal is kicked off by one ring tick and
 *     carried by the NEXT one, so anything shorter than two intervals can expire
 *     before the fresh envelope was ever sent.
 *   < RING_TIMEOUT_MS — the caller gives up at RING_TIMEOUT_MS. A callee still
 *     waiting past that point is waiting on a peer that has already hung up.
 */
export const REKEY_WAIT_MS = 9_000;

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

/**
 * How long a call may stay in `reconnecting` before the screens stop promising
 * it is coming back.
 *
 * It used to live in the hand-rolled peer connection (lib/call/peer.ts) as its
 * ICE grace window. That file is gone — the SDK owns reconnection now — but the
 * number is still the UI's contract with the user, so it lives here with the
 * other call constants rather than being re-invented per screen.
 */
export const DISCONNECT_GRACE_MS = 30_000;

export default {};
