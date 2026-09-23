// lib/call/visibleSet.ts — whose video this device asks the SFU for.
//
// The decision layer only: no LiveKit, no WebRTC, no I/O, no clock of its own.
// lib/call/room.ts owns the actual setSubscribed calls; this owns the rule they
// follow, so the rule can be asserted without a device or a server — the same
// split lib/call/mode.ts uses.
//
// WHY A VISIBLE SET EXISTS AT ALL
//
// A group call rides the SFU, and the client used to subscribe to every
// publication of every participant. That is fine at three people and fatal at
// sixty-four: 63 inbound video decodes per phone is the same quadratic cost
// that mesh was abandoned for, moved from the encoder to the decoder. Fixing it
// means subscribing to what is on screen — roughly a page of tiles — and
// letting the rest arrive as audio only.
//
// WHY THE APP DECIDES AND THE SDK DOES NOT
//
// livekit-client can do this itself with adaptiveStream, which infers
// visibility from its own <VideoTrack> components attaching. This app renders
// remote video with RTCView over a stream URL, so the SDK would see no attached
// views and could pause every tile in a working call. The app knows what is on
// screen; the SDK is guessing. So the app declares it.

/** What a track can be, from this module's point of view. */
export type TrackShape = { kind: 'audio' | 'video'; screenShare: boolean };

/**
 * How long a camera stays subscribed after leaving the visible set.
 *
 * Scrolling one page and back is the common case, and a re-subscribe costs a
 * fresh keyframe — a black tile for as long as the SFU takes to send one.
 * Holding the previous page briefly makes that round trip invisible, at the
 * price of a few seconds of decode that is already paid for.
 */
export const VISIBLE_LINGER_MS = 6_000;

export interface VisibleState {
  /**
   * Whose video is on screen, or `null` for "everyone".
   *
   * `null` is the DEFAULT and it is load-bearing: a caller that never declares
   * a set — every 1:1 call, and any screen that has not been taught about
   * paging — behaves exactly as this code did before a visible set existed.
   * There is no size threshold and no "small call" special case to get wrong.
   */
  visible: Set<string> | null;
  /** uid → epoch ms until which a departed camera is still wanted. */
  lingerUntil: Map<string, number>;
}

export function newVisibleState(): VisibleState {
  return { visible: null, lingerUntil: new Map() };
}

/** Is this participant's camera still wanted? */
export function wantsVideo(st: VisibleState, uid: string, now: number): boolean {
  if (st.visible === null || st.visible.has(uid)) return true;
  const until = st.lingerUntil.get(uid);
  if (until === undefined) return false;
  if (until > now) return true;
  st.lingerUntil.delete(uid);
  return false;
}

/**
 * Does this device want this particular track?
 *
 * Audio: ALWAYS, for everyone, at every call size. A selectively-subscribed
 * audio track is how "nobody could hear the person who spoke up" happens, and
 * audio is not where the scaling problem is — 64 Opus streams is ~1.5 Mbps and
 * the SFU already drops the silent ones.
 *
 * Screen share: ALWAYS. It is what someone deliberately chose to show; dropping
 * it because their tile scrolled off the grid page would be exactly backwards.
 */
export function wantsTrack(st: VisibleState, uid: string, t: TrackShape, now: number): boolean {
  if (t.kind !== 'video') return true;
  if (t.screenShare) return true;
  return wantsVideo(st, uid, now);
}

/** Which published simulcast layer this device is asking the SFU for. */
export type LayerWant = 'low' | 'medium' | 'high';

/**
 * WHICH SIZE, not merely whether.
 *
 * The visible set above decides WHAT is subscribed. It says nothing about the
 * SIZE, and until this existed the answer was "whatever the SFU sends" — the
 * top layer. So a 3x3 grid of 360px-wide tiles pulled nine 720p streams into a
 * phone that renders each of them at a quarter of that. Publishing simulcast
 * layers and then asking for the biggest one wastes the entire point of
 * publishing them: the bandwidth is spent, the decoder is loaded, and the
 * viewer sees no difference because the pixels have nowhere to go.
 *
 * livekit-client would normally do this itself through adaptiveStream, which
 * measures the <VideoTrack> element it rendered. This app draws remote video
 * with RTCView over a stream URL, so the SDK sees no attached view and would be
 * entitled to pause every tile — which is why adaptiveStream is off (room.ts).
 * The choice therefore has to be made from the side that knows, exactly as the
 * subscribe decision already is.
 *
 * THE COUNT IS THE MEASUREMENT. A phone lays its tiles out in a grid across a
 * roughly 1080-1200px panel, so the tile count fixes the tile width without
 * anyone having to thread pixels down from the UI:
 *
 *   1 tile     full width, ~1080px   → the 720p layer
 *   2-4 tiles  a 2-up or 2x2, ~540px → the 360p layer
 *   5+ tiles   3x3 or denser, ≤360px → the 180p layer
 *
 * Deliberately coarse. A tile that is slightly under-served for a moment during
 * a page change is invisible; a wrong THRESHOLD that pulls 720p into a
 * sixty-four-person grid is a thermal problem.
 */
