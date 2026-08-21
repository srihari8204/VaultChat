// lib/golive/room.ts — the LiveKit room a Go Live broadcast publishes into.
//
// A COPY of lib/call/sfuRoom.ts, moved here deliberately. Go Live was the only
// importer, but leaving it under lib/call/ meant every broadcasting fix was an
// edit inside the calling product's directory. Two things that must never break
// together should not share a file.
//
// Divergences from the original, both measured on device against production:
//   * AudioSession.startAudioSession() before connect — without it Android's
//     WebRTC audio device module is unconfigured and publishing the microphone
//     never completes negotiation.
//   * singlePeerConnection: false — dual PC, as lib/call/room.ts uses.
//
// lib/golive/room.ts — join a LiveKit room, with frame-level E2EE.
//
// This is the missing half of two modes at once:
//
//   GROUP CALLS (6-64)  publish + subscribe, frames encrypted end to end so the
//                       SFU forwards ciphertext it cannot read.
//   BROADCAST           publish only. Egress transcodes the room to HLS, which
//                       is why broadcast MUST NOT be frame-encrypted: a
//                       transcoder cannot read ciphertext. That is not a
//                       configuration choice, it is arithmetic — and it is why
//                       migration 079 records e2ee=false for broadcasts.
//
// The E2EE flag therefore comes from the CALLER, never from a default. Getting
// it backwards either breaks the stream (encrypted broadcast, egress outputs
// noise) or silently downgrades a group call the UI claims is encrypted. The
// second is worse, so `e2eeKey` is required to be explicit: pass a key, or pass
// null and say why.

