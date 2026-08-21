// app/live-view.tsx — watch a broadcast, or monitor your own.
//
// Playback is plain HLS through expo-av, which maps to ExoPlayer on Android and
// AVPlayer on iOS. Both handle adaptive bitrate themselves: the player picks a
// rendition from the manifest based on measured throughput, which is why the
// broadcast tier needs no equivalent of lib/call/quality.ts. Reimplementing that
// here would fight the platform rather than help it.
//
// The stream is served by the CDN, not by the app's API. A viewer fetching a
// segment must never consume an API worker — at broadcast scale that is the
// difference between a stream and an outage.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  ScrollView, TextInput, Pressable, KeyboardAvoidingView, Platform,
  useWindowDimensions, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ResizeMode, Video } from 'expo-av';
// The same renderer app/group-call-active.tsx uses for local video. Not the
// LiveKit <VideoTrack> component: that wants a components-react TrackReference,
// and this screen holds a plain Room. A stream URL is all RTCView needs.
import { RTCView } from '@livekit/react-native-webrtc';
import * as Clipboard from 'expo-clipboard';
import { pickStage, pipSize } from '../lib/golive/stageLayout';
import { useColors } from '../lib/theme';
import { AppText } from '../components/ui/Text';
import { SPACING, RADIUS } from '../constants/theme';
import {
  endBroadcast, getBroadcast, waitForPlaylist, watchBroadcast, unwatchBroadcast,
  listBroadcastChat, sendBroadcastChat, listPolls, votePoll, closePoll, createPoll,
  createInviteLink,
  type Broadcast, type BroadcastMessage, type BroadcastPoll,
} from '../lib/broadcast';
import { getBroadcastToken } from '../lib/call/sfuToken';
// lib/golive/room.ts — Go Live's OWN copy of the SFU join path.
//
// It began as lib/call/sfuRoom.ts and now lives under lib/golive/ so that
// NOTHING Go Live needs sits inside lib/call/. Broadcasting must never be a
// reason to edit a file the calling product owns, even one calling does not
// currently import — the risk is not worth the shared line.
//
// Imported LAZILY: it pulls in livekit-client, a browser library that needs
// polyfills installed at import time. A failure there degrades to "could not
// publish" instead of a white screen — a viewer can still watch the HLS stream
// even if publishing is broken, and that is worth preserving.
type SfuSession = Awaited<ReturnType<typeof import('../lib/golive/room').joinSfuRoom>>;

