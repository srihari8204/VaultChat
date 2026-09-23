// lib/call/room.ts — the call's media, owned by the LiveKit SDK.
//
// WHY THIS REPLACES THE HAND-ROLLED PIPELINE
// ------------------------------------------
// The previous version captured media itself, published raw MediaStreamTracks,
// attached RTCFrameCryptors by walking getSenders()/getReceivers(), and listened
// for TrackSubscribed to decide a call was up. Every one of those was a seam
// where the app and the SDK could disagree, and on device they did: tracks
// published with no source (refused), cryptors attached to a connection that had
// no senders yet, and a subscribe event that never reached the app while media
// flowed through the SFU underneath.
//
// So the SDK owns all of it now:
//   capture      room.localParticipant.setMicrophoneEnabled / setCameraEnabled
//   encryption   RNE2EEManager + RNKeyProvider — the SDK attaches a cryptor to
//                every sender and receiver as they appear, which is the part
//                that cannot be done correctly from outside
//   subscribe    autoSubscribe, and the Room is handed to the UI so LiveKit's
//                own <VideoTrack> renders it
//
// What is left here is the small amount that is genuinely ours: which room,
// which key, and turning SDK events into the app's call state.

import { Dimensions, PixelRatio } from 'react-native';
import { AudioSession, registerGlobals, setLogLevel } from '@livekit/react-native';
import { screenCaptureSize, screenCaptureBitrate } from './screenCapture';
import { shouldRelax, relaxedEncoding } from './sharePolicy';
import { newVisibleState, setVisible as setVisibleState, wantsTrack, wantedQuality } from './visibleSet';
import { simulcastLayers } from './mode';
import { getIceConfig } from '../iceConfig';
import { enableFrameCrypto, type FrameCryptoHandle } from './frameCrypto';
import { CALL_FRAME_E2EE, MEDIA_KEY_WAIT_MS } from './types';
import { Room, RoomEvent, Track, VideoPresets, VideoQuality, type RemoteParticipant, type RemoteTrackPublication } from 'livekit-client';

// livekit-client is a browser library: registerGlobals installs the React Native
// WebRTC implementations under the names it expects. Must run before a Room is
// constructed, and exactly once.
let globalsReady = false;
function ensureGlobals(): void {
  if (globalsReady) return;
  registerGlobals();
  // The SDK's own trace, kept ON.
  //
  // A call that joins, sees the other participant, and never receives their
  // media is invisible at the default level: the SDK simply says nothing for
  // thirty seconds. These lines are what tell the difference between "the
  // server never offered us the track" and "we answered and ICE never came
  // up" — and that difference is a different fix. Volume is a few dozen lines
  // per call, and only while a call exists.
  setLogLevel('debug');
  globalsReady = true;
}

/**
 * Is this a phone that cannot afford a third simulcast encode?
 *
 * A PROXY, deliberately, and a crude one: total physical pixels. There is no
 * CPU or thermal-headroom API in React Native, `navigator.hardwareConcurrency`
 * is not reliably installed by registerGlobals, and a device-model allowlist is
 * a maintenance burden with a long tail for what is a two-way decision. Panel
 * resolution tracks device class closely enough — sub-1080p phones are budget
 * phones — and the failure mode is mild in both directions: a misjudged capable
 * phone publishes one fewer layer, a misjudged budget phone runs warmer.
 *
 * ponytail: pixel-count proxy for device tier. If thermal throttling shows up
 * on devices this calls capable, take the tier from a measured encode instead
 * (the screen-share path already reads qualityLimitationReason).
 */
function isLowEndDevice(): boolean {
  try {
    const px = PixelRatio.get();
    const scr = Dimensions.get('screen');
    return Math.round(scr.width * px) * Math.round(scr.height * px) < 1920 * 1080;
  } catch { return true; }   // unknown device: assume the cheaper setting
}

export interface CallRoomEvents {
  /** Someone joined or left. `count` is the total including us. */
  onParticipants(count: number, joined: RemoteParticipant | null, left: RemoteParticipant | null): void;
  /**
   * Remote media, ready to render. `url` is an RTCView stream URL — the call
   * screens already render one of those, so the SDK owning the pipeline does
   * not cost a UI rewrite.
   */
  onRemote(uid: string, url: string | null, kind: 'audio' | 'video', screen?: boolean): void;
  /** Our own camera, for the self-preview. The SDK captures it now, not us. */
  onLocal(url: string | null): void;
  /**
   * OUR screen share stopped — including when the user stopped it from the
   * Android notification rather than from our button. Everything that has to be
   * undone (the sharing flag, the capture guard, telling the peer) hangs off
   * this, so there is exactly one teardown path however the share ended.
   */
  onScreenShareStopped(): void;
  /** The room ended or the transport gave up. */
  onClosed(): void;
  /**
   * The SDK lost the transport and is rebuilding it. OPTIONAL, and optional on
   * purpose: every existing caller predates these two, and a call that ignores
   * them behaves exactly as it did before.
   *
   * The machine and both call screens have handled `reconnecting` since they
   * were written — `voicecall.tsx` even carries a comment saying the branch
   * must exist — but nothing ever dispatched it, because these two events were
   * the only things that could and they were never subscribed. The status was
   * unreachable, so a call being rebuilt looked identical to a healthy one.
   *
   * NOT a retry hook. livekit-client owns reconnection via its own policy;
   * these only report what it is already doing.
   */
  onReconnecting?(): void;
  /** The SDK rebuilt the transport. Pairs with onReconnecting. */
  onReconnected?(): void;
  /**
   * The media key never arrived. OPTIONAL, like the two above — a caller that
   * ignores it sees the room disconnect, which is the same outcome with a
   * worse explanation.
   *
   * This device joined, subscribed, and published NOTHING because it had no key
   * to encrypt with (see the fail-closed rule below). Without a deadline that
   * state is permanent: a dead ratchet on the minter's side means the sealed
   * key is never openable, and the call sits connected and silently mute for as
   * long as the user is willing to stare at it. Bounded by MEDIA_KEY_WAIT_MS.
   */
  onMediaKeyTimeout?(): void;
  /**
   * Who the SFU says is speaking, whenever that set changes. OPTIONAL, like the
   * two above and for the same reason: a caller that ignores it behaves exactly
   * as it did before this existed — which is what every 1:1 screen does.
   */
  onActiveSpeakers?(uids: string[]): void;
}