export function qualityForTileCount(tiles: number): LayerWant {
  if (tiles <= 1) return 'high';
  if (tiles <= 4) return 'medium';
  return 'low';
}

/**
 * The layer to request for one publication.
 *
 * Audio has no layers, and a SCREEN SHARE is always asked for at full size: it
 * is published as a single encoding (room.ts sets `simulcast: false` for it),
 * and it carries text, which is the one thing that does not survive being
 * scaled down.
 *
 * `visible === null` means "no paging in this call" — every 1:1, and any screen
 * not taught about pages. One remote face, full screen: 'high' is both the
 * correct answer and the behaviour that existed before this function did, so
 * adopting it changes nothing for 1:1.
 */
export function wantedQuality(st: VisibleState, t: TrackShape): LayerWant {
  if (t.kind !== 'video') return 'high';
  if (t.screenShare) return 'high';
  return qualityForTileCount(st.visible === null ? 1 : st.visible.size);
}

/**
 * Declare the new visible set. Returns nothing — the caller re-applies the
 * subscription for every participant afterwards, because only it knows what
 * publications exist.
 */
export function setVisible(st: VisibleState, ids: string[] | null, now: number): void {
  const next = ids === null ? null : new Set(ids);
  // Anyone LEAVING the set keeps their camera for the linger window; anyone
  // ENTERING it drops the linger they were holding. Computed against the set
  // being replaced, so it must run before the swap.
  if (st.visible !== null) {
    const until = now + VISIBLE_LINGER_MS;
    st.visible.forEach(uid => {
      if (next === null || !next.has(uid)) st.lingerUntil.set(uid, until);
    });
  }
  if (next !== null) next.forEach(uid => st.lingerUntil.delete(uid));
  st.visible = next;
}

// ── ordering: who gets the tiles ──────────────────────────────────────

/**
 * A minimum tile lifetime for someone promoted for speaking.
 *
 * LiveKit's active-speaker signal fires on short energy bursts, so a plain
 * "loudest wins" rule makes the grid flicker through any moment of cross-talk —
 * and every flicker is a subscribe/unsubscribe pair, the most expensive thing
 * this client can do. Three seconds is long enough that a cough does not
 * rearrange the call and short enough that the grid still tracks a conversation.
 */
export const SPEAKER_DWELL_MS = 3_000;

/** uid → when it last became an active speaker. */
export type SpeakerTimes = Map<string, number>;

/**
 * Choose which participants get the `size` tiles on screen.
 *
 * Order: current speakers, then whoever spoke most recently and is still inside
 * their dwell window, then stable roster order. Roster order is the tiebreak
 * rather than anything derived, so a call that nobody is speaking in shows the
 * same faces in the same places on every device and across every re-render.
 */
export function visibleOrder(
  roster: string[], speakers: SpeakerTimes, size: number, now: number,
): string[] {
  if (size <= 0) return [];
  if (roster.length <= size) return roster.slice();
  const rank = new Map(roster.map((uid, i) => [uid, i]));
  const scored = roster.slice().sort((a, b) => {
    const sa = speakers.get(a) ?? 0;
    const sb = speakers.get(b) ?? 0;
    // Only recent speech promotes. An old timestamp must not outrank the roster
    // forever, or the first person to say anything owns a tile for the call.
    const fa = now - sa < SPEAKER_DWELL_MS ? sa : 0;
    const fb = now - sb < SPEAKER_DWELL_MS ? sb : 0;
    if (fa !== fb) return fb - fa;
    return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  });
  return scored.slice(0, size);
}
