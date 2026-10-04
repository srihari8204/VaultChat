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


import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import {
  View, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  useWindowDimensions, Animated, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ResizeMode, Video } from 'expo-av';
// The same renderer app/group-call-active.tsx uses for local video. Not the
// LiveKit <VideoTrack> component: that wants a components-react TrackReference,
// and this screen holds a plain Room. A stream URL is all RTCView needs.
import { RTCView } from '@livekit/react-native-webrtc';
import { pickFit, pickStage } from '../lib/golive/stageLayout';
import { useColors } from '../lib/theme';
import { AppText } from '../components/ui/Text';
import { SPACING } from '../constants/theme';
import {
  endBroadcast, getBroadcast, waitForPlaylist, type Broadcast,
} from '../lib/broadcast';
import { forgetHostPasscode, hostPasscodeFor } from '../lib/golive/hostPasscodeMemo';
// The screen's parts live in components/live/: the stage session and the chat /
// poll feed as hooks, the stage geometry and orientation as hooks, and each
// panel of the chrome as a component. This file decides WHAT is on screen.
//
// lib/golive/room.ts — Go Live's OWN copy of the SFU join path — is imported
// lazily by useLiveStage, never from lib/call/: broadcasting must never be a
// reason to edit a file the calling product owns. A failure there degrades to
// "could not publish" instead of a white screen — a viewer can still watch the
// HLS stream even if publishing is broken, and that is worth preserving.
import { useLiveStage } from '../components/live/useLiveStage';
import { useLiveFeed } from '../components/live/useLiveFeed';
import { useLiveInvite } from '../components/live/useLiveInvite';
import { useStageGestures } from '../components/live/useStageGestures';
import { useStageOrientation } from '../components/live/useStageOrientation';
import { LivePollCard, LivePollComposer } from '../components/live/LivePolls';
import { LiveInvitePanel } from '../components/live/LiveInvitePanel';
import { LiveChatPanel } from '../components/live/LiveChatPanel';
import { LiveHostControls } from '../components/live/LiveHostControls';
import { LiveStageStrip } from '../components/live/LiveStageStrip';
import { LiveTopRow } from '../components/live/LiveTopRow';
import { LIVE, S } from '../components/live/liveStyles';