export interface CallRoom {
  /** Handed to the UI so LiveKit's own components render the tracks. */
  room: Room;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  flipCamera(): Promise<void>;
  setScreenShare(on: boolean): Promise<void>;
  /** Silence every remote participant (call-waiting hold). */
  setRemoteAudible(on: boolean): void;
  /**
   * Declare whose VIDEO this device wants — the tiles actually on screen.
   *
   * `null` (the default, and what a caller who never calls this gets) means
   * "everyone", which is byte-identical to the behaviour before there was a
   * visible set. A 1:1 or small group therefore behaves exactly as it did.
   *
   * Audio is NEVER affected: see the note in joinCallRoom.
   */
  setVisible(ids: string[] | null): void;
  /**
   * Install or ROTATE the frame-encryption key.
   *
   * The first key is what releases publishing: with CALL_FRAME_E2EE on and no
   * key at join, nothing at all is published (see JoinArgs.e2eeKey), so this is
   * the call's "you may now send media". Later calls rotate — which is what
   * makes a departed participant go dark, since the SFU keeps forwarding to
   * anyone it has and has no idea who holds a key.
   *
   * Rejects if the cryptor cannot be created: the caller must end the call
   * rather than fall back to sending frames the server can read.
   */
  setMediaKey(key: Uint8Array): Promise<void>;
  leave(): Promise<void>;
}

export interface JoinArgs {
  url: string;
  token: string;
  video: boolean;
  /** False for a broadcast audience — subscribe only. */
  publish: boolean;
  /**
   * 32-byte frame-encryption key, or null when we do not have one YET.
   *
   * Explicit and required, as lib/golive/room.ts makes it, so the decision is
   * visible at the call site. null does NOT mean "unencrypted": with
   * CALL_FRAME_E2EE on it means "join and subscribe, publish nothing", and the
   * key arrives later through setMediaKey. Only the participant who mints the
   * key has it at join time; everyone else is briefly in this state.
   */
  e2eeKey: Uint8Array | null;
  events: CallRoomEvents;
}