// IMPORT ORDER IS LOAD-BEARING — do not let a formatter sort these.
//
// livekit-client is a BROWSER library: it references DOMException, fetch and
// friends at module scope. Hermes has no DOMException, so importing it first
// throws `ReferenceError: Property 'DOMException' doesn't exist` before a single
// line of this file runs — which surfaces as a WHITE SCREEN with no error of
// ours anywhere in the log, because the module never evaluated.
//
// @livekit/react-native installs that polyfill as a side effect of being
// imported (its index requires ./polyfills/DOMException). Importing it FIRST is
// what makes the line below legal.
import { AudioSession, registerGlobals } from '@livekit/react-native';
import { startBroadcastAudio, stopBroadcastAudio } from './audio';
import { DefaultReconnectPolicy, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import { enableFrameCrypto, type FrameCryptoHandle } from '../call/frameCrypto';
import { assertConnectionEventNames, wireConnectionEvents } from './connectionEvents';
// The ICE/TURN configuration that already exists — cached, expiry-aware, and
// never throwing. Reused rather than reimplemented; see the connect() call.
import { getIceServers } from '../iceConfig';

// livekit-client is a WEB library: it expects navigator.mediaDevices,
// RTCPeerConnection and friends as globals. registerGlobals installs the React
// Native WebRTC implementations under those names. Without it the SDK fails at
// connect with an error that points at the browser API rather than at this.
// THE GUARD MUST BE GLOBAL, NOT MODULE-LOCAL. This is the publisher bug.
//
// registerGlobals() installs RTCPeerConnection, MediaStream and friends onto
// globalThis. lib/call/room.ts guards it with its OWN module-level
// `globalsReady`, and this file used to do the same — so once calling had
// registered, Go Live's separate flag was still false and it registered a
// SECOND time, replacing those global constructors underneath the running SDK.
//
// A sender created under the first registration is then not recognisable to the
// second, which is precisely what the device reported:
//
//   Error: Sender does not belong to this peer connection
//   NegotiationError: negotiation timed out
//
// followed by an endless publish/unpublish churn — the SDK holding references
// across two different WebRTC implementations. It only bites Go Live because
// calling registers first, so calling never sees it.
//
// A sentinel on globalThis is shared by every module in the bundle, so whichever
// path loads first wins and no one re-registers. Nothing in lib/call is touched:
// if calling has already registered, this is a no-op; if Go Live loads first,
// calling's own guard still works because registerGlobals is idempotent from
// its perspective — it simply never runs twice now.
const GLOBALS_KEY = '__vaultchatLiveKitGlobalsRegistered';
function ensureGlobals(): void {
  const g = globalThis as any;

  // DETECT AN EXISTING REGISTRATION BY ANYONE — not just by us.
  //
  // registerGlobals() installs RTCPeerConnection, MediaStream and friends onto
  // globalThis. lib/call/room.ts and lib/call/sfuRoom.ts each guard it with
  // their OWN module-local `globalsReady`, and neither sets our sentinel — so a
  // sentinel only we write cannot see that calling already registered. On any
  // device where a call happened first, Go Live still registered a SECOND time
  // and replaced the constructors underneath the running SDK.
  //
  // That is why the earlier sentinel changed nothing, and why the diagnostic's
  // `globalsRegistered: true` was meaningless: we set it ourselves immediately
  // after re-registering.
  //
  // Probing for RTCPeerConnection is registration-source agnostic. Whoever
  // installed it — calling, Go Live, or a future module — we do not install it
  // again, and lib/call needs no change at all.
  const alreadyInstalled =
    typeof g.RTCPeerConnection !== 'undefined' && typeof g.MediaStream !== 'undefined';
  if (g[GLOBALS_KEY] || alreadyInstalled) {
    g[GLOBALS_KEY] = true;
    return;
  }
  registerGlobals();
  g.__vaultchatGoLiveDidRegister = true;
  g[GLOBALS_KEY] = true;
}

export interface SfuSession {
  room: Room;
  /** Frame encryption, or null for a deliberately unencrypted room. */
  crypto: FrameCryptoHandle | null;
  /**
   * Swap what the published video track carries — camera ⇄ screen.
   *
   * The mesh does this with RTCRtpSender.replaceTrack and no renegotiation; the
   * room needs the same, because unpublishing and republishing would drop the
   * subscriber's view (and on a screen share that is exactly the moment the
   * user is showing something). Returns false when there is no video
   * publication to swap — a voice call.
   */
  replaceVideo(track: any): Promise<boolean>;
  /** Silence/restore every remote participant (call-waiting hold). */
  setRemoteAudible(audible: boolean): void;
  leave(): Promise<void>;
}

export interface JoinArgs {
  url: string;
  token: string;
  identity: string;
  /** Publish camera + mic. False for an audience member watching over WebRTC. */
  publish: boolean;
  /** Camera on. Audio-only broadcasts are far cheaper and often what is wanted. */
  video: boolean;
  /**
   * 32-byte media key, or null for NO frame encryption.
   *
   * null is correct for broadcast (egress must be able to read the frames) and
   * WRONG for a group call. Required rather than defaulted so the decision is
   * always visible at the call site.
   */
  e2eeKey: Uint8Array | null;
  /**
   * Tracks to publish INSTEAD of letting the SDK open its own capture.
   *
   * The engine already holds a live capture (media.acquireLocalMedia) and every
   * control it exposes — mute, camera off, screen share, the quality loop —
   * operates on those tracks. Letting LiveKit capture again is not merely
   * wasteful: on Android the second open of the same camera fails outright, and
   * the mute controls would be pointing at a track nobody is sending.
   */
  tracks?: any[];
  /**
   * A remote track arrived or went away: participant identity (the user id),
   * stream URL (null = gone), and WHICH publication it is.
   *
   * `screen` is not cosmetic. A host on stage publishes camera and screen as
   * two separate video tracks under ONE identity, so a caller keying by
   * identity alone silently keeps whichever arrived last and drops the other —
   * which is exactly how a screen share ends up replacing the host's face
   * instead of appearing beside it. Optional, so existing callers compile
   * unchanged and simply ignore the distinction.
   */
  onTrack?: (uid: string, url: string | null, kind: 'audio' | 'video', screen?: boolean) => void;
  onParticipant?: (p: RemoteParticipant, joined: boolean) => void;
  /**
   * The SDK LOST the transport and is recovering it.
   *
   * THE APP DOES NOT RETRY. livekit-client owns the reconnect policy — its
   * DefaultReconnectPolicy retries on [0, 300, 1200, 2700, 4800, 7000×5] ms,
   * ten attempts over roughly forty-four seconds — and a second scheduler on
   * top of that is how two connections end up racing to publish into the same
   * room. These three callbacks EXIST ONLY TO REPORT what the SDK is already
   * doing, so the UI can stop claiming the broadcast is healthy.
   *
   * That forty-four-second window is the actual defect they close: without it
   * the host keeps talking to an audience that stopped receiving long ago, and
   * the screen still says LIVE.
   */
  onReconnecting?: () => void;
  /** The SDK got the transport back. Publishing resumes on its own. */
  onReconnected?: () => void;
  /** The SDK gave up. Terminal — this is the only one that ends anything. */
  onDisconnected?: () => void;
  /**
   * Something about what WE publish changed — a track published, unpublished,
   * muted or unmuted.
   *
   * WHY THIS EXISTS
   * ---------------
   * A screen share can end without this app asking: the user taps "Stop
   * sharing" in Android's own notification, or the system revokes the
   * MediaProjection. Nothing told the UI, so its cached "sharing" flag stayed
   * true — the button claimed the host was sharing when they were not, and the
   * next tap computed "turn it off" and called stop on an already-stopped
   * share. The visible result was a screen-share button that appeared to do
   * nothing, which reads as "screen share won't stop".
   *
   * A ping, not a payload: the caller reads the room back through
   * hostMediaState() so the rule for what "on" means lives in exactly one
   * place. Same reason the toggle handler re-reads instead of trusting its own
   * optimistic value.
   */
  onLocalMedia?: () => void;
}

// The wiring itself lives in ./connectionEvents so it can be exercised under
// `npx tsx` — this module cannot, because it opens a real transport. Checked
// once here against the SDK's own enum so a rename cannot silently stop the
// callbacks from firing.
assertConnectionEventNames(RoomEvent);

export async function joinSfuRoom(a: JoinArgs): Promise<SfuSession> {
  ensureGlobals();

  // STARTED HERE, AWAITED AT connect(). Everything between this line and the
  // connect — constructing the Room, registering handlers, bringing up the
  // audio session — runs while the request is in flight, so on a warm cache
  // this costs nothing and on a cold one it costs the overlap, not the sum.
  //
  // Deliberately NOT awaited here: doing so would put a network round trip
  // directly in front of going live, which is the exact delay lib/iceConfig.ts
  // was written to remove from the call path.
  const iceServersPromise = getIceServers();

  const room = new Room({
    /**
     * RECONNECT BUDGET — the SDK's own policy, lengthened. Not a second
     * reconnect system: livekit-client still owns every attempt, the backoff and
     * the give-up decision. Only the delay table it reads is different.
     *
     * WHY. The server holds a broadcast open for hostGrace() — 90s — after the
     * host drops, and restarts the transcoder when they rejoin
     * (golive_webhook.go). That recovery can only fire if the host ACTUALLY
     * rejoins, and the stock policy is [0, 300, 1200, 2700, 4800, 7000 x5] =
     * 44s over 10 attempts. Measured on device: the SDK gave up, emitted
     * Disconnected, no participant_joined ever reached the server, and the
     * grace expired with nothing to recover. The two mechanisms could not
     * cooperate because the client stopped trying first.
     *
     * THE NUMBER. Same shape, eight 7s attempts instead of five:
     *   0 + 300 + 1200 + 2700 + 4800 + 7000x8 = 65,000ms over 13 attempts.
     * nextRetryDelayInMs adds up to 1000ms of jitter per attempt after the
     * second (11 of them here), so the worst case is ~76s — still inside the
     * 90s grace, with ~14s left for the rejoin, the webhook and StartHLS.
     *
     * Deliberately biased LONG rather than short. Overshooting costs a few
     * wasted retries against a room the reaper has already closed; undershooting
     * loses a broadcast that was recoverable, which is the bug this exists for.
     *
     * Changing hostGrace() means recomputing this — they are one budget split
     * across two processes.
     */
    reconnectPolicy: new DefaultReconnectPolicy([0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000, 7000, 7000, 7000]),
    // Let the SDK drop layers under congestion rather than freezing. The same
    // reasoning as lib/call/quality.ts on the mesh path: degrade, do not stall.
    // FALSE, as lib/call/room.ts sets it. The last client difference between
    // the path that publishes and the one that does not.
    //
    // adaptiveStream drives subscription decisions from whether a video view is
    // ON SCREEN — a browser concept backed by IntersectionObserver. React Native
    // has no such signal, so the SDK keeps renegotiating against visibility it
    // never receives. Measured on device: both peer connections reached
    // ice=connected/conn=connected, so transport was never the problem, and yet
    // publishing a single microphone track still ended in
    // "NegotiationError: negotiation timed out".
    //
    // A broadcast has one publisher and, for the host, nothing to subscribe to
    // at all, so adaptive subscription buys nothing here even if it worked.
    adaptiveStream: false,
    dynacast: true,
    // DUAL PEER CONNECTION. Not the SDK default, and not optional.
    //
    // lib/call/room.ts:131 sets this for calling and records why. This file did
    // not, and Go Live is the only thing that uses it — so broadcasting ran in
    // single-PC mode while calling ran dual, which is exactly the difference
    // that made one work and the other not.
    //
    // Measured on a real device against prod: the host connected, published its
    // microphone track, and then the publisher transport never settled —
    // "NegotiationError: negotiation timed out" after ~13s, then an endless
    // participant active/closing churn, with the client logging
    // "failed to remove track: Sender does not belong to this peer connection".
    // That last error is the single-PC signature: one connection carrying both
    // directions, and a sender the SDK cannot match back to it.
    //
    // Dual PC costs one extra peer connection per participant. A broadcast that
    // actually publishes is worth more.
    singlePeerConnection: false,
  });

  // Same rule as TrackSubscribed: never throw back into the SDK, and log, since
  // "did the other side actually arrive in the room?" is the first question of
  // every call that does not connect.
  const participant = (p: RemoteParticipant, joined: boolean) => {
    console.warn('[call] sfu participant', joined ? 'joined' : 'left', p.identity,
      'room now', room.remoteParticipants.size + 1);
    try { a.onParticipant?.(p, joined); } catch (err) {
      console.warn('[call] onParticipant handler threw —', (err as any)?.message ?? err);
    }
  };
  room.on(RoomEvent.ParticipantConnected, p => participant(p, true));
  room.on(RoomEvent.ParticipantDisconnected, p => participant(p, false));

  // Keep the caller's view of OUR OWN publications honest — see onLocalMedia.
  //
  // All four events, because they are four different ways the truth changes:
  // unpublished covers the system stopping a screen share behind our back,
  // published covers a track arriving, and mute/unmute covers a camera or mic
  // that is still published but no longer sending. Missing any one of them
  // leaves the same stale-flag bug in a narrower case.
  if (a.onLocalMedia) {
    const ping = a.onLocalMedia;
    room.on(RoomEvent.LocalTrackPublished, () => ping());
    room.on(RoomEvent.LocalTrackUnpublished, () => ping());
    // (publication, participant) — the participant is the SECOND argument, and
    // these fire for remote tracks too, so the local check is what keeps a
    // muting viewer from resyncing the host's own buttons.
    room.on(RoomEvent.TrackMuted, (_pub, p) => { if (p === room.localParticipant) ping(); });
    room.on(RoomEvent.TrackUnmuted, (_pub, p) => { if (p === room.localParticipant) ping(); });
  }
  room.on(RoomEvent.ConnectionStateChanged, st => console.warn('[call] sfu room state →', st));
  // These two split the one question that matters when a call joins and stays
  // silent: did we never HEAR about the other side's track (signalling), or did
  // we hear about it and never receive it (the subscriber transport)?
  room.on(RoomEvent.TrackPublished, (pub, p) =>
    console.warn('[call] sfu remote published', pub.kind, 'by', p.identity, '— awaiting subscribe'));
  room.on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) =>
    console.warn('[call] sfu SUBSCRIBE FAILED', sid, 'from', p.identity, '—', String(reason)));
  wireConnectionEvents(room, a);
  // The SFU's equivalent of `ontrack`, and the only signal that says a call on
  // this transport is actually up. Without it a call joins a room, publishes,
  // and sits in "calling…" until the ring budget hangs it up.
  let crypto: FrameCryptoHandle | null = null;

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: any, p: RemoteParticipant) => {
    // NOTHING in here may throw. This handler is invoked from inside the SDK's
    // event emitter, so an exception does not just skip the rest of this
    // function — it unwinds into livekit-client's own subscription handling.
    // The call then has a remote track the app never hears about, sits in
    // "ringing" with media flowing underneath, and dies on the ring timeout.
    let url: string | null = null;
    try {
      // A receiver exists only once its track is subscribed, so THIS is the
      // moment its cryptor can be created. Without it every incoming frame
      // stays ciphertext and the remote video is noise or nothing at all.
      crypto?.attach();
    } catch (err) {
      console.warn('[call] frame cryptor attach failed on subscribe —', (err as any)?.message ?? err);
    }
    try { url = (track.mediaStream as any)?.toURL?.() ?? null; } catch {}
    const kind = track.kind === Track.Kind.Video ? 'video' : 'audio';
    // Logged because this is the event that decides whether a call is
    // "connected". Its absence was indistinguishable from a dead SFU.
    const screen = _pub?.source === Track.Source.ScreenShare;
    console.warn('[call] sfu track subscribed —', kind, screen ? '(screen)' : '', 'from', p.identity, url ? 'with stream' : 'NO STREAM URL');
    try { a.onTrack?.(p.identity, url, kind, screen); } catch (err) {
      console.warn('[call] onTrack handler threw —', (err as any)?.message ?? err);
    }
  });

  // THE OTHER HALF. Without this, a track only ever disappears when its
  // publisher disconnects — so a host who stops sharing their screen but stays
  // on stage leaves the last captured frame frozen on every viewer, and the
  // stream looks stuck rather than un-shared. Same guarantee as above: nothing
  // in here may throw back into the SDK's emitter.
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: any, p: RemoteParticipant) => {
    const kind = track.kind === Track.Kind.Video ? 'video' : 'audio';
    const screen = _pub?.source === Track.Source.ScreenShare;
    console.warn('[call] sfu track unsubscribed —', kind, screen ? '(screen)' : '', 'from', p.identity);
    try { a.onTrack?.(p.identity, null, kind, screen); } catch (err) {
      console.warn('[call] onTrack handler threw on unsubscribe —', (err as any)?.message ?? err);
    }
  });
  // A reconnect rebuilds the transports, and the new senders/receivers come up
  // bare. Re-attaching is idempotent — the handle skips what it already covers.
  room.on(RoomEvent.Reconnected, () => { crypto?.attach(); });

  // START THE AUDIO SESSION BEFORE CONNECTING. Not optional on Android.
  //
  // lib/call/room.ts:220 does this and calling works; this file never did, and
  // Go Live is its only caller — so broadcasting was publishing a microphone
  // track with the WebRTC audio device module unconfigured. Measured against
  // prod: the host connected, published the mic, and the publisher transport
  // then never settled — "NegotiationError: negotiation timed out" every ~15s,
  // with an endless participant active/closing churn behind it.
  //
  // The server was never at fault: a non-RN client publishing to the SAME SFU
  // got 2/2 tracks at 1.2 Mbps with 0% packet loss.
  await AudioSession.startAudioSession();

  // AND TAKE THE ROUTE, not just the session.
  //
  // startAudioSession() brings up WebRTC's audio session but leaves the OUTPUT
  // ROUTE to Android's defaults, so nothing ever selected a connected Bluetooth
  // headset: the host broadcast from the phone's own mic and heard nothing in
  // their earbuds. lib/golive/audio.ts hands the route to InCallManager with
  // `auto: true`, which is what follows a headset in and out mid-broadcast.
  //
  // Only when we PUBLISH. A viewer watches over HLS through expo-av, which is
  // ordinary media playback and already follows A2DP — putting the device into
  // communication mode for them would duck every other app's audio for nothing.
  if (a.publish) startBroadcastAudio();

  // autoSubscribe explicitly, as the call path does. A broadcast host has
  // nothing to subscribe to, but a promoted co-host does, and leaving it to the
  // SDK default is the kind of difference that is invisible until it is not.
  // TURN AS A FALLBACK CANDIDATE, NOT A ROUTE CHANGE.
  //
  // Until now a Go Live client received only what the SFU advertised, and both
  // livekit YAMLs set `turn: enabled: false` — deliberately, because the intent
  // recorded there is to "reuse the coturn already running on this host".
  // Nothing ever carried out that intent, so no relay candidate was offered at
  // all and a host on a 443-only network could not go live.
  //
  // This hands the SDK the ICE list the app ALREADY builds (lib/iceConfig.ts:
  // cached, expiry-aware, one in-flight request shared by concurrent callers).
  // ICE priority is untouched: host and server-reflexive pairs are tried first
  // by the protocol itself, and relay is last resort. A host on a normal
  // network connects exactly as before and never touches the relay.
  //
  // FAILURE IS ALREADY SAFE: getIceServers() never throws and never returns
  // empty — it degrades to the last good config, then to STUN only. So a TURN
  // outage or an unauthenticated /user/turn leaves this list STUN-only, which
  // is precisely what the SDK was working with before this line existed.
  const iceServers = await iceServersPromise;
  await room.connect(a.url, a.token, { autoSubscribe: true, rtcConfig: { iceServers } });

  // [GOLIVE_MEDIA] — publisher truth, not inference.
  //
  // Every field here answers a question the negotiation failure raised: is there
  // more than one peer connection, does the sender belong to the PC that owns
  // it, how many transceivers exist, and did anything capture twice. No token,
  // key or URL is printed.
  const diag = (phase: string) => {
    try {
      const lp: any = room.localParticipant;
      const eng: any = (room as any).engine;
      const pubPC: any = eng?.pcManager?.publisher?.pc ?? eng?.publisher?.pc;
      const subPC: any = eng?.pcManager?.subscriber?.pc ?? eng?.subscriber?.pc;
      const pubs = Array.from(lp?.trackPublications?.values?.() ?? []);
      console.warn('[GOLIVE_MEDIA]', JSON.stringify({
        phase,
        room: room.name,
        state: room.state,
        participantSid: lp?.sid,
        publications: pubs.map((p: any) => ({
          sid: p?.trackSid, source: p?.source, kind: p?.kind,
          muted: p?.isMuted, subscribed: p?.isSubscribed,
        })),
        publisher: pubPC ? {
          signaling: pubPC.signalingState,
          ice: pubPC.iceConnectionState,
          conn: pubPC.connectionState,
          senders: pubPC.getSenders?.().length ?? -1,
          transceivers: pubPC.getTransceivers?.().length ?? -1,
        } : null,
        subscriber: subPC ? {
          ice: subPC.iceConnectionState, conn: subPC.connectionState,
          receivers: subPC.getReceivers?.().length ?? -1,
        } : null,
        // If registerGlobals ran twice these would be different objects.
        globalsRegistered: !!(globalThis as any).__vaultchatLiveKitGlobalsRegistered,
        // Whether WE called registerGlobals, or found it already installed.
        globalsInstalledByUs: !!(globalThis as any).__vaultchatGoLiveDidRegister,
      }));
    } catch (e: any) {
      console.warn('[GOLIVE_MEDIA] diag failed —', e?.message ?? e);
    }
  };
  diag('connected');

  // The key provider must exist BEFORE anything is published — see the publish
  // block below, which keeps the tracks silent until their cryptors are on.
  if (a.e2eeKey) {
    // BOTH transports. LiveKit publishes on one peer connection and subscribes
    // on another; attaching to only the publisher encrypts what we send and
    // leaves everything we receive undecryptable.
    const pcs = () => {
      const e: any = room.engine as any;
      return [
        e?.pcManager?.publisher?.pc ?? e?.publisher?.pc,
        e?.pcManager?.subscriber?.pc ?? e?.subscriber?.pc,
      ].filter(Boolean);
    };
    crypto = await enableFrameCrypto(pcs, a.identity, a.e2eeKey);
    if (!crypto.active) {
      // A call that believes it is encrypted but is not must not proceed
      // quietly. Broadcast never reaches here — it passes e2eeKey: null.
      await room.disconnect();
      throw new Error('Secure calling is unavailable on this device');
    }
  }

  // Held so screen share can swap what it carries without republishing.
  let published: LocalVideoTrack | null = null;
  let attached = 0;

  if (a.publish) {
    const own = (a.tracks ?? []).filter((t: any) => t?.kind === 'audio' || (a.video && t?.kind === 'video'));
    if (own.length) {
      // PUBLISH SILENT, THEN ENCRYPT, THEN UNMUTE.
      //
      // A sender does not exist until publishTrack resolves, and the cryptor
      // can only be attached to a sender — so there is an unavoidable window
      // between "sending" and "encrypted". Disabling the track first makes that
      // window carry silence and black frames instead of the room's audio and
      // the user's camera. `enabled` is restored to what the engine had it at,
      // so a call started while muted stays muted.
      const wasEnabled = new Map<any, boolean>(own.map((t: any) => [t, t.enabled !== false]));
      for (const t of own) { try { t.enabled = false; } catch {} }
      try {
        for (const t of own) {
          // THE SOURCE MUST BE DECLARED, or the SDK refuses before the server
          // is ever asked.
          //
          // A LocalTrack built from a MediaStreamTrack we captured ourselves has
          // source = Unknown, and livekit-client checks
          // `canPublishSources.includes(track.source)` locally — our grant lists
          // camera/microphone/screen_share, so Unknown is not in it and
          // publishTrack throws "failed to publish track, insufficient
          // permissions" with nothing at all in the server log. Measured on
          // device: every call fell back to the mesh for this one reason.
          //
          // Widening the grant to an empty (= allow-all) source list would also
          // "fix" it, and would quietly destroy the audience guarantee the grant
          // exists for. Declaring the source is the honest half.
          if (t.kind === 'audio') {
            const audio = new LocalAudioTrack(t);
            audio.source = Track.Source.Microphone;
            await room.localParticipant.publishTrack(audio, { source: Track.Source.Microphone });
          } else {
            published = new LocalVideoTrack(t);
            published.source = Track.Source.Camera;
            await room.localParticipant.publishTrack(published, { source: Track.Source.Camera });
          }
        }
        attached = crypto?.attach() ?? 0;
      } finally {
        for (const t of own) { try { t.enabled = wasEnabled.get(t) ?? true; } catch {} }
      }
    } else {
      await room.localParticipant.setMicrophoneEnabled(true);
      if (a.video) await room.localParticipant.setCameraEnabled(true);
      attached = crypto?.attach() ?? 0;
    }

    diag('after-publish');

    // Publishing with nothing attached is the silent downgrade this whole file
    // exists to prevent: the call would work perfectly and the server would be
    // able to read it. Refuse instead — the engine then degrades to the mesh,
    // which is peer-to-peer and encrypted by construction.
    if (a.e2eeKey && attached === 0) {
      await room.disconnect();
      throw new Error('Secure calling is unavailable on this device');
    }
  }

  return {
    room,
    crypto,
    async replaceVideo(track: any) {
      const vid = published
        ?? (room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined)
        ?? null;
      if (!vid || !track) return false;
      // userProvidedTrack: the engine owns this track's lifetime — it stops the
      // screen capture itself and restores the camera afterwards. Letting the
      // SDK adopt it would have it stopped underneath the engine.
      await vid.replaceTrack(track, true);
      published = vid;
      return true;
    },
    setRemoteAudible(audible: boolean) {
      try {
        room.remoteParticipants.forEach(p => {
          p.audioTrackPublications.forEach(pub => {
            const t: any = pub.track?.mediaStreamTrack;
            if (t) t.enabled = audible;
          });
        });
      } catch {}
    },
    async leave() {
      try { await crypto?.dispose(); } catch {}
      try { await room.disconnect(); } catch {}
      // Paired with startAudioSession above. Left running, Android keeps the
      // communication audio mode and the next call or broadcast inherits it.
      try { await AudioSession.stopAudioSession(); } catch {}
      // Paired with startBroadcastAudio. Unconditional even though the start is
      // gated on `publish`: stop() on a session we never started is a no-op,
      // and leaving the device in communication mode would duck every other
      // app's audio until something else happened to clear it.
      stopBroadcastAudio();
    },
  };
}

/** Track sources worth rendering, in the order a UI should prefer them. */
export const RENDER_SOURCES = [Track.Source.ScreenShare, Track.Source.Camera];

export default { joinSfuRoom };
