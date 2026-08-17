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
  ScrollView, TextInput,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ResizeMode, Video } from 'expo-av';
// The same renderer app/group-call-active.tsx uses for local video. Not the
// LiveKit <VideoTrack> component: that wants a components-react TrackReference,
// and this screen holds a plain Room. A stream URL is all RTCView needs.
import { RTCView } from '@livekit/react-native-webrtc';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
  // The publisher's video, once subscribed. On a private live the stage is the
  // host and any co-hosts, so the first tile is what this viewer came to watch.
  // Declared here rather than beside `lowLatency` because it reads stagePeers.
  const llStream = lowLatency ? Object.values(stagePeers)[0] : undefined;
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
          onTrack: (uid, url, kind) => {
            if (kind !== 'video') return;
            setStagePeers(prev => {
              if (!url) { const { [uid]: _drop, ...rest } = prev; return rest; }
              return { ...prev, [uid]: url };
            });
          },
          onParticipant: (p, joined) => {
            if (joined) return;
            setStagePeers(prev => { const { [p.identity]: _gone, ...rest } = prev; return rest; });
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
        preview ? (
          <>
            <RTCView streamURL={preview} style={S.video} objectFit="cover" mirror />
            {media.screen && (
              // The preview shows the CAMERA; the screen is a second
              // publication the host cannot see here. Saying so beats a viewer
              // asking why their screen is not on the stream.
              <View style={S.sharingChip}>
                <Ionicons name="phone-portrait" size={13} color="#fff" />
                <AppText style={S.sharingText}>Sharing your screen</AppText>
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
      ) : lowLatency && !llStream ? (
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
      ) : llStream ? (
        // Sub-second path: the publisher's track straight off the SFU. No
        // playlist, no segments, no buffer — which is the entire point.
        <RTCView streamURL={llStream} style={S.video} objectFit="contain" />
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
          useNativeControls
          // Live HLS has no meaningful end; looping a live edge would restart
          // playback at the first cached segment instead of following the feed.
          isLooping={false}
        />
      )}

      {/* OTHER PEOPLE ON THE STAGE.
          A strip of small tiles, not a grid: the main frame belongs to whoever
          this device is watching, and the stage is at most 20 people while the
          audience is unbounded. Rendered only for stage members — an audience
          member is on HLS and has no room to draw these from. */}
      {onStage && Object.keys(stagePeers).length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={S.stageStrip}
          contentContainerStyle={S.stageStripInner}
        >
          {Object.entries(stagePeers).map(([uid, url]) => (
            <RTCView key={uid} streamURL={url} style={S.stageTile} objectFit="cover" />
          ))}
        </ScrollView>
      )}

      {/* Honest status strip. `e2ee` comes from the server. */}
      {b && (
        <View style={S.bar}>
          <View style={S.liveDot} />
          <AppText style={S.barText}>
            {b.status === 'live' ? 'LIVE' : b.status.toUpperCase()}
          </AppText>
          {/* Live count from Redis, falling back to the stored snapshot before
              the first heartbeat lands. */}
          <AppText style={S.barDim}>{viewers || b.viewerCount} watching</AppText>
          {!b.e2ee && <AppText style={S.barDim}>· Not encrypted</AppText>}
        </View>
      )}

      {/* LEAVE — for the audience only.
          The host has "End broadcast"; a viewer had NOTHING. Once the HLS
          <Video> is playing it fills the screen with only its own native
          transport controls, so there was no way off this screen at all — and
          the hardware back button is not a substitute, because a viewer who
          arrived through an invitation link got here via router.replace and has
          no history to go back to. On that path back exits the app.

          leaveAsViewer, not router.back(), for exactly that reason.

          Rendered outside the status bar's own View so it stays put whether or
          not the bar is showing. */}
      {!isOwner && (
        <TouchableOpacity
          onPress={leaveAsViewer}
          style={S.leaveBtn}
          activeOpacity={0.85}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={18} color="#fff" />
          <AppText style={S.leaveText}>Leave</AppText>
        </TouchableOpacity>
      )}

      {/* PRIVATE INVITATION — the link IS the access mechanism.
          Shows the URL, and nothing else: no room name, no key, no
          infrastructure detail. Copy and Share both hand over the same opaque
          code, which grants VIEWING only — a seat on the stage still needs the
          host to promote you. */}
      {inviteOpen && inviteUrl && (
        <View style={S.inviteSheet}>
          <View style={S.inviteHead}>
            <Ionicons name="lock-closed" size={14} color="#FCD34D" />
            <AppText style={S.inviteTitle}>Private live — invite people</AppText>
            <TouchableOpacity onPress={() => setInviteOpen(false)}>
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

              Shown from the route param, not from the server: only a bcrypt
              hash is stored, so there is nothing to fetch back. Its own Copy
              button because it must travel on a DIFFERENT channel from the
              link — pasting both into one message defeats the entire point. */}
          {!!pc && (
            <View style={S.pcRow}>
              <View style={{ flex: 1 }}>
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
              onPress={() => Share.share({
                message: `Join my private live on VaultChat
${inviteUrl}`,
              })}
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

      {/* Re-open it later. Private streams only — a public one needs no invite. */}
      {isOwner && b?.visibility === 'private' && !inviteOpen && !waiting && !failed && !ended && (
        <TouchableOpacity
          onPress={() => (inviteUrl ? setInviteOpen(true) : makeInvite())}
          style={S.inviteFab}
          accessibilityLabel="Invite people"
        >
          <Ionicons name="person-add-outline" size={18} color="#fff" />
        </TouchableOpacity>
      )}

      {/* POLLS — above the chat, because a poll is a call to action and chat is
          ambient. Only the newest OPEN poll is shown: stacking several would
          bury the stream this is drawn on top of. Closed ones stay in the list
          server-side for the record. */}
      {!waiting && !failed && !ended && polls.filter(p => !p.closed).slice(0, 1).map(p => {
        const answered = p.myVote >= 0;
        return (
          <View key={p.id} style={S.poll}>
            <View style={S.pollHead}>
              <Ionicons name="stats-chart" size={13} color="#FCD34D" />
              <AppText style={S.pollQ} numberOfLines={2}>{p.question}</AppText>
              {isOwner && (
                <TouchableOpacity onPress={() => { void closePoll(String(id), p.id); setPolls(prev => prev.map(x => x.id === p.id ? { ...x, closed: true } : x)); }}>
                  <AppText style={S.pollClose}>End</AppText>
                </TouchableOpacity>
              )}
            </View>
            {p.options.map((opt, i) => {
              // Percentages only AFTER voting. Showing the running tally to
              // someone who has not answered biases the answer, and on an
              // unbounded audience that is not a rounding error.
              const pct = p.total > 0 ? Math.round((p.counts[i] ?? 0) * 100 / p.total) : 0;
              const mine = p.myVote === i;
              return (
                <TouchableOpacity
                  key={i}
                  disabled={answered || voting !== null}
                  onPress={() => vote(p.id, i)}
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
              {answered ? `${p.total} ${p.total === 1 ? 'vote' : 'votes'}` : 'Tap to vote'}
            </AppText>
          </View>
        );
      })}

      {/* Host: compose a poll. */}
      {isOwner && !waiting && !failed && !ended && (
        pollDraft ? (
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
        ) : (
          <TouchableOpacity
            onPress={() => setPollDraft({ q: '', opts: ['', ''] })}
            style={S.pollFab}
            accessibilityLabel="Create a poll"
          >
            <Ionicons name="stats-chart" size={18} color="#fff" />
          </TouchableOpacity>
        )
      )}

      {/* Chat overlays the video rather than splitting the screen — a phone in
          portrait has no room for both, and viewers came for the stream. */}
      {!waiting && !failed && !ended && (
        <View style={S.chatWrap} pointerEvents="box-none">
          <ScrollView
            style={S.chatList}
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
            />
            <TouchableOpacity onPress={send} style={S.chatSend}>
              <Ionicons name="send" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Host controls. Rendered only when there is a session to drive — a host
          whose publish failed gets no buttons rather than dead ones.

          The publish permission is in the TOKEN, not here: an audience grant has
          canPublish=false and an empty source list, so hiding these is a
          courtesy and the media server is the enforcement. */}
      {onStage && !waiting && !failed && hostSession.current && (
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
                // Screen share is the one that is ON when highlighted; mic and
                // camera are highlighted when OFF, because "muted" is the state
                // a host needs to spot at a glance.
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

      {isOwner && !waiting && (
        <TouchableOpacity onPress={confirmStop} style={S.endBtn} activeOpacity={0.85}>
          <Ionicons name="stop-circle-outline" size={20} color="#fff" />
          <AppText style={S.endText}>End broadcast</AppText>
        </TouchableOpacity>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.lg, padding: SPACING.xl },
  centerText: { color: '#CBD5E1', fontSize: 15, textAlign: 'center' },
  // Top-RIGHT, opposite the LIVE bar at top-left, so it cannot cover the status
  // it sits beside. Above the video (zIndex) or the native transport controls
  // would swallow the tap.
  leaveBtn: {
    position: 'absolute', top: 100, right: SPACING.lg, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill, backgroundColor: 'rgba(15,23,42,0.85)',
  },
  leaveText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  backBtn: { paddingHorizontal: SPACING.xl, paddingVertical: SPACING.md, borderRadius: RADIUS.pill, backgroundColor: '#1E293B' },
  backText: { color: '#fff', fontWeight: '600' },
  bar: {
    position: 'absolute', top: 100, left: SPACING.lg,
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.pill,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  barText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  barDim: { color: '#94A3B8', fontSize: 11 },
  endBtn: {
    position: 'absolute', bottom: SPACING.xxl, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: '#B91C1C', paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md, borderRadius: RADIUS.pill,
  },
  endText: { color: '#fff', fontWeight: '700' },
  sharingChip: {
    position: 'absolute', top: 140, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: 'rgba(185,28,28,0.9)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs, borderRadius: RADIUS.pill,
  },
  sharingText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  inviteSheet: {
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, bottom: 300,
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
  inviteFab: {
    position: 'absolute', right: SPACING.lg, bottom: 352,
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,41,59,0.9)',
  },
  poll: {
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, bottom: 300,
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
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, bottom: 300,
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
  pollFab: {
    position: 'absolute', right: SPACING.lg, bottom: 300,
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,41,59,0.9)',
  },
  // Above the controls, below the chat: the stage is context, the stream is the
  // subject.
  stageStrip:      { position: 'absolute', top: 150, left: 0, right: 0, maxHeight: 96 },
  stageStripInner: { paddingHorizontal: SPACING.lg, gap: SPACING.sm },
  stageTile:       { width: 72, height: 96, borderRadius: RADIUS.md, backgroundColor: '#0F172A' },
  // Above the End button, so the destructive control is never the one a thumb
  // reaches first.
  controls: {
    position: 'absolute', bottom: 96, alignSelf: 'center',
    flexDirection: 'row', gap: SPACING.md,
  },
  ctrl: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,41,59,0.85)',
  },
  ctrlActive: { backgroundColor: '#B91C1C' },
  // Bottom third only: the stream stays the subject, chat is context.
  chatWrap:      { position: 'absolute', left: 0, right: 0, bottom: 90, maxHeight: '38%' },
  chatList:      { maxHeight: 180 },
  chatListInner: { paddingHorizontal: SPACING.lg, gap: 4 },
  chatLine:      { color: '#E2E8F0', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3 },
  chatName:      { color: '#FCD34D', fontWeight: '700' },
  chatInputRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
                   paddingHorizontal: SPACING.lg, marginTop: SPACING.sm },
  chatInput:     { flex: 1, color: '#fff', backgroundColor: 'rgba(0,0,0,0.55)',
                   borderRadius: RADIUS.pill, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  chatSend:      { backgroundColor: 'rgba(0,0,0,0.55)', padding: SPACING.md, borderRadius: RADIUS.pill },
});