export default function LiveViewScreen() {
  const { id, host, cam, mic, invite } = useLocalSearchParams<{
    id: string; host?: string; cam?: string; mic?: string; invite?: string;
  }>();
  // The host's own copy of the passcode, handed over in memory by app/live.tsx
  // (lib/golive/hostPasscodeMemo.ts), never as a route param. The server keeps
  // only a bcrypt hash, so this is the only readable copy, and it exists purely
  // so the invite sheet can show the host what to share.
  const [pc] = useState(() => hostPasscodeFor(String(id ?? '')));
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
  /** The host stopped, or the stream failed server-side, while we were watching. */
  const [ended, setEnded] = useState(false);

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

  /** Only the OWNER may end it — a co-host publishes, but it is not their stream. */
  const isOwner = b ? b.myRole === 'host' : isHost;

  const {
    hostSession, releaseOwnedMedia, media, busy, preview, toggle,
    stagePeers, stageScreens, stageDims, setStageDims, stageFull, lowLatency, reconnecting,
  } = useLiveStage({
    id, onStage, privateLive: b?.visibility === 'private', startCam, startMic,
    title: b?.title ?? '', setWaiting, setFailed,
  });

  // The private invitation link (components/live/useLiveInvite): opened once
  // automatically for a Private Live, after the host is actually live.
  const { inviteUrl, inviteOpen, setInviteOpen, inviteBusy, makeInvite } =
    useLiveInvite({ id, invite, waiting, failed, isOwner });

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
        // Host readiness is decided by the publish effect (useLiveStage). Viewer
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

  // ── live chat, viewer heartbeat and polls (components/live/useLiveFeed) ──
  const {
    messages, draft, setDraft, viewers, send, sendFailed,
    polls, voting, vote, pollDraft, setPollDraft, submitPoll, endPoll,
  } = useLiveFeed({ id, waiting, failed, setB, setEnded, releaseOwnedMedia });

  // Set once the screen is on its way out, so a second tap on "Go back" / "End"
  // (or a hardware back during the teardown awaits) cannot end the broadcast
  // twice and pop two screens. Never reset: every path below navigates away.
  const leaving = useRef(false);

  const stop = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
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
    // One teardown for every exit: releaseOwnedMedia (useLiveStage).
    await releaseOwnedMedia();
    await endBroadcast(String(id), b?.viewerCount ?? 0, b?.peakViewers ?? 0);
    forgetHostPasscode(String(id));
    if (router.canGoBack()) router.back(); else router.replace('/live');
  }, [id, b, router, releaseOwnedMedia]);

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
    if (leaving.current) return;
    leaving.current = true;
    await releaseOwnedMedia();
    router.replace('/live');
  }, [router, releaseOwnedMedia]);

  const confirmStop = () => Alert.alert(
    'End broadcast?',
    'Viewers will be disconnected.',
    [{ text: 'Keep going', style: 'cancel' }, { text: 'End', style: 'destructive', onPress: stop }],
  );

  /**
   * The one way off this screen, for every state.
   *
   * The OWNER of a broadcast that has not ended must end it on the way out, or
   * it is left `starting`/`live` with nobody publishing. A failed start
   * published nothing, so it ends without asking. Everyone else leaves through
   * leaveAsViewer, which survives an empty history (invite-link arrivals).
   */
  const exitScreen = () => {
    if (isOwner && !ended) { if (failed) void stop(); else confirmStop(); return; }
    void leaveAsViewer();
  };

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
  // FLAG_SECURE excludes crazzychat's own window from MediaProjection — that is
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
   * Which way the panel is round, right now.
   *
   * Read at render, never stored: a landscape share turns the phone under this
   * screen (see the orientation effect), so anything cached would describe the
   * panel the viewer used to be holding.
   */
  const landscape = win.width > win.height;

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
  /**
   * Unread is counted by MESSAGE ID, not list length. The list is capped at 200,
   * so once it is full its length stops growing and a length-based count read
   * zero for every new message after that.
   */
  const [seenChatId, setSeenChatId] = useState(0);
  const newestChatId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    if (chatOpen) setSeenChatId(prev => Math.max(prev, newestChatId));
  }, [chatOpen, newestChatId]);
  const unread = useMemo(
    () => (chatOpen ? 0 : messages.filter(m => m.id > seenChatId).length),
    [chatOpen, messages, seenChatId],
  );

  // Anything the user has deliberately opened pins the chrome open: retiring
  // the bar out from under a half-typed message is the kind of "helpful" that
  // loses the message.
  const pinned = chatOpen || inviteOpen || pollDraft !== null;

  // Hardware back closes an open panel first (they only render on a ready
  // stage), and only then leaves through exitScreen.
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (stageReady && pollDraft !== null) setPollDraft(null);
    else if (stageReady && inviteOpen) setInviteOpen(false);
    else if (stageReady && chatOpen) setChatOpen(false);
    else exitScreen();
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { backRef.current(); return true; });
    return () => sub.remove();
  }, []);
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


  const {
    pipW, pipH, pipOn, setPipOn, pipAt, pipDrag, pipPan, movePipToNextCorner,
    zoomStyle, stageTouchStart, stageTouchMove, stageTouchEnd,
  } = useStageGestures({ win, insets, mainStream, tapStage });

  /**
   * FIT OR FILL, DECIDED BY ITSELF — from the frame, the panel and the content.
   *
   * There is no single right answer to bake in, which is why this used to be
   * wrong for somebody whichever way it was set:
   *
   *   * WebRTC, frame size KNOWN — pickFit() compares the publisher's real
   *     aspect against this panel's. A phone sharing to a phone is within a few
   *     percent, so it fills and the share stops looking small; a landscape
   *     desktop is not, so it is contained and keeps its toolbar.
   *   * WebRTC, frame size not reported yet — contained, the safe half of the
   *     trade, and it re-decides the moment dimensions arrive.
   *   * HLS — the transport cannot report a frame size, and it does not need
   *     to: our egress composites onto a FIXED LANDSCAPE canvas
   *     (livekit/egress.go, `layout: speaker`), so a portrait publisher — every
   *     publisher this product has — arrives pillarboxed. Containing a 16:9
   *     canvas on a 9:20 panel spends a quarter of the screen on a picture that
   *     is itself mostly black bars, which IS the "it looks tiny" report.
   *     Filling crops the compositor's black back off, not the content.
   *
   * Derived, never stored: it reruns on rotation, on a fold, on a split-screen
   * resize and on a new publisher, because every input is read at render time.
   * The button in the chrome overrides it and stays overridden.
   */
  /**
   * WHAT SHAPE IS ON THE STAGE — and, on HLS, WHOSE ANSWER TO BELIEVE.
   *
   * A low-latency viewer subscribes to the publisher's own track, so stageDims
   * holds the truth and `pickStage` already knows whether it is a screen.
   *
   * An HLS viewer receives a composite: a fixed landscape canvas with the
   * publisher letterboxed inside it. The player will happily report that
   * canvas — and the canvas is not the content, so believing it would make
   * every public broadcast look landscape. The SERVER knows better, because
   * LiveKit tells it the real geometry when the share is published
   * (migration 116), so its answer wins whenever it has one.
   *
   * Note what this makes true: "cover the canvas" and "fit the content" become
   * the same instruction, because the canvas's black is exactly the difference
   * between the two aspect ratios. Cropping it back off is what the viewer
   * wanted all along.
   */
  // MEMOISED ON THE NUMBERS, not rebuilt per render. stageFrame derives from
  // this and the orientation effect depends on stageFrame — a fresh object each
  // render would re-issue lockAsync forever, which is a system call per frame
  // and a phone that fights the viewer's own rotation.
  const serverShare = useMemo(
    () => (b?.shareWidth && b?.shareHeight
      ? { width: b.shareWidth, height: b.shareHeight }
      : undefined),
    [b?.shareWidth, b?.shareHeight],
  );
  /** True when what fills the stage is a SCREEN, by either transport's account. */
  const stageIsScreen = stage.mainIsScreen || (!mainStream && !!serverShare);
  const stageFrame = mainStream
    ? stageDims[mainStream]
    // The server first; the player's own reading of the canvas only as a
    // fallback, and only ever as a description of the canvas.
    : (serverShare ?? stageDims[b?.hlsUrl ?? '']);
  const autoFit = pickFit(stageFrame?.width, stageFrame?.height, win.width, win.height, stageIsScreen);
  const [fillPref, setFillPref] = useState<boolean | null>(null);
  const fill = fillPref ?? (autoFit !== null ? autoFit === 'cover' : !lowLatency);

  // WHY THIS IS LOGGED. Both answers render into the same full-screen box, so
  // the view tree cannot tell them apart from outside the app and neither can a
  // screenshot — FLAG_SECURE blanks those. Without this line, "why is it still
  // letterboxed" is unanswerable on a device that is doing exactly the right
  // thing, and a wrong frame size looks identical to a wrong decision.
  useEffect(() => {
    // NOT gated on mainStream. HLS has no stream URL at all — the player owns
    // the frame — and HLS is the transport whose fit was the original complaint,
    // so gating on it skipped the one case worth watching. Device-found.
    if (!stageReady) return;
    console.warn('[GOLIVE_STAGE]', JSON.stringify({
      fit: fill ? 'cover' : 'contain',
      why: fillPref !== null ? 'viewer' : autoFit !== null ? 'auto' : 'transport',
      frame: stageFrame ? `${stageFrame.width}x${stageFrame.height}` : null,
      panel: `${Math.round(win.width)}x${Math.round(win.height)}`,
      screen: stageIsScreen,
      src: mainStream ? 'sfu' : serverShare ? 'server' : 'player',
    }));
  }, [stageReady, mainStream, fill, fillPref, autoFit, stageFrame, win.width, win.height, stageIsScreen, serverShare]);

  useStageOrientation({ onStage, stageReady, stageIsScreen, stageFrame, mainStream });

  return (
    <View style={S.root}>
      <Stack.Screen options={{ title: b?.title || 'Live', headerTransparent: true, headerTintColor: LIVE.text }} />

      {ended ? (
        // A finished stream is not a failure and must not be dressed as one:
        // the viewer saw the whole thing, it is simply over.
        <View style={S.center}>
          <Ionicons name="checkmark-circle-outline" size={40} color={LIVE.textDim} />
          <AppText style={S.centerText}>This broadcast has ended.</AppText>
          <TouchableOpacity onPress={exitScreen} style={S.backBtn} accessibilityRole="button">
            <AppText style={S.backText}>Go back</AppText>
          </TouchableOpacity>
        </View>
      ) : waiting ? (
        <View style={S.center}>
          <ActivityIndicator color={LIVE.text} />
          <AppText style={S.centerText}>
            {onStage ? 'Starting your broadcast…' : 'Waiting for the stream…'}
          </AppText>
        </View>
      ) : failed ? (
        <View style={S.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={LIVE.textDim} />
          <AppText style={S.centerText}>
            {onStage
              ? (stageFull
                  ? 'Could not join the stage. It may already have 20 people on it, or your connection dropped.'
                  : 'The broadcast could not start. Nothing was published.')
              : 'This stream is not available.'}
          </AppText>
          <TouchableOpacity onPress={exitScreen} style={S.backBtn} accessibilityRole="button">
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
                <Ionicons name="phone-portrait" size={13} color={LIVE.text} />
                <AppText style={S.sharingText}>Sharing your screen — viewers see it</AppText>
              </View>
            )}
          </>
        ) : (
          // No camera track: the host turned it off, or is broadcasting audio
          // or screen only. All legitimate — say what is true rather than
          // implying a failure, and keep the controls on screen.
          <View style={S.center}>
            <Ionicons name="radio-outline" size={40} color={LIVE.live} />
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
        <Animated.View style={[S.video, zoomStyle]}>
          <RTCView
            streamURL={mainStream}
            style={S.video}
            objectFit={fill ? 'cover' : 'contain'}
            zOrder={0}
            // THE FRAME SIZE, LIVE — and this is the one that survives a host
            // who turns their phone.
            //
            // The publication's dimensions are captured once, when the track is
            // subscribed, and that is exactly wrong for the case this product
            // has: a host starts sharing in portrait, then opens PUBG and the
            // capture becomes landscape. Measured on device 2026-08-25 — the
            // viewer's renderer went from 600x1332 to 960x540 mid-share while
            // the subscription's numbers never moved. Covering a landscape game
            // against a stale portrait decision crops it to a sliver, which is
            // worse than the letterbox this whole change set out to remove.
            //
            // The renderer knows, because it is decoding the frames. So it is
            // asked, and its answer overwrites whatever the SFU said at
            // subscribe time.
            onDimensionsChange={(e) => {
              const { width, height } = e.nativeEvent;
              if (!(width > 0) || !(height > 0)) return;
              setStageDims(prev => {
                const cur = prev[mainStream];
                if (cur && cur.width === width && cur.height === height) return prev;
                return { ...prev, [mainStream]: { width, height } };
              });
            }}
          />
        </Animated.View>
      ) : !b?.hlsUrl ? (
        <View style={S.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={LIVE.textDim} />
          <AppText style={S.centerText}>This stream is not available.</AppText>
          <TouchableOpacity onPress={exitScreen} style={S.backBtn} accessibilityRole="button">
            <AppText style={S.backText}>Go back</AppText>
          </TouchableOpacity>
        </View>
      ) : (
        <Animated.View style={[S.video, zoomStyle]}>
        <Video
          ref={video}
          source={{ uri: b.hlsUrl }}
          style={S.video}
          // Defaults to COVER, and that is not a crop of the picture: it is a
          // crop of the black the compositor added. See `fill` above.
          resizeMode={fill ? ResizeMode.COVER : ResizeMode.CONTAIN}
          shouldPlay
          // NO NATIVE CONTROLS. They have no job on a live edge — there is
          // nothing to seek and nothing to resume — and they used to be the
          // only thing on screen, swallowing the taps that reveal our own
          // chrome and leaving a viewer with no way off the screen at all.
          useNativeControls={false}
          // THE ONLY FRAME SIZE HLS CAN GIVE US.
          //
          // There is no track publication on this path — the player owns the
          // decode — but expo-av reports the stream's natural size once the
          // first frame is ready. Fed into the same map the SFU fills, so the
          // fit, the diagnostics and the orientation rule all read one source
          // whichever transport is playing.
          //
          // WORTH KNOWING WHAT THIS SIZE IS: today it describes our EGRESS
          // CANVAS, not the publisher — a fixed landscape composite that a
          // portrait phone is pillarboxed inside (livekit/egress.go). So it
          // cannot yet tell a landscape game from a portrait camera, and the
          // orientation rule deliberately ignores it. The day the composite is
          // made to match the publisher, this line starts telling the truth and
          // public behaves exactly like private with no further change.
          onReadyForDisplay={(e: any) => {
            const n = e?.naturalSize;
            if (!n || !(n.width > 0) || !(n.height > 0) || !b?.hlsUrl) return;
            // `orientation` is the player's own word for whether it had to
            // transpose; trust it over the raw pair when it disagrees.
            const flip = n.orientation === 'portrait' && n.width > n.height;
            setStageDims(prev => ({
              ...prev,
              [b.hlsUrl as string]: flip
                ? { width: n.height, height: n.width }
                : { width: n.width, height: n.height },
            }));
          }}
          // Live HLS has no meaningful end; looping a live edge would restart
          // playback at the first cached segment instead of following the feed.
          isLooping={false}
        />
        </Animated.View>
      )}

      {/* THE GESTURE LAYER — tap, pinch and pan, in that order of subtlety.
          Full-bleed and BELOW the chrome, so it only ever sees gestures that
          landed on the stream itself: a tap on Leave stays a tap on Leave.

          Raw touch props rather than a Pressable and a PanResponder fighting
          over the responder: one view, three handlers, and a tap is simply a
          touch that never travelled. onStartShouldSetResponder claims the
          touch so the move and end events are guaranteed to arrive. */}
      {stageReady && (
        <View
          style={StyleSheet.absoluteFill}
          // A screen reader cannot double-tap a raw touch layer, so the layer
          // is also a button whose activation toggles the controls.
          accessible
          accessibilityRole="button"
          accessibilityLabel={chromeShown ? 'Hide controls' : 'Show controls'}
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'activate') setChrome(v => !v); }}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onTouchStart={stageTouchStart}
          onTouchMove={stageTouchMove}
          onTouchEnd={stageTouchEnd}
          onTouchCancel={stageTouchEnd}
        />
      )}

      {/* CAMERA PICTURE-IN-PICTURE.
          Only while something else owns the stage, which today means a screen
          share. Sized from the window rather than fixed, and parked below the
          top row so it never sits under the status pill on a notched phone —
          until the viewer drags it somewhere else, or hides it from the chrome.
          Its position is clamped on every render, so a rotation cannot strand
          it off the panel. */}
      {stageReady && pipStream && pipOn && (
        <Animated.View
          style={[S.pip, {
            width: pipW, height: pipH, left: pipAt.x, top: pipAt.y,
            transform: pipDrag.getTranslateTransform(),
          }]}
          {...pipPan.panHandlers}
          // Dragging is not available to a screen reader, so the corner is
          // one element that offers the same moves as actions.
          accessible
          accessibilityLabel={onStage ? 'Your camera' : 'Host camera'}
          accessibilityHint="Actions: move it to the next corner, or hide it"
          accessibilityActions={[{ name: 'move', label: 'Move to the next corner' }, { name: 'hide', label: 'Hide the camera corner' }]}
          onAccessibilityAction={(e) => {
            const a = e.nativeEvent.actionName;
            if (a === 'hide') setPipOn(false);
            else if (a === 'move') movePipToNextCorner();
          }}
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
        </Animated.View>
      )}

      {/* NOT ONLY A GESTURE. With the chrome retired, a small button in the
          corner brings it back for anyone who cannot (or does not know to)
          double-tap — including the exit, which must always be reachable. */}
      {!ended && !chromeShown && (
        <TouchableOpacity
          onPress={() => setChrome(true)}
          style={[S.icon, S.showChrome, { top: insets.top + SPACING.sm, right: insets.right + SPACING.lg }]}
          accessibilityRole="button"
          accessibilityLabel="Show controls"
          hitSlop={8}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {/* ── CHROME ──────────────────────────────────────────────────
          One flex column against the real safe area. Every child is laid out,
          not positioned: nothing here carries a pixel offset that assumes a
          screen size. box-none throughout so the stream keeps receiving taps
          everywhere the chrome has not actually drawn a control. */}
      {!ended && chromeShown && (
        <View
          style={[S.chrome, {
            paddingTop: insets.top + SPACING.sm,
            paddingBottom: insets.bottom + SPACING.sm,
            // LEFT AND RIGHT MATTER NOW. In portrait these insets are zero and
            // the horizontal padding in S.chrome was enough. Turn the phone for
            // a landscape game share and the notch swings to one side, straight
            // over the LIVE pill or the exit — the one control that must never
            // be unreachable.
            paddingLeft: insets.left + SPACING.lg,
            paddingRight: insets.right + SPACING.lg,
          }]}
          pointerEvents="box-none"
        >
          <LiveTopRow
            b={b} reconnecting={reconnecting} failed={failed} viewers={viewers}
            stageReady={stageReady} onStage={onStage} isOwner={isOwner}
            fill={fill} onToggleFill={() => setFillPref(!fill)}
            hasPip={!!pipStream} pipOn={pipOn} onTogglePip={() => setPipOn(v => !v)} onMovePip={movePipToNextCorner}
            chatOpen={chatOpen} unread={unread} openChat={openChat}
            onNewPoll={() => setPollDraft({ q: '', opts: ['', ''] })}
            onInvite={() => (inviteUrl ? setInviteOpen(true) : makeInvite())}
            confirmStop={confirmStop} leaveAsViewer={leaveAsViewer}
          />

          {onStage && Object.keys(stagePeers).length > 0 && (
            <LiveStageStrip
              stagePeers={stagePeers}
              nameOf={uid => hostSession.current?.room?.remoteParticipants?.get(uid)?.name ?? ''}
            />
          )}

          <View style={S.grow} pointerEvents="none" />

          {/* ── BOTTOM STACK ────────────────────────────────────────
              Stacked in one column instead of each pinned at its own hard
              offset, which is what used to let the poll card, the invite sheet
              and the chat draw on top of each other on a short screen. */}
          {stageReady && (
            <KeyboardSafe
              // The whole point of the chat icon: tapping it must lift the
              // composer clear of the keyboard rather than bury it under one.

              style={S.bottom}
              pointerEvents="box-none"
>
              {/* POLLS — above the chat, because a poll is a call to action and
                  chat is ambient. Only the newest OPEN poll is shown: stacking
                  several would bury the stream this is drawn on top of. Closed
                  ones stay in the list server-side for the record. */}
              {polls.filter(pl => !pl.closed).slice(0, 1).map(pl => (
                <LivePollCard key={pl.id} pl={pl} isOwner={isOwner} voting={voting} vote={vote} endPoll={endPoll} />
              ))}

              {isOwner && pollDraft && (
                <LivePollComposer pollDraft={pollDraft} setPollDraft={setPollDraft} submitPoll={submitPoll} />
              )}

              {inviteOpen && inviteUrl && (
                <LiveInvitePanel
                  inviteUrl={inviteUrl} pc={pc} inviteBusy={inviteBusy}
                  onClose={() => setInviteOpen(false)} makeInvite={makeInvite}
                />
              )}

              {/* CHAT — folded away behind the icon in the top row.
                  It used to sit open over the bottom third of every stream,
                  which on a phone is the third the stream is actually in. Open
                  it and the composer takes focus immediately, because tapping a
                  chat icon has exactly one intention. */}
              {chatOpen && (
                <LiveChatPanel
                  messages={messages} draft={draft} setDraft={setDraft} send={send}
                  sendFailed={sendFailed} onClose={() => setChatOpen(false)}
                  win={win} landscape={landscape}
                />
              )}

              {onStage && hostSession.current && (
                <LiveHostControls media={media} busy={busy} toggle={toggle} />
              )}

            </KeyboardSafe>
          )}
        </View>
      )}

    </View>
  );
}