export async function joinCallRoom(a: JoinArgs): Promise<CallRoom> {
  ensureGlobals();

  // FRAME ENCRYPTION IS BACK ON — it is the only thing that makes an SFU call
  // end to end.
  //
  // It was removed on 2026-08-16 because every hard failure of that day lived
  // near it: tracks the SDK refused to publish, cryptors attached to connections
  // that had no senders yet, one-way audio. Those causes were found and fixed
  // elsewhere in this file (dual peer connection, explicit setSubscribed, the
  // reconcile loop), and lib/golive/room.ts has run the same RTCFrameCryptor in
  // production since. What was actually wrong was the ATTACH TIMING, which is
  // why the attach below happens on every publish and every subscribe rather
  // than once at join — a sender or receiver does not exist until its track
  // does, and "nothing attached" looks exactly like "no encryption".
  //
  // See ./types.ts CALL_FRAME_E2EE for the fail-closed rule.
  // FETCH TURN BEFORE ANYTHING ELSE, so the network round trip overlaps the
  // Room construction instead of adding to call setup time. Same pattern as
  // lib/golive/room.ts, which has done this correctly all along.
  const iceConfigPromise = getIceConfig();

  const room = new Room({
    // SINGLE PEER CONNECTION OFF. This is the fix for one-way audio.
    //
    // In single-PC mode the server pre-allocates media sections at join, so the
    // SDK sees incoming transceivers immediately — and livekit-client defers
    // any track that arrives while the room is still `Connecting`, waiting for
    // RoomEvent.Connected before handling it. Captured on device:
    //
    //   17:20:47.705  connection state changed: connecting -> connected
    //   17:20:47.708  deferring on track for later   (x6)
    //
    // The deferral registers `once(RoomEvent.Connected)` three milliseconds
    // AFTER that event has already been emitted, so the handler never runs and
    // those six slots are dead for the lifetime of the room. The other side's
    // audio then arrives on exactly one of them: subscribed on the server,
    // never surfaced to the app.
    //
    // It only bites whoever joins FIRST, because the second joiner's tracks are
    // resolved during its initial negotiation — which is why every call was
    // one-way with the CALLER as the deaf one, on both handsets, in both
    // directions, with and without frame encryption.
    //
    // Dual PC (publisher + subscriber) is the path the SDK has always used and
    // does not pre-allocate, so nothing is ever deferred. It costs one extra
    // peer connection per participant; a working call is worth more.
    singlePeerConnection: false,
    // adaptiveStream OFF, deliberately — and it STAYS off now that the app
    // declares a visible set (see `wantsVideo` below).
    //
    // It pauses video whose view the SDK thinks is invisible, and it learns
    // that by watching LiveKit's own <VideoTrack> components attach. This app
    // renders remote video with RTCView over a stream URL, so the SDK sees NO
    // attached views at all and would be entitled to pause EVERY tile — which
    // is the frozen-frame-on-a-working-call bug, at full call scale.
    //
    // The visible set does the same job from the side that actually knows: the
    // app says which tiles are on screen and the subscription follows. So this
    // is not "the flag we could not turn on" — it is the wrong mechanism for a
    // UI that does not use the SDK's renderer. dynacast still stops sending
    // layers nobody subscribes to, which is where the upstream saving is.
    adaptiveStream: false,
    dynacast: true,
    // ONE CAMERA STREAM, SEVERAL SIZES — the other half of what makes a large
    // call work.
    //
    // The visible set stops this device DECODING sixty-four videos. Simulcast
    // is what stops it being SENT the wrong one: with layers published, the SFU
    // hands each subscriber a size that suits the tile they are drawing, and
    // dynacast (above) stops sending any layer nobody asked for. Without it a
    // phone drawing a 120px tile is still shipped a 720p stream.
    //
    // The layer COUNT is a thermal decision, not a quality one: encoding three
    // streams at once is what a budget phone cannot sustain, so it publishes
    // two. lib/call/mode.ts owns that rule (simulcastLayers) and this supplies
    // the device half of it.
    //
    // Screen share is untouched — setScreenShare passes its own publish options
    // with `simulcast: false`, which override these. That is deliberate and
    // device-proven: odd panel geometry plus a hardware encoder that silently
    // emits nothing means one encoder to satisfy, not three.
    // WHAT THE CAMERA ACTUALLY CAPTURES.
    //
    // This was UNSET, and unset does not mean "sensible default" — it means
    // whatever the SDK happens to pick on this handset. A face arriving soft is
    // usually decided here, before a single frame reaches the encoder: you
    // cannot sharpen what was never captured.
    //
    // 720p on a capable phone, 540p on a budget one. Higher is not better on a
    // phone call — 1080p triples the pixels a budget encoder must chew for a
    // head-and-shoulders shot nobody renders larger than a tile.
    videoCaptureDefaults: {
      resolution: isLowEndDevice() ? VideoPresets.h540.resolution : VideoPresets.h720.resolution,
    },
    publishDefaults: {
      simulcast: true,
      // main layer + the extras listed = simulcastLayers() total.
      videoSimulcastLayers: simulcastLayers('sfu', isLowEndDevice())
        >= 3 ? [VideoPresets.h180, VideoPresets.h360] : [VideoPresets.h180],
      // SPEND THE BITRATE ON SHARPNESS, NOT ON FRAMES.
      //
      // Also previously unset, so the top layer ran on the SDK's generic camera
      // encoding. A video call is a head and shoulders: the subject barely
      // moves, so 24 fps is indistinguishable from 30 to the person watching,
      // and the frames it saves go into detail on the face instead.
      videoEncoding: {
        maxBitrate: isLowEndDevice() ? 800_000 : 1_700_000,
        maxFramerate: 24,
      },
    },
  });

  const urlOf = (t: any): string | null => {
    try { return t?.mediaStream?.toURL?.() ?? null; } catch { return null; }
  };
  // Every SDK callback is wrapped: a throw here unwinds into livekit-client's
  // own event emitter, and the last version of this file lost a whole call that
  // way — media flowing, app still showing "ringing".
  const safe = (what: string, fn: () => void) => {
    try { fn(); } catch (err) { console.warn(`[call] room ${what} handler threw —`, (err as any)?.message ?? err); }
  };
  const remote = (track: any, p: RemoteParticipant, screen = false) =>
    safe('remote', () => a.events.onRemote(
      p.identity, urlOf(track), track?.kind === Track.Kind.Video ? 'video' : 'audio', screen));

  // ── WHAT THIS DEVICE SUBSCRIBES TO ────────────────────────────────
  //
  // ASK FOR THE TRACK, do not wait to be given it.
  //
  // autoSubscribe is on, and on device it was not enough: the participant who
  // joined the room FIRST saw the second one arrive and then never received a
  // single frame — no subscribe event, nothing in the SDK log, while the other
  // side heard everything. One-way audio on every call, with the caller always
  // being the deaf one because the caller joins first.
  //
  // setSubscribed(true) is idempotent and explicit: it tells the server we want
  // this publication, whatever the room-level default did or did not do. That
  // is why the `true` case below is UNCONDITIONAL and is not gated on
  // pub.isSubscribed — the whole point is that isSubscribed was not to be
  // trusted. Only the `false` case is gated, so we never spam unsubscribes.
  //
  // WHAT THE VISIBLE SET DOES AND DOES NOT COVER
  //
  //   audio         ALWAYS subscribed, for everyone, at every call size. A
  //                 selectively-subscribed audio track is how "nobody could
  //                 hear the person who spoke up" happens, and audio is not
  //                 where the scaling problem is: 64 Opus streams is ~1.5 Mbps
  //                 and the SFU already drops silent ones. The video decoders
  //                 are the cost.
  //   screen share  ALWAYS subscribed. It is the thing the person deliberately
  //                 chose to show; dropping it because their tile scrolled off
  //                 the grid page would be exactly backwards.
  //   camera        follows the visible set.
  //
  // `visible === null` means everyone, and is what a caller who never calls
  // setVisible gets — so 1:1 and small calls emit precisely the calls they
  // emitted before this existed.

  // The rule itself lives in ./visibleSet, which has no SDK in it and can be
  // asserted without a device. This is only the part that touches the SDK.
  const vis = newVisibleState();

  // Declared up here because the event handlers below close over it, and they
  // are registered before connect(). Null until a media key exists.
  let crypto: FrameCryptoHandle | null = null;
  /**
   * Cover every sender and receiver that exists RIGHT NOW.
   *
   * Called from inside SDK event handlers, so it never throws back into them —
   * the last time something in here unwound into livekit-client's emitter it
   * cost a whole call (see `safe` above). attach() is idempotent: it skips
   * senders and receivers it has already covered, so calling it on every event
   * is correct rather than merely cheap.
   */
  const attachCryptors = (why: string) => {
    try { crypto?.attach(); } catch (err) {
      console.warn('[call] frame cryptor attach failed on', why, '—', (err as any)?.message ?? err);
    }
  };

  /** ./visibleSet speaks in sizes; the SDK speaks in this enum. */
  const QUALITY = { low: VideoQuality.LOW, medium: VideoQuality.MEDIUM, high: VideoQuality.HIGH };

  /** Bring one publication in line with what this device wants. */
  const applyWant = (pub: RemoteTrackPublication, uid: string) => {
    const shape = {
      kind: pub.kind === Track.Kind.Video ? 'video' as const : 'audio' as const,
      screenShare: pub.source === Track.Source.ScreenShare,
    };
    const want = wantsTrack(vis, uid, shape, Date.now());
    // No keyframe request on re-subscribe: the SFU sends one when a
    // subscription starts, and livekit-client exposes no client-side PLI. The
    // linger window in ./visibleSet is what covers the gap.
    if (want) {
      try { pub.setSubscribed(true); } catch {}
      // AND AT WHAT SIZE. Subscribing said yes; this says how big, and without
      // it every tile in a 64-person grid was served the 720p layer it cannot
      // draw. Set on every pass rather than only on change: setVisible and the
      // 2-second reconcile both route through here, so a page flip re-sizes
      // what it re-subscribes, with no separate bookkeeping to drift.
      //
      // Best-effort. An SDK that refuses the request leaves the call exactly as
      // it behaved before this line existed — a working call at the wrong size,
      // never a broken one.
      if (shape.kind === 'video') {
        try { pub.setVideoQuality(QUALITY[wantedQuality(vis, shape)]); } catch {}
      }
      return;
    }
    if (pub.isSubscribed) { try { pub.setSubscribed(false); } catch {} }
  };

  const wantAll = (p: RemoteParticipant) => {
    p.trackPublications.forEach(pub => applyWant(pub as RemoteTrackPublication, p.identity));
  };

  room.on(RoomEvent.ParticipantConnected, p => {
    console.warn('[call] room: joined', p.identity, '— now', room.remoteParticipants.size + 1);
    wantAll(p);
    safe('participants', () => a.events.onParticipants(room.remoteParticipants.size + 1, p, null));
  });
  room.on(RoomEvent.TrackPublished, (pub, p) => {
    console.warn('[call] room: remote published', pub.kind, 'by', p.identity, '— reconciling');
    applyWant(pub, p.identity);
  });
  room.on(RoomEvent.ParticipantDisconnected, p => {
    console.warn('[call] room: left', p.identity, '— now', room.remoteParticipants.size + 1);
    safe('participants', () => a.events.onParticipants(room.remoteParticipants.size + 1, null, p));
  });
  room.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    // A RECEIVER EXISTS ONLY ONCE ITS TRACK IS SUBSCRIBED, so this is the
    // moment its cryptor can be created. Miss it and every incoming frame stays
    // ciphertext — silence, or video that is noise.
    attachCryptors('subscribe');
    // The URL matters as much as the event: a subscribe with no stream URL
    // renders as a frozen tile, which looks exactly like a call that hung.
    const u = urlOf(track);
    const screen = pub.source === Track.Source.ScreenShare;
    console.warn('[call] room: subscribed', screen ? 'SCREEN' : track.kind, 'from', p.identity,
      u ? 'url ok' : 'NO STREAM URL');
    remote(track, p, screen);
  });
  // A screen share that STOPS has to give the camera back, or the viewer keeps
  // staring at the last frame of a share that ended.
  room.on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
    if (pub.source !== Track.Source.ScreenShare) return;
    console.warn('[call] room: screen share ended by', p.identity);
    safe('remote', () => a.events.onRemote(p.identity, null, 'video', true));
  });
  room.on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) =>
    console.warn('[call] room: SUBSCRIBE FAILED', sid, 'from', p.identity, '—', String(reason)));
  room.on(RoomEvent.LocalTrackUnpublished, pub => {
    if (pub.source !== Track.Source.ScreenShare) return;
    console.warn('[call] room: our screen share stopped');
    safe('screenshare', () => a.events.onScreenShareStopped());
  });
  room.on(RoomEvent.LocalTrackPublished, pub => {
    // The other half of the attach rule, and the one that must come FIRST here:
    // a sender does not exist until publishTrack resolves, and this covers every
    // later publication too — the camera coming back on, a screen share.
    attachCryptors('publish');
    if (pub.kind !== Track.Kind.Video) return;
    safe('local', () => a.events.onLocal(urlOf(pub.track)));
  });
  room.on(RoomEvent.Disconnected, reason => {
    console.warn('[call] room: disconnected —', String(reason));
    safe('closed', () => a.events.onClosed());
  });
  // Deliberately NOT tearing anything down here: the transport is still being
  // rebuilt, and dropping tracks or leaving on Reconnecting is what would turn
  // a survivable blip into a dead call. Same reasoning as lib/golive/room.ts.
  room.on(RoomEvent.Reconnecting, () => {
    console.warn('[call] room: reconnecting');
    safe('reconnecting', () => a.events.onReconnecting?.());
  });
  room.on(RoomEvent.Reconnected, () => {
    console.warn('[call] room: reconnected');
    // A reconnect rebuilds both transports, and the new senders and receivers
    // come up BARE. Without this, a call survives the blip and is plaintext for
    // the rest of its life.
    attachCryptors('reconnect');
    safe('reconnected', () => a.events.onReconnected?.());
  });
  room.on(RoomEvent.ConnectionStateChanged, st => console.warn('[call] room state →', st));
  // Not logged: this fires several times a second in a busy call, and a log
  // line per change would bury the ones that diagnose a broken call.
  room.on(RoomEvent.ActiveSpeakersChanged, ps => safe('speakers', () =>
    a.events.onActiveSpeakers?.(ps.map(p => p.identity))));

  // The OS audio session: routing, focus, and the in-call volume stream. The
  // SDK owns this too — mixing it with a second audio-session manager is what
  // produced calls that connected and played through the wrong output.
  await AudioSession.startAudioSession();

  // TURN REACHES THE SFU PATH AT LAST.
  //
  // This connected with no rtcConfig, so livekit-client used only the ICE
  // servers the LiveKit SERVER advertises — and livekit.yaml has
  // `turn: enabled: false` (deliberately, to reuse the host's coturn). The
  // result: clients gathered host and srflx candidates and ZERO relay ones.
  // Measured on device: 42 host, 19 srflx, 0 relay. On this network STUN
  // happened to be enough, so it worked and hid the hole — but behind a
  // symmetric NAT, where relay is the ONLY thing that works, a call could
  // never connect at all.
  //
  // lib/golive/room.ts has passed rtcConfig since it was written and has a
  // selftest pinning it; the calling path simply never got the same line.
  //
  // ICE priority is untouched: host and srflx pairs are tried first by the
  // protocol, relay is last resort, so a normal network behaves exactly as
  // before. getIceConfig() degrades to the last good config, then to STUN only,
  // which is what this was already working with — and carries
  // `iceTransportPolicy: 'relay'` when the user has asked for their IP to be
  // withheld (lib/callPrefs). That is the ONE case where it rejects rather than
  // degrades: relay-only with no relay available gathers nothing at all, and
  // quietly falling back to a direct path would leak the address the user
  // switched the preference on to hide. The message is user-facing and says
  // "try again", because it is transient.
  let iceConfig;
  try { iceConfig = await iceConfigPromise; }
  catch (err) { await AudioSession.stopAudioSession().catch(() => {}); throw err; }
  await room.connect(a.url, a.token, { autoSubscribe: true, rtcConfig: iceConfig });

  // ── FRAME E2EE, AND WHAT IT GATES ─────────────────────────────────
  //
  // FAIL CLOSED, stated once, here (the rule itself is in ./types.ts):
  //
  //   cryptor unavailable  → disconnect and throw. A call that believes it is
  //                          encrypted and is not must never proceed quietly;
  //                          lib/golive/room.ts has refused on exactly this
  //                          since it was written.
  //   no key yet           → publish NOTHING. Not "publish and encrypt later":
  //                          the frames sent in that window would be readable by
  //                          the server, which is the whole thing this prevents.
  //                          Everyone but the minting participant passes through
  //                          this state for one relay round trip.
  //   attached nothing     → disconnect and throw. Publishing with zero cryptors
  //                          is the SILENT downgrade: the call works perfectly
  //                          and the server can read it.
  let publishedOwn = false;
  // What the USER has asked for, which can diverge from what is published while
  // the key is awaited: a mute pressed during that window must survive it, or
  // the microphone comes up live under a UI that says muted.
  let wantMic = true;
  let wantCam = a.video;
  const publishOwn = async (): Promise<void> => {
    if (publishedOwn || !a.publish) return;
    publishedOwn = true;
    await room.localParticipant.setMicrophoneEnabled(wantMic);
    if (a.video && wantCam) {
      await room.localParticipant.setCameraEnabled(true);
      await tuneCameraSender('publish');
    }
    // LocalTrackPublished already attached; this is the RECEIPT, not the attach.
    // It has to be asked for here because zero is only meaningful once something
    // has actually been published.
    if (crypto) {
      crypto.attach();
      if (!crypto.active) {
        await room.disconnect().catch(() => {});
        throw new Error('Secure calling is unavailable on this device');
      }
    }
    console.warn('[call] room: publishing', a.video ? 'mic+camera' : 'mic',
      crypto ? '(frame E2EE on)' : '(NOT frame encrypted)');
  };

  // The deadline on "joined, subscribed, publishing nothing, waiting for a key".
  let keyWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const stopKeyWait = () => { if (keyWaitTimer) { clearTimeout(keyWaitTimer); keyWaitTimer = null; } };

  const installKey = async (key: Uint8Array): Promise<void> => {
    stopKeyWait();
    if (crypto) { await crypto.setKey(key); return; }   // rotation
    // BOTH transports: LiveKit publishes on one peer connection and subscribes
    // on another, so attaching to one encrypts what we send and leaves what we
    // receive undecryptable. A getter because a reconnect replaces them.
    const pcs = () => {
      const e: any = (room as any).engine;
      return [
        e?.pcManager?.publisher?.pc ?? e?.publisher?.pc,
        e?.pcManager?.subscriber?.pc ?? e?.subscriber?.pc,
      ].filter(Boolean);
    };
    const h = await enableFrameCrypto(pcs, room.localParticipant.identity, key);
    if (!h.active) {
      await room.disconnect().catch(() => {});
      throw new Error('Secure calling is unavailable on this device');
    }
    crypto = h;
    attachCryptors('key');     // whatever is already subscribed
    await publishOwn();
  };

  if (a.e2eeKey) await installKey(a.e2eeKey);
  else if (!CALL_FRAME_E2EE) await publishOwn();
  else {
    // BOUNDED, at last. The wait used to have no deadline: if the minter's seal
    // never landed (a dead ratchet session — the same failure that would
    // already have broken the chat thread) this device stayed connected and
    // silently mute forever, which looks exactly like a working call that
    // nobody can hear. Fail the call instead, with a reason the user can act on
    // and the log can be grepped for.
    console.warn('[call] room: connected, holding media until the key arrives');
    keyWaitTimer = setTimeout(() => {
      keyWaitTimer = null;
      if (crypto) return;                       // the key landed; nothing to do
      console.warn('[call] MEDIA_KEY_TIMEOUT — no media key after',
        MEDIA_KEY_WAIT_MS / 1000, 's; failing the call rather than staying silently mute');
      // Told BEFORE the disconnect, so the caller's reason wins over the
      // generic onClosed that RoomEvent.Disconnected is about to fire.
      safe('keytimeout', () => a.events.onMediaKeyTimeout?.());
      void room.disconnect().catch(() => {});
    }, MEDIA_KEY_WAIT_MS);
  }
  console.warn('[call] room: connected, publishing',
    publishedOwn ? (a.video ? 'mic+camera' : 'mic') : 'nothing');

  // ── RECONCILE, DO NOT TRUST EVENTS ────────────────────────────────
  //
  // Twice in one day a call broke because an SDK event never reached the app
  // while the media itself was fine:
  //
  //   • the first joiner never got TrackSubscribed for the second joiner's
  //     audio (single-PC track deferral) — one-way calls;
  //   • a screen share published and confirmed by the server produced NO
  //     TrackPublished on the other device at all — "sharing" with nothing
  //     shared.
  //
  // Both are invisible from inside an event handler, because the bug IS the
  // missing event. So the room's actual state is re-read on a timer and the app
  // is told what is really there: anything unsubscribed gets asked for again,
  // anything subscribed is re-surfaced. The store no-ops identical values, so a
  // healthy call costs one map walk every two seconds and dispatches nothing.
  //
  // This is a floor, not a replacement: the events still drive the fast path,
  // and they are what makes a call feel instant. This is what stops a dropped
  // one from costing the whole call.
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  const reconcile = () => {
    let remotes = 0;
    room.remoteParticipants.forEach(p => {
      remotes++;
      p.trackPublications.forEach(pub => {
        // Also where a lapsed linger window is collected: applyWant re-reads
        // wantsVideo every tick, so a camera that dropped out of the visible
        // set is unsubscribed on the next pass. No second timer.
        applyWant(pub as RemoteTrackPublication, p.identity);
        if (pub.isSubscribed && pub.track) {
          remote(pub.track, p, pub.source === Track.Source.ScreenShare);
        }
      });
    });
    if (remotes > 0) safe('participants', () => a.events.onParticipants(remotes + 1, null, null));
  };
  reconcile();
  const reconcileTimer = setInterval(reconcile, 2000);
  // Our own camera may already be published by the time the listener above was
  // attached, and the self-preview would then stay black for the whole call.
  const ownCam = room.localParticipant.getTrackPublication(Track.Source.Camera);
  if (ownCam?.track) safe('local', () => a.events.onLocal(urlOf(ownCam.track)));

  // Which way the camera currently points. Ours because the SDK's own copy is
  // undefined for a LiveKit-created track — see flipCamera below. A call starts
  // on the front camera, which is what setCameraEnabled gives us.
  let facing: 'user' | 'environment' = 'user';

  /**
   * May a track START SENDING right now?
   *
   * Publishing is not only publishOwn's business: unmuting, turning the camera
   * back on and starting a screen share all publish, and any of them can be
   * pressed during the window where the key has not arrived yet. Without this
   * they would publish around the gate and hand the SFU readable frames — the
   * exact thing the gate exists to prevent. Turning something OFF is never
   * gated.
   */
  const mayPublish = () => !CALL_FRAME_E2EE || !!crypto;

  /**
   * KEEP THE FACE SHARP WHEN THE NETWORK TIGHTENS.
   *
   * WebRTC's default for a camera track is to protect frame rate and throw away
   * resolution the moment the uplink dips — the right call for a football
   * match, the wrong one for a person talking. It is why a video call starts
   * crisp and quietly turns to mush a minute in, without ever dropping.
   *
   * Screen share already makes this exact trade (see setScreenShare, tuned for
   * text). A face is the same kind of subject: mostly still, judged on detail.
   * So it gets the same two knobs, for the same reason.
   *
   *   contentHint 'detail'   bias the encoder toward spatial detail
   *   degradationPreference  give up frames, never resolution
   *     'maintain-resolution'
   *
   * Applied on EVERY camera publish, not once at join: unmuting the camera and
   * flipping it both produce a NEW sender, and a sender that was never tuned is
   * indistinguishable from one that was, right up until the network dips.
   *
   * The simulcast encodings are deliberately left alone. `params.encodings[0]`
   * is the LOWEST layer, not the highest — the value screen share edits safely
   * because it publishes a single encoding. Touching it here would shrink the
   * thumbnail layer and leave the layer that carries the face untouched, which
   * is the opposite of the intent. The top layer is already set by
   * publishDefaults.videoEncoding above.
   *
   * Best-effort throughout: React Native's WebRTC does not implement every
   * knob, and an untuned camera is still a working camera.
   *
   * A FUNCTION DECLARATION, deliberately: publishOwn is defined above this
   * point but RUNS before it (the key-install path calls it), so a `const`
   * arrow here would be in its temporal dead zone and throw on the first
   * publish of every call. Hoisting is what makes the placement free.
   */
  async function tuneCameraSender(why: string): Promise<void> {
    try {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const track: any = pub?.track;
      if (!track) return;
      try { if (track.mediaStreamTrack) track.mediaStreamTrack.contentHint = 'detail'; } catch {}
      const sender = track.sender;
      const params = sender?.getParameters?.();
      if (!params) return;
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[call] camera tune failed on', why, '—', (err as any)?.message ?? err);
    }
  }

  return {
    room,
    async setMic(on) {
      wantMic = on;
      if (on && !mayPublish()) return;
      await room.localParticipant.setMicrophoneEnabled(on);
    },
    async setCamera(on) {
      wantCam = on;
      if (on && !mayPublish()) return;
      await room.localParticipant.setCameraEnabled(on);
      if (on) await tuneCameraSender('camera on');
    },
    async flipCamera() {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const t: any = pub?.videoTrack;
      if (!t) return;

      // WE TRACK FACING, THE SDK DOES NOT DO IT FOR US.
      //
      // This used to call mediaStreamTrack._switchCamera(), which decides the
      // new direction from its OWN state:
      //
      //   constraints.facingMode =
      //     this._settings.facingMode === 'user' ? 'environment' : 'user';
      //
      // LiveKit creates the camera track without an explicit facingMode, so
      // _settings.facingMode is UNDEFINED. `undefined === 'user'` is false, so
      // every call asked for 'user' — the front camera, over and over. The
      // button did nothing, forever, and the method is @deprecated besides.
      //
      // Worse, `switched` was set from the method merely EXISTING, so the
      // restartTrack fallback below could never run to correct it.
      //
      // `facing` below is our own, so each press is an explicit request for the
      // other direction and cannot desync from the SDK's private state.
      const next: 'user' | 'environment' = facing === 'user' ? 'environment' : 'user';
      let switched = false;

      // applyConstraints FIRST: it re-points the camera inside the SAME
      // capture, so the MediaStream — and the URL the self-preview renders —
      // stays valid and the peer sees no interruption.
      const mst: any = t.mediaStreamTrack;
      const facingOf = (o: any): string | undefined =>
        (typeof o?.getSettings === 'function' ? o.getSettings() : o?._settings)?.facingMode;
      try {
        if (typeof mst?.applyConstraints === 'function') {
          const c = { ...(mst._settings ?? {}) };
          delete c.deviceId;          // deviceId would pin the OLD camera and win
          c.facingMode = next;
          await mst.applyConstraints(c);
          // VERIFY. DO NOT ASSUME.
          //
          // This is exactly the bug that was here before, in a new coat: the old
          // code set `switched` because _switchCamera EXISTED; the first fix set
          // it because applyConstraints RESOLVED. Neither asked whether the
          // camera actually moved. applyConstraints returns the native layer's
          // new settings, so the answer is available — and when the constraint
          // is not honoured it resolves perfectly happily having changed
          // nothing, which is precisely the "Flip does nothing" report.
          switched = facingOf(mst) === next;
          if (!switched) {
            console.warn('[call] flip: applyConstraints did not take (settings say '
              + String(facingOf(mst)) + ', wanted ' + next + ') — restarting track');
          }
        }
      } catch (e) {
        console.warn('[call] flip: applyConstraints threw — restarting track');
      }

      // restartTrack REPLACES the stream. That is what froze the sender's own
      // preview after a flip: the remote side kept receiving fine (same
      // publication) while the local view rendered a URL whose stream had been
      // thrown away. Whichever path runs, the fresh URL is re-emitted below.
      if (!switched && typeof t.restartTrack === 'function') {
        // The heavier path: replaces the capture entirely. Verified too — if
        // even this does not move the camera, `facing` must NOT advance, or the
        // next press would ask for the direction we are already pointing and
        // the button would appear to work every other tap.
        await t.restartTrack({ facingMode: next });
        switched = facingOf(t.mediaStreamTrack) === next || facingOf(t) === next;
        if (!switched) console.warn('[call] flip: restartTrack did not take either');
      }
      if (switched) facing = next;
      // RE-TUNE. The restartTrack path above REPLACES the capture, and with it
      // the sender, so the detail bias and the resolution-over-frames
      // preference set at publish are gone — a flip would quietly hand the rest
      // of the call an untuned camera. Idempotent on the applyConstraints path,
      // which keeps the same sender, so it is simply always called.
      await tuneCameraSender('flip');
      safe('local', () => a.events.onLocal(urlOf(t)));
    },
    async setScreenShare(on) {
      // Same gate as the mic and camera: a share started before the key exists
      // would be the one stream the server could read.
      if (on && !mayPublish()) throw new Error('Secure calling is still setting up');
      // VP8, no simulcast, modest framerate — for the ENCODER, not for quality.
      //
      // The capture starts, the consent is given, LiveKit issues a track id and
      // reports it published… and not one frame ever reaches the server, which
      // times the publication out and never announces it to anyone. On device
      // that is a banner that says "sharing" over a screen nobody receives.
      //
      // A phone screen is whatever size the phone is — 1080x2400 and friends —
      // and hardware H.264 encoders routinely refuse dimensions that are not a
      // multiple of 16, silently producing no output rather than an error. The
      // camera never hits this because its capture sizes are standard. VP8
      // takes the odd geometry, and dropping simulcast means one encoder to
      // satisfy instead of three.
      // BOUND THE CAPTURE, and declare the content up front.
      //
      // Left unbounded, capture runs at the panel's native geometry — 1080x2400
      // and stranger on modern phones. The publication then completes and the
      // other side subscribes, while the encoder produces NOTHING: the server
      // logged five screen tracks and zero sender reports for them, which is
      // the definition of "capture is not delivering frames".
      //
      // THE RESOLUTION HINT IS INERT ON REACT NATIVE. See lib/golive/hostMedia.ts
      // for the measurement: @livekit/react-native-webrtc declares
      // `getDisplayMedia()` with no parameters, so Android captures the panel at
      // its native size whatever is asked for. Computed anyway because it costs
      // nothing, is correct if RN ever honours constraints, and feeds the
      // bitrate below — which is publish-side and does apply.
      const px = PixelRatio.get();
      const scr = Dimensions.get('screen');
      const cap = screenCaptureSize(Math.round(scr.width * px), Math.round(scr.height * px));
      console.warn('[call] screen share capture', `${cap.width}x${cap.height}@${cap.frameRate}`);
      await room.localParticipant.setScreenShareEnabled(on, on ? {
        resolution: cap,
        contentHint: 'detail',
        audio: false,
      } : undefined, on ? {
        videoCodec: 'vp8',
        simulcast: false,
        // Scaled with the capture area rather than pinned to the old 720p
        // budget, so a smaller portrait capture does not overpay and a larger
        // one is not starved.
        videoEncoding: { maxBitrate: screenCaptureBitrate(cap), maxFramerate: cap.frameRate },
      } : undefined);
      if (!on) return;

      // TUNE FOR TEXT, NOT FOR MOTION.
      //
      // An untuned encoder treats a screen like a camera: it protects frame
      // rate and throws away resolution the moment bandwidth dips, so shared
      // code and slides turn to mush — while a screen that is mostly static
      // needs almost no frames at all.
      //
      //   contentHint 'detail'              keep the sharp edges of text
      //   degradationPreference             give up frames, never resolution
      //     'maintain-resolution'
      //
      // Both are best-effort: React Native's WebRTC does not implement every
      // knob, and a share that is merely untuned is still a working share.
      const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const track: any = pub?.track;
      try { if (track?.mediaStreamTrack) track.mediaStreamTrack.contentHint = 'detail'; } catch {}
      try {
        const sender = track?.sender;
        const params = sender?.getParameters?.();
        if (params) {
          params.degradationPreference = 'maintain-resolution';
          // SCALE AT THE ENCODER, because capture cannot be constrained.
          //
          // Android's getDisplayMedia ignores a resolution constraint and hands
          // back the panel's native geometry — measured as 1080x2340 and
          // 1200x2664 on the two test phones. That is ~2.5-3.2 MEGApixels being
          // squeezed into a phone-call bitrate, which is why the share arrived
          // soft and the frame rate sagged from 15 to 9.
          //
          // Halving each dimension quarters the pixel count (≈540x1170), which
          // is still more than the receiving phone can show, and leaves the
          // bitrate to spend on sharpness instead of size. 2.5 Mbps because
          // text at speed is the demanding case — a static slide will use a
          // fraction of it.
          if (params.encodings?.length) {
            params.encodings[0].scaleResolutionDownBy = 2;
            params.encodings[0].maxBitrate = 2_500_000;
            params.encodings[0].maxFramerate = 15;
          }
          await sender.setParameters(params);
        }
      } catch (err) {
        console.warn('[call] screen share: could not set degradation preference —', (err as any)?.message ?? err);
      }

      // THE TRIAGE NUMBER, sampled REPEATEDLY.
      //
      // One sample four seconds in was misleading: at that moment the user is
      // still looking at crazzychat, and crazzychat's window is FLAG_SECURE — so
      // Android has nothing capturable to hand the encoder and the honest
      // reading is zero. Frames start when they switch to the app they mean to
      // show, which is seconds later and was never measured.
      //
      // Sampling every three seconds shows the transition: 0 while the secure
      // window is all there is, climbing the moment something else is on
      // screen. That difference is the whole diagnosis — capture broken versus
      // capture working exactly as designed.
      if (statsTimer) clearInterval(statsTimer);
      let ticks = 0;
      // The same sampler now also DECIDES. It already reads
      // qualityLimitationReason, so noticing CPU starvation costs nothing extra
      // — and acting on measurement beats the alternative, which is picking a
      // different fixed guess and hoping it suits both text and motion.
      const reasons: string[] = [];
      let relaxed = false;
      statsTimer = setInterval(async () => {
        ticks++;
        // The 12-tick cap was a LOGGING budget — twelve samples is plenty to
        // diagnose a share that never starts. It must not also cap the
        // adaptation: CPU starvation begins when the CONTENT gets busy, and a
        // user who shares a document first and opens a game two minutes later
        // would hit it long after tick 12, with nothing left running to notice.
        //
        // So logging still stops at 36s; watching continues until it has either
        // acted once or the share ends (no publication clears the timer below).
        const logging = ticks <= 12;
        try {
          const pubNow = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
          if (!pubNow) { if (statsTimer) clearInterval(statsTimer); statsTimer = null; return; }
          if (!logging && relaxed) { if (statsTimer) clearInterval(statsTimer); statsTimer = null; return; }
          const senderNow = (pubNow.track as any)?.sender;
          const stats = await senderNow?.getStats?.();
          stats?.forEach?.((r: any) => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            const reason = r.qualityLimitationReason ?? 'none';
            if (logging) {
              console.warn('[call] SCREEN_SHARE_STATS encoded=' + (r.framesEncoded ?? 0)
                + ' sent=' + (r.framesSent ?? 0) + ' bytes=' + (r.bytesSent ?? 0)
                + ' size=' + (r.frameWidth ?? 0) + 'x' + (r.frameHeight ?? 0)
                + ' fps=' + (r.framesPerSecond ?? 0)
                + ' limit=' + reason);
            }
            reasons.push(reason);
            // Only the last CPU_STRIKES matter; keep the array from growing for
            // the whole life of a long share.
            if (reasons.length > 8) reasons.shift();
          });

          // RELAX ONLY ONCE, AND ONLY ON PROOF.
          //
          // Measured on a Redmi Note 8 Pro: fps=2-3 against an allowed 15, with
          // limit=cpu — the encoder wanted more and could not. Holding every
          // pixel there costs nearly every frame, because encoder load is
          // pixels x frames. A static screen reports 'none' and a bandwidth dip
          // reports 'bandwidth', so neither trips this: the text tuning stays
          // exactly as it was for the cases it was designed for.
          if (!relaxed && shouldRelax(reasons)) {
            relaxed = true;
            const { degradationPreference, scaleResolutionDownBy } = relaxedEncoding();
            try {
              const p = senderNow?.getParameters?.();
              if (p?.encodings?.length) {
                p.degradationPreference = degradationPreference;
                p.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
                await senderNow.setParameters(p);
                console.warn('[call] SCREEN_SHARE_RELAXED cpu-limited -> '
                  + degradationPreference + ' scale=' + scaleResolutionDownBy);
              }
            } catch (err) {
              // Best-effort, like the initial tuning: a share that stays sharp
              // and slow is worse than one that adapts, but far better than one
              // that dies trying.
              console.warn('[call] screen share: could not relax —', (err as any)?.message ?? err);
            }
          }
        } catch { /* stats are diagnostics; never let them affect the share */ }
      }, 3000);
    },
    setVisible(ids) {
      setVisibleState(vis, ids, Date.now());
      room.remoteParticipants.forEach(p => wantAll(p));
    },
    async setMediaKey(key) { await installKey(key); },
    setRemoteAudible(on) {
      try {
        room.remoteParticipants.forEach(p => {
          p.audioTrackPublications.forEach(pub => {
            const t: any = pub.track?.mediaStreamTrack;
            if (t) t.enabled = on;
          });
        });
      } catch { /* best effort — hold must never break the call */ }
    },
    async leave() {
      stopKeyWait();
      clearInterval(reconcileTimer);
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
      try { await crypto?.dispose(); } catch {}
      try { await room.disconnect(); } catch {}
      try { await AudioSession.stopAudioSession(); } catch {}
    },
  };
}

export default { joinCallRoom };
