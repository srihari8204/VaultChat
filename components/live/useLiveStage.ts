// components/live/useLiveStage.ts — the Go Live stage session, as a hook.
//
// Moved out of app/live-view.tsx unchanged: joining the SFU room (stage members
// to publish, private-live viewers for low-latency playback), the media this
// screen owns and must release, the remote stage tiles, and the host's
// mic/camera/screen toggles. The screen passes in what it decides (the role,
// the broadcast) and the two state setters it shares with the viewer path.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { getBroadcastToken } from '../../lib/call/sfuToken';

// Imported LAZILY in the effect below, for the reason given in app/live-view.tsx:
// it pulls in livekit-client, which needs polyfills installed at import time.
type SfuSession = Awaited<ReturnType<typeof import('../../lib/golive/room').joinSfuRoom>>;

export function useLiveStage({
  id, onStage, privateLive, startCam, startMic, title, setWaiting, setFailed,
}: {
  id: string | undefined;
  /** The SERVER's role puts this device on the stage (see live-view `onStage`). */
  onStage: boolean;
  /** The broadcast is private, so an audience member may try low latency. */
  privateLive: boolean;
  startCam: boolean;
  startMic: boolean;
  /** Broadcast title, for the ongoing notification. */
  title: string;
  setWaiting: (v: boolean) => void;
  setFailed: (v: boolean) => void;
}) {
  /**
   * The SDK is recovering the transport. TEMPORARY and non-destructive — the
   * broadcast is not over, the tracks are not torn down, and nothing here
   * retries. It exists so the screen can stop claiming LIVE during the window
   * the SDK spends reconnecting. Cleared by onReconnected, or superseded by
   * `failed` if the SDK ultimately gives up.
   */
  const [reconnecting, setReconnecting] = useState(false);


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
  const mediaLib = useRef<typeof import('../../lib/golive/hostMedia') | null>(null);
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
        const { stopAllHostMedia } = await import('../../lib/golive/hostMedia');
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
  useEffect(() => { titleRef.current = title; }, [title]);

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
  const lowLatency = !onStage && privateLive && !llFailed;

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
  /**
   * Stream URL -> the publisher's real frame size, as the SFU reports it.
   *
   * This is what makes the stage responsive rather than guessed: an Honor
   * sharing 600x1332 and a desktop sharing 1920x1080 want opposite treatment on
   * the same phone, and only the frame itself can say which. Absent for a
   * publisher whose dimensions have not arrived — pickFit() has an answer for
   * that, so nothing here invents one.
   */
  const [stageDims, setStageDims] = useState<Record<string, { width: number; height: number }>>({});
  // The publisher's video is read further down, where the stage is picked —
  // see pickStage(). On a private live the stage is the host and any co-hosts,
  // so the first tile is what this viewer came to watch.
  /** The join was refused in the way a full room is refused — see the catch below. */
  const [stageFull, setStageFull] = useState(false);

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
        const { joinSfuRoom } = await import('../../lib/golive/room');

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
          onTrack: (uid, url, kind, screen, dims) => {
            if (kind !== 'video') return;
            const put = screen ? setStageScreens : setStagePeers;
            put(prev => {
              if (!url) { const { [uid]: _drop, ...rest } = prev; return rest; }
              return { ...prev, [uid]: url };
            });
            // The publisher's real frame size, kept per stream URL so the stage
            // can size itself to what is actually arriving. Keyed by URL rather
            // than by identity because one identity sends two video tracks.
            setStageDims(prev => {
              if (!url) return prev;
              if (!dims) { const { [url]: _none, ...rest } = prev; return rest; }
              return { ...prev, [url]: dims };
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
        const m = await import('../../lib/golive/hostMedia');
        mediaLib.current = m;
        const n = await import('../../lib/golive/native');
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
      // past a plain disconnect, which reads to the user as crazzychat still
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
            const { stopAllHostMedia } = await import('../../lib/golive/hostMedia');
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
      const m = await import('../../lib/golive/hostMedia');
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
      try { setMedia((await import('../../lib/golive/hostMedia')).hostMediaState(s.room)); } catch {}
    } finally {
      setBusy(null);
    }
  }, [busy, media]);

  return {
    hostSession, releaseOwnedMedia, media, busy, preview, toggle,
    stagePeers, stageScreens, stageDims, setStageDims, stageFull, lowLatency, reconnecting,
  };
}