export default function LiveViewScreen() {
  // `pc` is the host's own copy of the passcode, carried from app/live.tsx. The
  // server keeps only a bcrypt hash, so this param is the only readable copy
  // and it exists purely so the invite sheet can show the host what to share.
  const { id, host, cam, mic, invite, pc } = useLocalSearchParams<{
    id: string; host?: string; cam?: string; mic?: string; invite?: string; pc?: string;
  }>();
  const isHost = host === '1';
  /** Chosen on the setup screen, applied at join rather than after going on air. */
  const startCam = cam !== '0';
  const startMic = mic !== '0';
  const colors = useColors();
  const router = useRouter();
  const video = useRef<Video>(null);

  const [b, setB] = useState<Broadcast | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);
  /**
   * The SDK is recovering the transport. TEMPORARY and non-destructive — the
   * broadcast is not over, the tracks are not torn down, and nothing here
   * retries. It exists so the screen can stop claiming LIVE during the window
   * the SDK spends reconnecting. Cleared by onReconnected, or superseded by
   * `failed` if the SDK ultimately gives up.
   */
  const [reconnecting, setReconnecting] = useState(false);
  /** The host stopped, or the stream failed server-side, while we were watching. */
  const [ended, setEnded] = useState(false);

  // The HOST publishes into the LiveKit room; egress transcodes that room to
  // HLS. Without this nothing reaches the SFU and egress renders an empty
  // stream — the gap that made "Go Live" wait forever.
  //
  // e2eeKey is null ON PURPOSE: a transcoder cannot read encrypted frames, so a
  // broadcast is not end-to-end encrypted. That is recorded server-side
  // (migration 079, e2ee=false) and shown to the user before they publish.
  /**
   * The host's live session, kept so the control bar can reach it.
   *
   * A ref rather than state: the controls mutate the room in place and re-render
   * from `media` below, and putting a LiveKit Room in state would re-run this
   * effect's dependencies on every toggle — reconnecting the host mid-broadcast.
   */
  const hostSession = useRef<SfuSession | null>(null);
  // hostMedia, held so the onLocalMedia ping can read the room back without an
  // await — the module is already loaded by then, and a dynamic import inside a
  // synchronous event handler would race the render it is meant to correct.
  const mediaLib = useRef<typeof import('../lib/golive/hostMedia') | null>(null);
  /** Our own capture, held so it can be stopped — the SDK does not own it. */
  const localStream = useRef<any>(null);

  /**
   * Release everything THIS SCREEN owns: the SFU session and the capture we
   * opened. Nothing else — tracks the SDK owns are left to the SDK.
   *
   * IDEMPOTENT BY CONSTRUCTION. Both refs are cleared before the awaits, so a
   * second call finds null and does nothing. That is what makes it safe to
   * call from a terminal event AND still have the unmount cleanup run after,
   * which is exactly the pair that happens when a broadcast fails and the user
   * then leaves the screen.
   *
   * Why this exists: the failure paths marked the broadcast failed and stopped
   * there. livekit-client does not know the BROADCAST ended — only that its
   * transport dropped — so the session kept retrying under its own policy, and
   * our capture stayed open with it. Measured on device: a room from a finished
   * broadcast still logging `reconnecting -> connected` six minutes later,
   * beside the next broadcast's room.
   */
  const releaseOwnedMedia = useCallback(async () => {
    const s = hostSession.current;
    hostSession.current = null;
    mediaLib.current = null;
    const ls = localStream.current;
    localStream.current = null;
    // WE opened this capture, so we close it. userProvidedTrack means LiveKit
    // will not stop it for us, and a camera left open keeps the indicator lit.
    try { ls?.getTracks?.().forEach((t: any) => t.stop()); } catch {}
    if (s) {
      try {
        const { stopAllHostMedia } = await import('../lib/golive/hostMedia');
        await stopAllHostMedia(s.room);
      } catch { /* leaving regardless */ }
      try { await s.leave(); } catch {}
    }
  }, []);
  const [media, setMedia] = useState({ mic: startMic, camera: startCam, screen: false });
  const [busy, setBusy] = useState<'mic' | 'camera' | 'screen' | null>(null);
  /** Local camera stream URL — the host's own preview, not the HLS copy. */
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * Broadcast title for the ongoing notification. A ref because the foreground
   * service is started from inside the publish effect, and adding `b` to that
   * effect's dependencies would tear down and rebuild the host's LiveKit
   * session every time the viewer-count poll refreshed it.
   */
  const titleRef = useRef('');
  useEffect(() => { titleRef.current = b?.title ?? ''; }, [b?.title]);

  /**
   * WHO IS ON THE STAGE — decided by the SERVER, not by the URL.
   *
   * `host=1` is a navigation hint the client writes about itself, and it used to
   * be the only thing gating the publish path. That is why the 20-seat stage
   * could only ever hold one person: an invited co-host was minted a perfectly
   * good publish token by /broadcasts/{id}/token and then never joined the room,
   * because nothing on this screen looked at their role.
   *
   * `myRole` comes from GET /broadcasts/{id} and is recomputed by the token
   * endpoint anyway, so a client that lies about it is still handed an audience
   * grant and still refused by the media server.
   *
   * The URL param is kept ONLY as an optimistic seed for the host's very first
   * render, so their own camera does not flash the "waiting for stream" state
   * while the first fetch is in flight.
   */
  const stageRole = b?.myRole ?? (isHost ? 'host' : undefined);
  const onStage = stageRole === 'host' || stageRole === 'speaker' || stageRole === 'cohost';

  /**
   * LOW-LATENCY PLAYBACK — subscribe over WebRTC instead of pulling HLS.
   *
   * HLS is ~5s behind at best: segments have to be written, uploaded, fetched,
   * and the player holds a buffer. WebRTC is sub-second because none of that
   * happens. The cost is that a subscriber occupies a seat in the room, so it
   * cannot be how an unbounded public audience watches — a viral stream would
   * need a seat per viewer, which is exactly what HLS and a CDN exist to avoid.
   *
   * PRIVATE ONLY, therefore. A private live has a bounded, invited audience that
   * fits inside the room; a public one does not and stays on HLS.
   *
   * llFailed is the fallback. The room can refuse a seat — it is full, or the
   * network would not carry it — and an audience member must never be left
   * staring at a failure when a perfectly good HLS stream is available. On any
   * error we flip to HLS and say nothing, because from the viewer's side
   * nothing went wrong: they are watching, just a few seconds further back.
   */
  const [llFailed, setLlFailed] = useState(false);
  const lowLatency = !onStage && b?.visibility === 'private' && !llFailed;
  /** Only the OWNER may end it — a co-host publishes, but it is not their stream. */
  const isOwner = b ? b.myRole === 'host' : isHost;

  /**
   * Other people on the stage: identity -> their video stream URL.
   *
   * A speaker needs to see the host; the host needs to see their speakers.
   * Audience members are NOT here — they never join the room, which is what
   * keeps the audience unbounded while the stage stays capped.
   */
  const [stagePeers, setStagePeers] = useState<Record<string, string>>({});
  /**
   * Remote SCREEN shares, identity -> stream URL. A separate map, not a second
   * entry in stagePeers, because a publisher sends camera and screen under one
   * identity: keyed together the later arrival silently evicts the earlier, and
   * the host's face vanished the moment they shared their screen.
   */
  const [stageScreens, setStageScreens] = useState<Record<string, string>>({});
  // The publisher's video is read further down, where the stage is picked —
  // see pickStage(). On a private live the stage is the host and any co-hosts,
  // so the first tile is what this viewer came to watch.
  /** The join was refused in the way a full room is refused — see the catch below. */
  const [stageFull, setStageFull] = useState(false);

  // ── polls ───────────────────────────────────────────────────────────
  //
  // Answered by the UNBOUNDED audience, not just the 20 on stage, so the vote
  // path has to be as cheap as the chat poll it rides alongside. Refreshed on
  // the same timer as chat rather than a second one: two intervals on an
  // unbounded audience is twice the request rate for no extra freshness.
  const [polls, setPolls] = useState<BroadcastPoll[]>([]);
  const [voting, setVoting] = useState<number | null>(null);
  const [pollDraft, setPollDraft] = useState<{ q: string; opts: string[] } | null>(null);

  // ── private invitation ──────────────────────────────────────────────
  //
  // THE LINK IS THE ACCESS MECHANISM: the host shares it with whoever they
  // like, rather than picking invitees from a list before they have decided who
  // to tell. Opened automatically for a Private Live because that is the whole
  // reason for choosing private — hiding it behind a menu would leave the host
  // hunting for it while already on air.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);

  const makeInvite = useCallback(async () => {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      const l = await createInviteLink(String(id));
      // The plaintext code exists ONLY in this response — the server keeps a
      // hash — so if it is not captured here it cannot be recovered, only
      // rotated. That is why it goes straight into state.
      if (l?.url) { setInviteUrl(l.url); setInviteOpen(true); }
      else Alert.alert('Invitation', 'Could not create an invitation link.');
    } finally { setInviteBusy(false); }
  }, [id, inviteBusy]);

  // Auto-open once, for a private stream, after the host is actually live.
  const inviteAsked = useRef(false);
  useEffect(() => {
    if (invite !== '1' || inviteAsked.current || waiting || failed || !isOwner) return;
    inviteAsked.current = true;
    void makeInvite();
  }, [invite, waiting, failed, isOwner, makeInvite]);

  useEffect(() => {
    // Stage members always join. An audience member joins ONLY for low-latency
    // playback, and only when lowLatency says the trade is worth it.
    if (!onStage && !lowLatency) return;
    let session: SfuSession | null = null;
    let cancelled = false;
    (async () => {
      try {
        // A session held from a previous broadcast would still own the camera,
        // and Android refuses the second open of the same device. Leave it
        // before asking for another.
        const stale = hostSession.current;
        if (stale) {
          hostSession.current = null;
          try { await stale.leave(); } catch {}
        }
        const cred = await getBroadcastToken(String(id));
        if (cancelled) return;
        const { joinSfuRoom } = await import('../lib/golive/room');

        session = await joinSfuRoom({
          url: cred.url,
          token: cred.token,
          identity: cred.identity,
          // The SERVER's role, echoed back on the token — not what this screen
          // guessed. An audience grant reaching here would publish nothing
          // anyway (canPublish=false, empty source list), but asking to publish
          // when we may not is how a confusing "share failed" ends up on screen
          // instead of an honest read-only join.
          publish: cred.role !== 'audience',
          // BOTH gates, and the host's choice is one of them.
          //
          // This used to be `cred.role !== 'audience'` alone, which ignored the
          // setup screen entirely: the camera was opened and PUBLISHED on every
          // broadcast, then switched off a moment later by the setCamera(false)
          // below. A host who turned the camera off still went on air with it —
          // briefly, but really — and the publication showed up in the SFU's
          // track log. Not publishing it in the first place is the fix; turning
          // it off after the fact never could be.
          video: cred.role !== 'audience' && startCam,
          e2eeKey: null,
          // Other stage members' video. Audience members never appear here —
          // they are on HLS and never join the room at all.
          onTrack: (uid, url, kind, screen) => {
            if (kind !== 'video') return;
            const put = screen ? setStageScreens : setStagePeers;
            put(prev => {
              if (!url) { const { [uid]: _drop, ...rest } = prev; return rest; }
              return { ...prev, [uid]: url };
            });
          },
          onParticipant: (p, joined) => {
            if (joined) return;
            setStagePeers(prev => { const { [p.identity]: _gone, ...rest } = prev; return rest; });
            setStageScreens(prev => { const { [p.identity]: _gone, ...rest } = prev; return rest; });
          },
          // Resync the toggles from the room whenever what we publish changes,
          // including changes we did not initiate — Android's own "Stop
          // sharing" button, or a revoked MediaProjection. Without this the
          // cached flag inverts the next tap and the button looks broken.
          onLocalMedia: () => {
            const s = hostSession.current;
            const lib = mediaLib.current;
            if (!s || !lib) return;
            setMedia(lib.hostMediaState(s.room));
            // The preview URL dies with the camera track, and a stale one
            // renders a frozen frame of whatever was last captured.
            setPreview(lib.localPreviewURL(s.room));
          },
          // ── connection state, REPORTED not managed ──────────────────
          //
          // The SDK owns reconnection: DefaultReconnectPolicy retries ten times
          // across roughly forty-four seconds. Nothing below retries, rejoins or
          // tears down — these three only stop the screen from lying.
          //
          // Before this, Reconnecting was unobserved and onDisconnected was
          // never supplied, so for that whole window the host went on talking to
          // an audience that had stopped receiving, under a banner that still
          // said LIVE.
          //
          // Deliberately NOT calling leave() on Reconnecting: the session is
          // still recovering, and tearing it down is what would turn a survivable
          // blip into a dead broadcast.
          onReconnecting: () => { if (!cancelled) setReconnecting(true); },
          onReconnected: () => { if (!cancelled) setReconnecting(false); },
          // Terminal — the SDK exhausted its policy. Reuse the existing failure
          // state rather than inventing a second error path.
          onDisconnected: () => {
            if (cancelled) return;
            setReconnecting(false);
            setFailed(true);
            // Terminal means terminal: hand back the camera, the microphone
            // and the room now rather than at unmount. The screen stays on
            // FAILED, so "at unmount" could be minutes of a lit camera
            // indicator and an Android audio session nobody is using.
            void releaseOwnedMedia();
          },
        });
        if (cancelled) { await session.leave(); return; }
        hostSession.current = session;

        // HOLD A FOREGROUND SERVICE FOR THE REST OF THE BROADCAST.
        //
        // Started here — after publishing succeeded, not when the screen opened
        // — so a broadcast that never starts leaves no notification on the
        // shade. Without it, Android 12+ revokes mic and camera seconds after
        // the host switches apps: the stream goes silent and black while every
        // viewer still sees LIVE. See lib/golive/native.ts.
        //
        // Imported lazily for the same reason sfuRoom is: it reaches
        // livekit-client, which needs polyfills installed before it loads.
        const m = await import('../lib/golive/hostMedia');
        mediaLib.current = m;
        const n = await import('../lib/golive/native');
        if (cancelled) { await session.leave(); return; }
        void n.startBroadcastService(titleRef.current);

        // THE MIC CHOICE, applied here because `publish` opens the microphone
        // unconditionally and there is no per-source flag for it.
        //
        // The CAMERA is no longer switched off here: it is never opened in the
        // first place now (`video: … && startCam` above). Muting it after the
        // fact was the old behaviour and it published a camera the host had
        // turned off.
        try {
          if (!startMic) await m.setMic(session.room, false);
        } catch { /* the toggles below can still fix it */ }

        // The host's own camera, for the local preview below.
        setPreview(m.localPreviewURL(session.room));
        setMedia(m.hostMediaState(session.room));
        // THE HOST IS READY HERE — not when a playlist appears.
        //
        // Publishing to the SFU is the whole of the host's job. Egress, the
        // segment writes, the CDN and the playlist are all DOWNSTREAM of this
        // moment and belong to the viewer's readiness, not the host's.
        console.warn('[broadcast] host published to', cred.room);
        setWaiting(false);
      } catch (e: any) {
        if (!cancelled && !onStage) {
          // An AUDIENCE member failing to get a seat is not a failure — it is
          // the fallback working. Drop to HLS silently; they still watch.
          console.warn('[GOLIVE] low-latency seat refused, falling back to HLS —', e?.message ?? e);
          setLlFailed(true);
          setWaiting(false);
          return;
        }
        if (!cancelled) {
          console.warn('[GOLIVE] could not join the stage —', e?.message ?? e);
          // A FULL STAGE LOOKS EXACTLY LIKE A NETWORK FAILURE from here.
          //
          // The seat limit is enforced by the media server (room.max_participants
          // = 20), and the 21st joiner is refused with a bare "could not
          // establish signal connection" — measured on the bench. There is no
          // code or reason on that error, so the honest message names both
          // possibilities rather than asserting the wrong one. Telling a co-host
          // "nothing was published" when the truth is "the stage is full" sends
          // them to retry forever.
          setStageFull(/signal connection|could not connect/i.test(String(e?.message ?? '')));
          setFailed(true);
          setWaiting(false);
          // This catch also covers everything AFTER hostSession.current was
          // set — the foreground service and the media setup — so a throw
          // there would otherwise strand the very session that had just
          // succeeded. A no-op when the join itself was what failed.
          void releaseOwnedMedia();
        }
      }
    })();
    return () => {
      cancelled = true;
      hostSession.current = null;
      // Dropped with the session: an onLocalMedia ping arriving during teardown
      // would otherwise setState on an unmounting screen.
      mediaLib.current = null;
      // Their tiles would otherwise persist as frozen frames after we leave.
      setStagePeers({});
      setStageScreens({});
      // Stop the screen capture BEFORE leaving the room. Android keeps the
      // capture session — and its persistent "recording" notification — alive
      // past a plain disconnect, which reads to the user as VaultChat still
      // watching their screen after the broadcast ended.
      const s = session;
      const ls = localStream.current;
      localStream.current = null;
      // WE opened the capture, so we close it. userProvidedTrack means LiveKit
      // will not stop it for us, and a camera left open keeps the indicator lit.
      try { ls?.getTracks?.().forEach((t: any) => t.stop()); } catch {}
      void (async () => {
        if (s) {
          try {
            const { stopAllHostMedia } = await import('../lib/golive/hostMedia');
            await stopAllHostMedia(s.room);
          } catch { /* leaving anyway */ }
          await s.leave();
        }
      })();
    };
  }, [id, onStage, lowLatency]);

  /**
   * One handler for all three host toggles.
   *
   * Reads the room back after the change rather than trusting the local
   * optimistic value: a screen share the user declines at the system prompt
   * leaves the button "on" otherwise, and the host then believes they are
   * sharing something nobody receives.
   */
  const toggle = useCallback(async (what: 'mic' | 'camera' | 'screen') => {
    const s = hostSession.current;
    if (!s || busy) return;
    setBusy(what);
    try {
      const m = await import('../lib/golive/hostMedia');
      const want = !media[what];
      if (what === 'mic') await m.setMic(s.room, want);
      else if (what === 'camera') await m.setCamera(s.room, want);
      else await m.setScreenShare(s.room, want);
      setMedia(m.hostMediaState(s.room));
      // The camera toggle creates and destroys the local track, so the
      // preview URL changes with it — a stale one renders a frozen frame.
      setPreview(m.localPreviewURL(s.room));
    } catch (e: any) {
      // A declined system capture prompt is the common case and is not an
      // error worth an alert — say so only for screen share, where the user
      // just dismissed a dialog and needs to know nothing happened.
      if (what === 'screen') {
        Alert.alert('Screen share', 'Screen sharing did not start. Nothing is being shared.');
      }
      console.warn('[GOLIVE] toggle', what, '—', e?.message ?? e);
      try { setMedia((await import('../lib/golive/hostMedia')).hostMediaState(s.room)); } catch {}
    } finally {
      setBusy(null);
    }
  }, [busy, media]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await getBroadcast(String(id));
        if (cancelled) return;
        setB(initial);

        // VIEWERS ONLY BEYOND THIS POINT.
        //
        // The host used to run this too, and it was the bug that made every
        // broadcast look broken to the person making it: a host who had
        // connected and published perfectly still sat here waiting for a
        // viewer-facing HLS playlist, then hit waitForPlaylist's 60s timeout
        // and was told "The broadcast could not start. Nothing was published."
        // — while they were, in fact, publishing.
        //
        // Host readiness is decided by the publish effect above. Viewer
        // readiness is a playlist. They are different questions about
        // different machines and must not share a state flag.
        // STAGE MEMBERS STOP HERE. Read from the response we just got rather
        // than the derived state, which is not populated yet on first run — and
        // from myRole rather than the URL param, so an invited co-host takes the
        // publish path instead of sitting in HLS.
        const mine = initial.myRole;
        if (mine === 'host' || mine === 'speaker' || mine === 'cohost') return;

        // A stream is created as `starting` and only becomes `live` once egress
        // has produced a playlist. Showing the player before then gives a broken
        // video element and no explanation — which reads as "the app is broken"
        // rather than "the stream has not started yet".
        if (initial.status === 'live' && initial.hlsUrl) { setWaiting(false); return; }
        const ready = await waitForPlaylist(String(id));
        if (cancelled) return;
        if (ready) { setB(ready); setWaiting(false); } else { setFailed(true); setWaiting(false); }
      } catch {
        if (!cancelled) { setFailed(true); setWaiting(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [id, isHost]);

  // ── live chat + viewer heartbeat ──────────────────────────────────────
  //
  // Polling, not sockets. A broadcast audience is unbounded, and a socket per
  // viewer is exactly the fan-out the CDN exists to avoid — the whole point of
  // serving video from the edge is undone if every viewer still holds a live
  // connection to the API. A 3s poll is well inside what feels live for chat.
  const [messages, setMessages] = useState<BroadcastMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [viewers, setViewers] = useState(0);
  const lastId = useRef(0);

  useEffect(() => {
    if (waiting || failed) return;
    let alive = true;
    let n = 0;
    const tick = async () => {
      if (!alive) return;
      // The heartbeat is what keeps us in the viewer set; it expires server-side
      // so a viewer who vanishes stops being counted.
      setViewers(await watchBroadcast(String(id)));

      // NOTICE WHEN THE STREAM ENDS.
      //
      // The broadcast was fetched once, at mount, and never again — so a viewer
      // whose host had ended the stream sat watching a dead playlist under a
      // banner that still read LIVE, indefinitely. There was no path to the
      // ended state at all: `b.status` was frozen at whatever it was when the
      // screen opened.
      //
      // Every 4th tick (~12s) rather than every tick: this is a read on the hot
      // path for an unbounded audience, and 12s is well inside what "the stream
      // stopped" needs to feel correct. The chat poll stays at 3s because that
      // one is the interactive part.
      if (++n % 4 === 0) {
        try {
          const cur = await getBroadcast(String(id));
          if (!alive) return;
          setB(cur);
          if (cur.status === 'ended' || cur.status === 'failed') {
            // Stop polling immediately — the room is gone, and continuing to
            // heartbeat into it just keeps the viewer counted on a finished
            // stream.
            alive = false;
            setEnded(true);
            // AND LET GO OF THE ROOM. Stopping the poll used to be all this
            // did, which left the SFU session connected to a broadcast the
            // server had already finished. livekit-client does not know the
            // broadcast ended — it only knows its transport dropped — so it
            // kept retrying under its own policy, indefinitely, holding the
            // microphone and camera senders and waking the radio.
            //
            // Measured on device: a room from an ended broadcast was still
            // logging `reconnecting -> connected` six minutes later, alongside
            // the room of the NEXT broadcast. That is the same two-rooms-one-
            // camera collision endBroadcast() above already guards against —
            // this is the one path into the terminal state that never did.
            await releaseOwnedMedia();
            return;
          }
        } catch { /* transient — the next tick tries again */ }
      }

      // Polls ride the SAME tick as the "did it end" check (~12s) rather than
      // the 3s chat beat. A poll appears or closes rarely; chat is the
      // interactive part. On an unbounded audience that difference is a 4x cut
      // in request volume for no loss of freshness.
      if (n % 4 === 0) {
        const fp = await listPolls(String(id));
        if (!alive) return;
        setPolls(fp);
      }

      const fresh = await listBroadcastChat(String(id), lastId.current);
      if (!alive || fresh.length === 0) return;
      lastId.current = fresh[fresh.length - 1].id;
      // Bounded: a long stream would otherwise grow this list without limit and
      // eventually stutter the player it sits on top of.
      setMessages(prev => [...prev, ...fresh].slice(-200));
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(timer); void unwatchBroadcast(String(id)); };
  }, [id, waiting, failed]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const sent = await sendBroadcastChat(String(id), text);
    if (sent) {
      lastId.current = Math.max(lastId.current, sent.id);
      setMessages(prev => [...prev, sent].slice(-200));
    }
  }, [draft, id]);

  /**
   * Answer a poll.
   *
   * A vote is FINAL server-side (409 on a second attempt), so the UI must not
   * offer a way to change it — and must not optimistically paint a result that
   * the server may refuse. It re-reads instead, which also picks up everyone
   * else's votes in the same round trip.
   */
  const vote = useCallback(async (pollId: number, option: number) => {
    if (voting !== null) return;
    setVoting(pollId);
    try {
      const res = await votePoll(String(id), pollId, option);
      if (res) {
        setPolls(prev => prev.map(p => p.id === pollId
          ? { ...p, counts: res.counts, total: res.total, myVote: res.myVote } : p));
      } else {
        // Refused — already voted, closed, or not permitted. The server is the
        // authority on which; re-reading shows the truth without guessing.
        setPolls(await listPolls(String(id)));
      }
    } finally {
      setVoting(null);
    }
  }, [id, voting]);

  const submitPoll = useCallback(async () => {
    const d = pollDraft;
    if (!d) return;
    const opts = d.opts.map(o => o.trim()).filter(Boolean);
    if (!d.q.trim() || opts.length < 2) {
      Alert.alert('Poll', 'Add a question and at least two options.');
      return;
    }
    const created = await createPoll(String(id), d.q, opts);
    setPollDraft(null);
    if (created) setPolls(prev => [created, ...prev]);
    else Alert.alert('Poll', 'Could not start the poll.');
  }, [id, pollDraft]);

  const stop = useCallback(async () => {
    // TEAR THE ROOM DOWN HERE, not in the unmount cleanup.
    //
    // Relying on unmount left the old LiveKit session alive: measured on device,
    // the app was `participant active` in the ENDED room and the new one at the
    // same time. Two rooms then fight over one camera — and on Android the
    // second open of the same camera fails outright — so the new broadcast
    // churned through HOST_DISCONNECTED / HOST_RECONNECTED indefinitely.
    //
    // Awaited before navigating, so the room is genuinely gone before the next
    // broadcast can start. The unmount cleanup still runs and is idempotent.
    const s = hostSession.current;
    hostSession.current = null;
    const ls = localStream.current;
    localStream.current = null;
    try { ls?.getTracks?.().forEach((t: any) => t.stop()); } catch {}
    if (s) {
      try {
        const { stopAllHostMedia } = await import('../lib/golive/hostMedia');
        await stopAllHostMedia(s.room);
      } catch { /* leaving regardless */ }
      try { await s.leave(); } catch {}
    }
    await endBroadcast(String(id), b?.viewerCount ?? 0, b?.peakViewers ?? 0);
    router.back();
  }, [id, b, router]);

  /**
   * A viewer leaving. Never ends the broadcast — that is the host's alone.
   *
   * Tears the SFU session down explicitly rather than relying on the unmount
   * effect: a promoted co-host holds a real publishing session here, and their
   * camera and microphone must stop the moment they leave rather than whenever
   * the screen happens to be collected.
   *
   * replace('/live'), not back(): arriving through an invitation link replaces
   * the history, so back() would drop this viewer out of the app instead of
   * onto the Go Live list.
   */
  const leaveAsViewer = useCallback(async () => {
    const s = hostSession.current;
    hostSession.current = null;
    mediaLib.current = null;
    if (s) {
      try {
        const { stopAllHostMedia } = await import('../lib/golive/hostMedia');
        await stopAllHostMedia(s.room);
      } catch { /* leaving regardless */ }
      try { await s.leave(); } catch {}
    }
    router.replace('/live' as any);
  }, [router]);

  const confirmStop = () => Alert.alert(
    'End broadcast?',
    'Viewers will be disconnected.',
    [{ text: 'Keep going', style: 'cancel' }, { text: 'End', style: 'destructive', onPress: stop }],
  );

  // ── THE IMMERSIVE STAGE ─────────────────────────────────────────
  //
  // Everything below used to be absolutely positioned at hand-measured pixel
  // offsets — top: 100, bottom: 300, bottom: 352 — chosen against one handset.
  // On a short screen the poll card and the chat overlapped the controls; on a
  // tall one the status pill floated in the middle of nowhere. The offsets are
  // gone: the chrome is now a flex column pinned to the real safe area, so it
  // lands correctly on a 5" 16:9 phone and a 6.9" 20:9 one without either being
  // measured.

  /** Nothing to be immersive about until there is something on the stage. */
  const stageReady = !waiting && !failed && !ended;

  /**
   * Which stream owns the full frame, and which shrinks to the corner.
   *
   * A screen share always wins the stage: it is the thing being shown, and it
   * carries text that is unreadable in a thumbnail. The camera keeps a face on
   * screen — the reason a live stream is worth watching over a screenshot — so
   * it becomes the picture-in-picture rather than disappearing.
   */
  const llStreamCam = lowLatency ? Object.values(stagePeers)[0] : undefined;
  const llScreen = lowLatency ? Object.values(stageScreens)[0] : undefined;
  // A HOST NEVER RENDERS THEIR OWN SCREEN CAPTURE.
  //
  // FLAG_SECURE excludes VaultChat's own window from MediaProjection — that is
  // the rule, and it is not negotiable. The consequence is that the host's own
  // capture is BLACK for exactly as long as they are looking at this screen, so
  // promoting it to the stage replaced the host's camera with a black rectangle
  // and read as "screen sharing is broken". It was not: viewers were receiving
  // the share the whole time.
  //
  // So the host keeps their camera on the stage and a chip that says a share is
  // running. Viewers — who are not excluded from anything — get the share on
  // the stage with the host's camera in the corner, which is the whole point.
  const screenStream = onStage ? null : (llScreen ?? null);
  const stage = pickStage(onStage ? preview : llStreamCam, screenStream);
  const mainStream = stage.main;
  const pipStream = stage.pip;

  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /**
   * PIP GEOMETRY, DERIVED — never a fixed 120x160 box.
   *
   * A quarter of the SHORT edge, so it is the same visual weight in portrait
   * and landscape and on any panel size, then clamped so it is neither a
   * postage stamp on a small phone nor a second stage on a tablet.
   */
  const { width: pipW, height: pipH } = pipSize(win.width, win.height);

  /**
   * Chrome: shown, then out of the way.
   *
   * Hidden permanently would strand a viewer with no way off the screen, so it
   * starts visible, retires after a few seconds of an undisturbed stream, and
   * comes back on a double tap. Forced ON whenever there is no stream — a
   * waiting or failed screen has nothing to reveal and every reason to keep its
   * exit reachable.
   */
  const [chrome, setChrome] = useState(true);
  const chromeShown = chrome || !stageReady;
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const seenChat = useRef(0);

  useEffect(() => {
    if (chatOpen) { seenChat.current = messages.length; setUnread(0); }
    else setUnread(Math.max(0, messages.length - seenChat.current));
  }, [messages, chatOpen]);

  // Anything the user has deliberately opened pins the chrome open: retiring
  // the bar out from under a half-typed message is the kind of "helpful" that
  // loses the message.
  const pinned = chatOpen || inviteOpen || pollDraft !== null;
  useEffect(() => {
    if (!stageReady || !chrome || pinned) return;
    const t = setTimeout(() => setChrome(false), 5000);
    return () => clearTimeout(t);
  }, [stageReady, chrome, pinned]);

  /**
   * DOUBLE TAP toggles the chrome.
   *
   * Single tap is deliberately inert: on a live stream the only thing a stray
   * tap could do is hide the exit, and a thumb resting on a phone is a stray
   * tap. 320ms is the standard double-tap window.
   */
  const lastTap = useRef(0);
  const tapStage = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 320) { lastTap.current = 0; setChrome(v => !v); return; }
    lastTap.current = now;
  }, []);

  const openChat = useCallback(() => { setChatOpen(true); setChrome(true); }, []);

  return (
    <View style={S.root}>
      <Stack.Screen options={{ title: b?.title || 'Live', headerTransparent: true, headerTintColor: '#fff' }} />

      {ended ? (
        // A finished stream is not a failure and must not be dressed as one:
        // the viewer saw the whole thing, it is simply over.
        <View style={S.center}>
          <Ionicons name="checkmark-circle-outline" size={40} color="#94A3B8" />
          <AppText style={S.centerText}>This broadcast has ended.</AppText>
          <TouchableOpacity onPress={() => router.back()} style={S.backBtn}>
            <AppText style={S.backText}>Go back</AppText>
          </TouchableOpacity>
        </View>
      ) : waiting ? (
        <View style={S.center}>
          <ActivityIndicator color="#fff" />
          <AppText style={S.centerText}>
            {onStage ? 'Starting your broadcast…' : 'Waiting for the stream…'}
          </AppText>
        </View>
      ) : failed ? (
        <View style={S.center}>
          <Ionicons name="cloud-offline-outline" size={40} color="#94A3B8" />
          <AppText style={S.centerText}>
            {onStage
              ? (stageFull
                  ? 'Could not join the stage. It may already have 20 people on it, or your connection dropped.'
                  : 'The broadcast could not start. Nothing was published.')
              : 'This stream is not available.'}
          </AppText>
          <TouchableOpacity onPress={() => router.back()} style={S.backBtn}>
            <AppText style={S.backText}>Go back</AppText>
          </TouchableOpacity>
        </View>
      ) : onStage ? (
        // Stage members see their OWN camera, live off this device.
        //
        // Deliberately NOT the HLS player: that is the viewer's delayed copy of
        // this same camera, seconds behind, and pointing a host at it is both
        // useless and a feedback loop. The local track has no such delay.
        //
        // Mirrored, like every self-view: an unmirrored front camera reads as
        // wrong to the person looking at it.
        mainStream ? (
          // A screen share takes the stage and the camera drops to the corner.
          // `contain` for a screen, never `cover`: cropping a shared screen
          // cuts off exactly the edges — toolbars, the last column — that the
          // host is sharing it to show. `cover` stays right for a camera, where
          // a cropped face beats a letterboxed one.
          //
          // Mirrored only for the camera. A mirrored screen share is unreadable.
          <>
            <RTCView
              streamURL={mainStream}
              style={S.video}
              objectFit={screenStream ? 'contain' : 'cover'}
              mirror={!screenStream}
              zOrder={0}
            />
            {media.screen && (
              // The one thing the host cannot see for themselves. Says a share
              // is live AND why this screen is not showing it, so a black
              // rectangle is never the answer to "is it working?".
              <View style={[S.sharingChip, { top: insets.top + 56 }]} pointerEvents="none">
                <Ionicons name="phone-portrait" size={13} color="#fff" />
                <AppText style={S.sharingText}>Sharing your screen — viewers see it</AppText>
              </View>
            )}
          </>
        ) : (
          // No camera track: the host turned it off, or is broadcasting audio
          // or screen only. All legitimate — say what is true rather than
          // implying a failure, and keep the controls on screen.
          <View style={S.center}>
            <Ionicons name="radio-outline" size={40} color="#EF4444" />
            <AppText style={S.centerText}>
              {media.screen ? 'You are live — sharing your screen.' : 'You are live.'}
            </AppText>
            <AppText style={S.centerText}>
              {b?.status === 'live'
                ? 'Viewers can watch now.'
                : 'Viewers can watch once the stream is ready.'}
            </AppText>
          </View>
        )
      ) : lowLatency && !mainStream ? (
        // A low-latency join is in flight. Show the spinner rather than falling
        // through to HLS: starting the HLS player here spins up a decoder and
        // fetches segments we are about to throw away, and the viewer watches
        // ~5s-delayed video for a moment before it jumps forward as WebRTC takes
        // over. Measured: one ExoPlayer Init immediately followed by a Release.
        //
        // Nothing is lost by waiting — llFailed flips on any join failure, which
        // clears lowLatency and puts this same render on the HLS branch.
        <View style={S.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <AppText style={S.centerText}>Connecting…</AppText>
        </View>
      ) : mainStream ? (
        // Sub-second path: the publisher's track straight off the SFU. No
        // playlist, no segments, no buffer — which is the entire point.
        //
        // Same stage rule as the host's own view: their screen share, if they
        // have one, is what this viewer came to look at.
        <RTCView streamURL={mainStream} style={S.video} objectFit="contain" zOrder={0} />
      ) : !b?.hlsUrl ? (
        <View style={S.center}>
          <Ionicons name="cloud-offline-outline" size={40} color="#94A3B8" />
          <AppText style={S.centerText}>This stream is not available.</AppText>
          <TouchableOpacity onPress={() => router.back()} style={S.backBtn}>
            <AppText style={S.backText}>Go back</AppText>
          </TouchableOpacity>
        </View>
      ) : (
        <Video
          ref={video}
          source={{ uri: b.hlsUrl }}
          style={S.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          // NO NATIVE CONTROLS. They have no job on a live edge — there is
          // nothing to seek and nothing to resume — and they used to be the
          // only thing on screen, swallowing the taps that reveal our own
          // chrome and leaving a viewer with no way off the screen at all.
          useNativeControls={false}
          // Live HLS has no meaningful end; looping a live edge would restart
          // playback at the first cached segment instead of following the feed.
          isLooping={false}
        />
      )}

      {/* DOUBLE-TAP CATCHER.
          Full-bleed and BELOW the chrome, so it only ever sees taps that
          landed on the stream itself — a tap on Leave stays a tap on Leave. */}
      {stageReady && <Pressable style={StyleSheet.absoluteFill} onPress={tapStage} />}

      {/* CAMERA PICTURE-IN-PICTURE.
          Only while something else owns the stage, which today means a screen
          share. Sized from the window rather than fixed, and parked below the
          top row so it never sits under the status pill on a notched phone.
          pointerEvents="none": it must not eat the double tap it floats over. */}
      {stageReady && pipStream && (
        <View
          style={[S.pip, { width: pipW, height: pipH, top: insets.top + 56, right: SPACING.lg }]}
          pointerEvents="none"
        >
          <RTCView
            streamURL={pipStream}
            style={S.pipVideo}
            objectFit="cover"
            mirror={onStage}
            // Above the stage's own surface. Without this, Android composites
            // the two SurfaceViews in creation order and the PiP renders
            // BEHIND the stream — present in the tree, invisible on the glass.
            zOrder={1}
          />
        </View>
      )}

      {/* ── CHROME ──────────────────────────────────────────────────
          One flex column against the real safe area. Every child is laid out,
          not positioned: nothing here carries a pixel offset that assumes a
          screen size. box-none throughout so the stream keeps receiving taps
          everywhere the chrome has not actually drawn a control. */}
      {!ended && chromeShown && (
        <View
          style={[S.chrome, { paddingTop: insets.top + SPACING.sm, paddingBottom: insets.bottom + SPACING.sm }]}
          pointerEvents="box-none"
        >
          {/* TOP ROW — status on the left, every action as a small icon on the
              right. The exit lives here on purpose: it is the one control a
              viewer must always be able to find. */}
          <View style={S.topRow} pointerEvents="box-none">
            {b && (
              <View style={S.bar}>
                {/* Amber, not red: the stream is not live and it has not ended
                    either. The SDK is still recovering the transport, so the
                    strip must say so rather than keep asserting LIVE — that
                    assertion is the defect this closes. */}
                <View style={[S.liveDot, reconnecting && S.reconnectDot]} />
                <AppText style={S.barText}>
                  {reconnecting
                    ? 'RECONNECTING…'
                    // `failed` BEFORE b.status, because b.status is the last
                    // snapshot the POLL managed to fetch — and the poll is
                    // exactly what cannot run when the network is the thing
                    // that broke. Local terminal knowledge is fresher than an
                    // unreachable server, so it wins.
                    : failed ? 'FAILED'
                    : b.status === 'live' ? 'LIVE' : b.status.toUpperCase()}
                </AppText>
                <AppText style={S.barDim}>{viewers || b.viewerCount}</AppText>
                {!b.e2ee && <AppText style={S.barDim}>· Not encrypted</AppText>}
              </View>
            )}

            <View style={S.grow} pointerEvents="none" />

            {stageReady && (
              <TouchableOpacity
                onPress={openChat}
                style={[S.icon, chatOpen && S.iconOn]}
                accessibilityLabel="Chat"
                hitSlop={8}
              >
                <Ionicons name="chatbubble-ellipses-outline" size={18} color="#fff" />
                {/* Chat is folded away by default now, so a silent icon would
                    hide the whole conversation. The count is what says
                    something is happening down there. */}
                {!chatOpen && unread > 0 && (
                  <View style={S.badge}>
                    <AppText style={S.badgeText}>{unread > 99 ? '99+' : String(unread)}</AppText>
                  </View>
                )}
              </TouchableOpacity>
            )}

            {isOwner && stageReady && (
              <TouchableOpacity
                onPress={() => setPollDraft({ q: '', opts: ['', ''] })}
                style={S.icon}
                accessibilityLabel="Create a poll"
                hitSlop={8}
              >
                <Ionicons name="stats-chart" size={18} color="#fff" />
              </TouchableOpacity>
            )}

            {isOwner && b?.visibility === 'private' && stageReady && (
              <TouchableOpacity
                onPress={() => (inviteUrl ? setInviteOpen(true) : makeInvite())}
                style={S.icon}
                accessibilityLabel="Invite people"
                hitSlop={8}
              >
                <Ionicons name="person-add-outline" size={18} color="#fff" />
              </TouchableOpacity>
            )}

            {/* THE EXIT. The host ends the broadcast (confirmed first — it
                disconnects everyone); a viewer just leaves.

                leaveAsViewer, not router.back(): a viewer who arrived through
                an invitation link got here via router.replace and has no
                history, so back exits the app. */}
            {isOwner ? (
              !waiting && (
                <TouchableOpacity
                  onPress={confirmStop}
                  style={[S.icon, S.iconDanger]}
                  accessibilityLabel="End broadcast"
                  hitSlop={8}
                >
                  <Ionicons name="stop" size={18} color="#fff" />
                </TouchableOpacity>
              )
            ) : (
              <TouchableOpacity
                onPress={leaveAsViewer}
                style={[S.icon, S.iconDanger]}
                accessibilityLabel="Leave"
                hitSlop={8}
              >
                <Ionicons name="close" size={18} color="#fff" />
              </TouchableOpacity>
            )}
          </View>

          {/* OTHER PEOPLE ON THE STAGE.
              A strip of small tiles, not a grid: the main frame belongs to
              whoever this device is watching, and the stage is at most 20
              people while the audience is unbounded. Cameras only — a screen
              share belongs on the stage or in the corner, never in a 72px tile
              where nothing on it can be read. */}
          {onStage && Object.keys(stagePeers).length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={S.stageStrip}
              contentContainerStyle={S.stageStripInner}
            >
              {Object.entries(stagePeers).map(([uid, url]) => (
                <RTCView key={uid} streamURL={url} style={S.stageTile} objectFit="cover" zOrder={1} />
              ))}
            </ScrollView>
          )}

          <View style={S.grow} pointerEvents="none" />

          {/* ── BOTTOM STACK ────────────────────────────────────────
              Stacked in one column instead of each pinned at its own hard
              offset, which is what used to let the poll card, the invite sheet
              and the chat draw on top of each other on a short screen. */}
          {stageReady && (
            <KeyboardAvoidingView
              // The whole point of the chat icon: tapping it must lift the
              // composer clear of the keyboard rather than bury it under one.
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={S.bottom}
              pointerEvents="box-none"
            >
              {/* POLLS — above the chat, because a poll is a call to action and
                  chat is ambient. Only the newest OPEN poll is shown: stacking
                  several would bury the stream this is drawn on top of. Closed
                  ones stay in the list server-side for the record. */}
              {polls.filter(pl => !pl.closed).slice(0, 1).map(pl => {
                const answered = pl.myVote >= 0;
                return (
                  <View key={pl.id} style={S.poll}>
                    <View style={S.pollHead}>
                      <Ionicons name="stats-chart" size={13} color="#FCD34D" />
                      <AppText style={S.pollQ} numberOfLines={2}>{pl.question}</AppText>
                      {isOwner && (
                        <TouchableOpacity onPress={() => { void closePoll(String(id), pl.id); setPolls(prev => prev.map(x => x.id === pl.id ? { ...x, closed: true } : x)); }}>
                          <AppText style={S.pollClose}>End</AppText>
                        </TouchableOpacity>
                      )}
                    </View>
                    {pl.options.map((opt, i) => {
                      // Percentages only AFTER voting. Showing the running
                      // tally to someone who has not answered biases the
                      // answer, and on an unbounded audience that is not a
                      // rounding error.
                      const pct = pl.total > 0 ? Math.round((pl.counts[i] ?? 0) * 100 / pl.total) : 0;
                      const mine = pl.myVote === i;
                      return (
                        <TouchableOpacity
                          key={i}
                          disabled={answered || voting !== null}
                          onPress={() => vote(pl.id, i)}
                          style={S.pollOpt}
                          activeOpacity={0.85}
                        >
                          {answered && <View style={[S.pollBar, { width: `${pct}%` }, mine && S.pollBarMine]} />}
                          <AppText style={[S.pollOptText, mine && S.pollOptMine]} numberOfLines={1}>
                            {mine ? '✓ ' : ''}{opt}
                          </AppText>
                          {answered && <AppText style={S.pollPct}>{pct}%</AppText>}
                        </TouchableOpacity>
                      );
                    })}
                    <AppText style={S.pollTotal}>
                      {answered ? `${pl.total} ${pl.total === 1 ? 'vote' : 'votes'}` : 'Tap to vote'}
                    </AppText>
                  </View>
                );
              })}

              {/* Host: compose a poll. */}
              {isOwner && pollDraft && (
                <View style={S.pollCompose}>
                  <TextInput
                    value={pollDraft.q}
                    onChangeText={t => setPollDraft(d => d && { ...d, q: t })}
                    placeholder="Ask your viewers something…"
                    placeholderTextColor="#94A3B8"
                    style={S.pollInput}
                    maxLength={200}
                    autoFocus
                  />
                  {pollDraft.opts.map((o, i) => (
                    <TextInput
                      key={i}
                      value={o}
                      onChangeText={t => setPollDraft(d => d && { ...d, opts: d.opts.map((x, j) => j === i ? t : x) })}
                      placeholder={`Option ${i + 1}`}
                      placeholderTextColor="#64748B"
                      style={S.pollInput}
                      maxLength={100}
                    />
                  ))}
                  <View style={S.pollBtnRow}>
                    {pollDraft.opts.length < 10 && (
                      <TouchableOpacity onPress={() => setPollDraft(d => d && { ...d, opts: [...d.opts, ''] })}>
                        <AppText style={S.pollAdd}>+ Option</AppText>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={() => setPollDraft(null)}>
                      <AppText style={S.pollCancel}>Cancel</AppText>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={submitPoll}>
                      <AppText style={S.pollGo}>Start poll</AppText>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* PRIVATE INVITATION — the link IS the access mechanism.
                  Shows the URL, and nothing else: no room name, no key, no
                  infrastructure detail. Copy and Share both hand over the same
                  opaque code, which grants VIEWING only — a seat on the stage
                  still needs the host to promote you. */}
              {inviteOpen && inviteUrl && (
                <View style={S.inviteSheet}>
                  <View style={S.inviteHead}>
                    <Ionicons name="lock-closed" size={14} color="#FCD34D" />
                    <AppText style={S.inviteTitle}>Private live — invite people</AppText>
                    <TouchableOpacity onPress={() => setInviteOpen(false)} hitSlop={8}>
                      <Ionicons name="close" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                  </View>
                  <AppText style={S.inviteHint}>
                    {pc
                      ? 'Viewers need this link AND the passcode. Send them separately — that is what makes a forwarded link useless on its own.'
                      : 'Anyone with this link can watch. Send it however you like.'}
                  </AppText>
                  <AppText style={S.inviteUrl} numberOfLines={2} selectable>{inviteUrl}</AppText>

                  {/* The passcode, if this broadcast has one.

                      Shown from the route param, not from the server: only a
                      bcrypt hash is stored, so there is nothing to fetch back.
                      Its own Copy button because it must travel on a DIFFERENT
                      channel from the link — pasting both into one message
                      defeats the entire point. */}
                  {!!pc && (
                    <View style={S.pcRow}>
                      <View style={S.grow}>
                        <AppText style={S.pcLabel}>Passcode</AppText>
                        <AppText style={S.pcValue} selectable>{pc}</AppText>
                      </View>
                      <TouchableOpacity
                        style={S.inviteBtn}
                        onPress={async () => {
                          await Clipboard.setStringAsync(pc);
                          Alert.alert('Copied', 'Passcode copied. Send it separately from the link.');
                        }}
                      >
                        <Ionicons name="copy-outline" size={15} color="#fff" />
                        <AppText style={S.inviteBtnText}>Copy</AppText>
                      </TouchableOpacity>
                    </View>
                  )}
                  <View style={S.inviteRow}>
                    <TouchableOpacity
                      style={S.inviteBtn}
                      onPress={async () => {
                        await Clipboard.setStringAsync(inviteUrl);
                        Alert.alert('Copied', 'Invite link copied.');
                      }}
                    >
                      <Ionicons name="copy-outline" size={15} color="#fff" />
                      <AppText style={S.inviteBtnText}>Copy</AppText>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={S.inviteBtn}
                      onPress={() => Share.share({ message: 'Join my private live on VaultChat\n' + inviteUrl })}
                    >
                      <Ionicons name="share-social-outline" size={15} color="#fff" />
                      <AppText style={S.inviteBtnText}>Share</AppText>
                    </TouchableOpacity>
                    <TouchableOpacity style={S.inviteBtn} onPress={makeInvite} disabled={inviteBusy}>
                      <Ionicons name="refresh-outline" size={15} color="#fff" />
                      <AppText style={S.inviteBtnText}>New link</AppText>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* CHAT — folded away behind the icon in the top row.
                  It used to sit open over the bottom third of every stream,
                  which on a phone is the third the stream is actually in. Open
                  it and the composer takes focus immediately, because tapping a
                  chat icon has exactly one intention. */}
              {chatOpen && (
                <View style={S.chatWrap} pointerEvents="box-none">
                  <View style={S.chatHead}>
                    <AppText style={S.chatHeadText}>Live chat</AppText>
                    <TouchableOpacity onPress={() => setChatOpen(false)} hitSlop={10}>
                      <Ionicons name="chevron-down" size={18} color="#94A3B8" />
                    </TouchableOpacity>
                  </View>
                  <ScrollView
                    style={[S.chatList, { maxHeight: Math.round(win.height * 0.28) }]}
                    contentContainerStyle={S.chatListInner}
                    showsVerticalScrollIndicator={false}
                  >
                    {messages.map(m => (
                      <AppText key={m.id} style={S.chatLine} numberOfLines={3}>
                        <AppText style={S.chatName}>{m.name || 'Someone'} </AppText>
                        {m.message}
                      </AppText>
                    ))}
                  </ScrollView>
                  <View style={S.chatInputRow}>
                    <TextInput
                      value={draft}
                      onChangeText={setDraft}
                      placeholder="Say something…"
                      placeholderTextColor="#94A3B8"
                      style={S.chatInput}
                      maxLength={500}
                      onSubmitEditing={send}
                      returnKeyType="send"
                      autoFocus
                    />
                    <TouchableOpacity onPress={send} style={S.chatSend}>
                      <Ionicons name="send" size={18} color="#fff" />
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Host controls. Rendered only when there is a session to drive
                  — a host whose publish failed gets no buttons rather than dead
                  ones.

                  The publish permission is in the TOKEN, not here: an audience
                  grant has canPublish=false and an empty source list, so hiding
                  these is a courtesy and the media server is the enforcement. */}
              {onStage && hostSession.current && (
                <View style={S.controls}>
                  {([
                    ['mic', media.mic ? 'mic' : 'mic-off', 'Microphone'],
                    ['camera', media.camera ? 'videocam' : 'videocam-off', 'Camera'],
                    ['screen', media.screen ? 'phone-portrait' : 'phone-portrait-outline', 'Screen'],
                  ] as const).map(([what, icon, label]) => (
                    <TouchableOpacity
                      key={what}
                      onPress={() => toggle(what)}
                      disabled={busy !== null}
                      accessibilityLabel={label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: media[what], disabled: busy !== null }}
                      style={[
                        S.ctrl,
                        // Screen share is the one that is ON when highlighted;
                        // mic and camera are highlighted when OFF, because
                        // "muted" is the state a host needs to spot at a glance.
                        (what === 'screen' ? media.screen : !media[what]) && S.ctrlActive,
                      ]}
                      activeOpacity={0.85}
                    >
                      {busy === what
                        ? <ActivityIndicator color="#fff" size="small" />
                        : <Ionicons name={icon as any} size={20} color="#fff" />}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </KeyboardAvoidingView>
          )}
        </View>
      )}

    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.lg, padding: SPACING.xl },
  centerText: { color: '#CBD5E1', fontSize: 15, textAlign: 'center' },
  backBtn: { paddingHorizontal: SPACING.xl, paddingVertical: SPACING.md, borderRadius: RADIUS.pill, backgroundColor: '#1E293B' },
  backText: { color: '#fff', fontWeight: '600' },

  // ── ADAPTIVE CHROME ───────────────────────────────────────────────
  //
  // No `top:`, no `bottom:`, no magic numbers. The layer fills the screen and
  // its children flex within it; the only offsets are the safe-area insets,
  // supplied at render time by the device. That is the whole of what makes this
  // fit a 5" phone and a 6.9" one without either being measured.
  chrome: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: SPACING.lg,
  },
  /** Eats the leftover space. Used both as a row spacer and a column spacer. */
  grow: { flex: 1 },
  topRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    // Wraps rather than squeezing: a host on a narrow phone has status plus
    // four icons, and a squeezed row is how a control ends up unhittable.
    flexWrap: 'wrap',
  },
  /** Every top-row action. One size, so the row reads as a set. */
  icon: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.85)',
  },
  iconOn: { backgroundColor: 'rgba(59,130,246,0.9)' },
  iconDanger: { backgroundColor: 'rgba(185,28,28,0.92)' },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 17, height: 17,
    borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#EF4444',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  /** Camera picture-in-picture. Width and height come from the window. */
  pip: {
    position: 'absolute', borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: '#0F172A',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
  },
  pipVideo: { flex: 1 },

  /** Bottom stack: polls, invite, chat, controls — in that order, in one flow. */
  bottom: { gap: SPACING.sm },
  /** Host-only "a share is running" chip. `top` is supplied from the insets. */
  sharingChip: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: 'rgba(185,28,28,0.9)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs, borderRadius: RADIUS.pill,
  },
  sharingText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.pill,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  /** Amber while the SDK reconnects — not red (live), not grey (ended). */
  reconnectDot: { backgroundColor: '#F59E0B' },
  barText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  barDim: { color: '#94A3B8', fontSize: 11 },
  inviteSheet: {
    backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: RADIUS.lg,
    padding: SPACING.md, gap: 6,
  },
  inviteHead:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  inviteTitle: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '700' },
  inviteHint:  { color: '#94A3B8', fontSize: 11 },
  pcRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)',
  },
  pcLabel: { color: '#94A3B8', fontSize: 11, fontWeight: '600' },
  pcValue: { color: '#fff', fontSize: 18, fontWeight: '700', letterSpacing: 2 },
  inviteUrl: {
    color: '#E2E8F0', fontSize: 11, backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: RADIUS.sm, padding: SPACING.sm, marginTop: 2,
  },
  inviteRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: 4 },
  inviteBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: SPACING.sm, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(51,65,85,0.9)',
  },
  inviteBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  poll: {
    backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: RADIUS.lg, padding: SPACING.md, gap: 6,
  },
  pollHead:    { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: 2 },
  pollQ:       { flex: 1, color: '#fff', fontSize: 13, fontWeight: '700' },
  pollClose:   { color: '#F87171', fontSize: 11, fontWeight: '700' },
  pollOpt: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 7,
    paddingHorizontal: SPACING.sm, borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden',
  },
  // The bar sits BEHIND the label, so a long option is never clipped by it.
  pollBar:     { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(148,163,184,0.35)' },
  pollBarMine: { backgroundColor: 'rgba(239,68,68,0.45)' },
  pollOptText: { flex: 1, color: '#E2E8F0', fontSize: 12 },
  pollOptMine: { color: '#fff', fontWeight: '700' },
  pollPct:     { color: '#CBD5E1', fontSize: 11, fontWeight: '700' },
  pollTotal:   { color: '#94A3B8', fontSize: 10, marginTop: 2 },
  pollCompose: {
    backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: RADIUS.lg, padding: SPACING.md, gap: 6,
  },
  pollInput: {
    color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: RADIUS.sm, paddingHorizontal: SPACING.sm, paddingVertical: 7, fontSize: 13,
  },
  pollBtnRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.lg, marginTop: 4 },
  pollAdd:     { color: '#93C5FD', fontSize: 12, fontWeight: '600' },
  pollCancel:  { color: '#94A3B8', fontSize: 12, marginLeft: 'auto' },
  pollGo:      { color: '#FCD34D', fontSize: 12, fontWeight: '800' },
  // Directly under the top row, in flow: the stage is context, the stream is
  // the subject.
  stageStrip:      { flexGrow: 0, marginTop: SPACING.sm, maxHeight: 96 },
  stageStripInner: { gap: SPACING.sm },
  stageTile:       { width: 72, height: 96, borderRadius: RADIUS.md, backgroundColor: '#0F172A', overflow: 'hidden' },
  controls: {
    flexDirection: 'row', alignSelf: 'center', gap: SPACING.md, marginTop: SPACING.xs,
  },
  ctrl: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,41,59,0.85)',
  },
  ctrlActive: { backgroundColor: '#B91C1C' },
  // Opened on demand, and only as tall as the window allows — the maxHeight is
  // computed from the live window at render time, not guessed at here.
  chatWrap:      { backgroundColor: 'rgba(2,6,23,0.72)', borderRadius: RADIUS.lg, paddingVertical: SPACING.sm },
  chatHead:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingBottom: 4 },
  chatHeadText:  { flex: 1, color: '#94A3B8', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  chatList:      {},
  chatListInner: { paddingHorizontal: SPACING.md, gap: 4 },
  chatLine:      { color: '#E2E8F0', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3 },
  chatName:      { color: '#FCD34D', fontWeight: '700' },
  chatInputRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
                   paddingHorizontal: SPACING.md, marginTop: SPACING.sm },
  chatInput:     { flex: 1, color: '#fff', backgroundColor: 'rgba(0,0,0,0.55)',
                   borderRadius: RADIUS.pill, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  chatSend:      { backgroundColor: 'rgba(0,0,0,0.55)', padding: SPACING.md, borderRadius: RADIUS.pill },
});
