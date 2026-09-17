// app/voicecall.tsx — Day 6 voice call (audio-only WebRTC).
//
// Real peer-to-peer with our coturn relay fallback. Signaling rides on
// the shared realtime connection (events: webrtc_offer, webrtc_answer,
// webrtc_ice, webrtc_end, call_incoming — defined in server.js).
//
// Route params:
//   chatId      — the chat to call (must be a direct chat MVP)
//   peerUid     — the other user's uuid (we already have this from chats)
//   peerName    — display name (header)
//   isIncoming  — "true" when this screen was opened from an incoming-call event
//
// State:
//   getUserMedia({ audio: true }) → RTCPeerConnection → exchange offer/
//   answer/ICE via socket → ontrack flips state to connected → start timer.
//
// Audio routing: earpiece by default (private). Speaker toggle button.
// Cleanup: stops local tracks, closes pc, emits webrtc_end, leaves screen.

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import InCallManager from 'react-native-incall-manager';
import { setActiveCall, clearActiveCall, type ActiveCall } from '../lib/callState';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { Ionicons } from '@expo/vector-icons';
import { CALL } from '../constants/callTheme';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from '@livekit/react-native-webrtc';
import { getCurrentUserAsync } from './(constants)/authService';
import { getIceServers } from '../lib/iceConfig';
import { getSocket } from '../lib/socket';
import { addCallLog } from '../lib/callLog';
import { startCallForeground, stopCallForeground, dismissIncomingNotification, initiateCall, cancelCall, enterPipMode } from '../lib/CallService';
import { newCallCipher, openCallOffer, plainCipher, type CallCipher } from '../lib/callCrypto';
import { CallTimer, elapsedSeconds } from '../components/call/CallTimer';
import { CallControlButton } from '../components/call/CallControlButton';
import { CallExtras } from '../components/call/CallExtras';
import { CallEncryptionBadge } from '../components/call/CallEncryptionBadge';
import { CALL_ENGINE_V2 } from '../constants/flags';
import * as engine from '../lib/call/engine';
import { callFail, offerTag } from '../lib/call/diag';
import { setRingingPeer, setRingScreenPeer } from '../lib/ringTracker';
import { DISCONNECT_GRACE_MS } from '../lib/call/types';
import { useCallConnectedAt, useCallError, useCallFlag, useCallStatus } from '../hooks/useCall';
import { endMessage } from '../lib/call/endMessage';
import { getSnapshot } from '../lib/call/store';

type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

// Call chrome is always dark (independent of app theme), so styles are static.
// How many people the Add sheet offers at once. 12 was the old value and it is
// wrong for a 64-seat call: in a 40-person group you could see 12 of the
// missing members and no way to reach the rest. The sheet scrolls, so this is
// only a guard against rendering an unbounded contact list in one pass.
const ADD_LIST_MAX = 50;

const S = makeStyles();

/**
 * Route entry. Picks the engine-backed renderer or the original implementation
 * from one flag, so the migration ships dark and rollback is a constant.
 *
 * Both render the SAME chrome from the SAME styles and speak the SAME wire, so
 * a device on either path interoperates with a device on the other. The legacy
 * body below is deleted once CALL_ENGINE_V2 has passed the OEM matrix in
 * CALLS_README.md on real hardware.
 */
export default function VoiceCallScreen() {
  return CALL_ENGINE_V2 ? <VoiceCallEngine /> : <VoiceCallLegacy />;
}

// ── engine-backed renderer (CALL_ENGINE_V2) ───────────────────────────
// All protocol lives in lib/call/*; this subscribes and draws. Note what is
// absent: no RTCPeerConnection, no getUserMedia, no socket handlers, no cipher,
// no teardown bookkeeping, no duration state.
function VoiceCallEngine() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { chatId, peerUid, peerName, isIncoming, initialOffer, resume: resumeParam } =
    useLocalSearchParams<{
      chatId: string; peerUid: string; peerName: string;
      isIncoming?: string; initialOffer?: string; resume?: string }>();

  // Who we are talking to.
  //
  // peerName is a route param and arrives EMPTY on several paths — an incoming
  // call whose signal carried no name, or an outgoing one started from a list
  // whose title had not loaded — so the screen showed "crazzychat user" during
  // the call. To be in a call at all we already share a chat, so the name is in
  // our own store; look it up rather than trusting what was passed in.
  //
  // Display only: nothing here touches the call, and a failed lookup simply
  // leaves the previous fallback in place.
  const [lookedUpName, setLookedUpName] = useState<string | null>(null);
  useEffect(() => {
    if (peerName || !chatId) return;
    let cancelled = false;
    (async () => {
      const { getChat } = await import('../lib/chatService');
      const n = (await getChat(String(chatId)))?.peerName?.trim();
      if (!cancelled && n) setLookedUpName(n);
    })().catch(() => { /* keep the fallback */ });
    return () => { cancelled = true; };
  }, [chatId, peerName]);
  const displayName = peerName || lookedUpName || 'crazzychat user';

  const status      = useCallStatus();
  const connectedAt = useCallConnectedAt();
  const error       = useCallError();
  const muted       = useCallFlag('muted');
  const speaker     = useCallFlag('speaker');

  // Start exactly once per mount, on the params this screen was opened with.
  useEffect(() => {
    const incoming = isIncoming === 'true' || isIncoming === '1';
    const resuming = String(resumeParam ?? '') === '1';
    const args = {
      chatId: String(chatId ?? ''), peerUid: String(peerUid ?? ''),
      peerName: String(peerName ?? ''), kind: 'audio' as const,
    };
    // AN INCOMING CALL MUST NEVER FALL THROUGH TO DIALLING.
    //
    // This used to read `if (incoming && initialOffer)`, so an accept that
    // arrived before the offer did — every notification answer, because the
    // intent extras never reach JS, and any fast tap — skipped the answer path
    // and ran startOutgoing instead. The callee then DIALLED THE CALLER BACK,
    // ringing the phone that was already ringing it. Measured on device:
    //
    //   [call][--------][accepted] audio     ← accepted with no offer
    //   [call][37e8ad47][offer_sent] audio   ← now calling THEM
    //   [call][--------][accepted] audio
    //   [call][c33fd20c][offer_sent] audio   ← and again
    //
    // That is the "answering triggers so many calls" report, and the stray
    // outgoing call is also what collides with the real one and drops it.
    //
    // `incoming` alone decides the branch now. Without an offer we do NOT call
    // acceptIncoming either: it treats a null wire as a DEAD RATCHET and fires
    // requestPeerRekey, which would reset a perfectly healthy session over a
    // race. The caller re-emits the offer every 3s, so the honest move is to go
    // back to the ring and let it arrive.
    let wire: any = null;
    if (incoming && initialOffer) { try { wire = JSON.parse(String(initialOffer)); } catch {} }
    // RE-ENTERING A CALL THAT IS ALREADY RUNNING.
    //
    // <CallBar/> routes back here with resume=1 while the engine still holds a
    // live session. Without this branch the screen would call startOutgoing or
    // acceptIncoming against its own live call — re-dialling the peer, or
    // re-keying a healthy session. Attaching means rendering the snapshot the
    // engine already has, which is what every other frame on this screen does.
    if (resuming && engine.hasLiveSession()) {
      console.log('[call] re-attached to the live session');
    } else if (incoming) {
      // No offer required. The call is identified by the chat, so an answer
      // that beat the ring — every notification answer — joins the same room
      // instead of waiting for an envelope or, worse, dialling back.
      engine.acceptIncoming({ ...args, offerWire: wire ?? undefined });
    } else {
      engine.startOutgoing(args);
    }
    // Unmount for any reason (back gesture, replacement, crash recovery) must
    // release the mic and the foreground service — the engine's disposal
    // registry makes this safe to call redundantly.
    return () => {
      // Scoped to THIS call. Unscoped, this cleanup ended whatever call was
      // live — so answering a second call, which replaces the session, was
      // followed by this screen unmounting and hanging the NEW call up.
      engine.leaveScreen({ chatId: args.chatId, peerUid: args.peerUid });
      // Release the ring claim taken when this call was answered from the OS
      // notification, or the NEXT call from the same person is silently
      // suppressed as a duplicate ring.
      setRingingPeer(null);
      setRingScreenPeer(null);
    };
  }, [chatId, peerUid, peerName, isIncoming, initialOffer]);

  // BACK SHRINKS THE CALL, IT DOES NOT END IT.
  //
  // Default back pops this screen, and the unmount above hangs up — so the
  // gesture every other calling app uses to keep talking in a floating window
  // was dropping the call instead. Returning true keeps the screen mounted (the
  // call stays alive) whether or not the OS grants PiP; if it refuses we simply
  // stay on the call screen, which is still better than hanging up.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // PiP ONLY on a live call. Otherwise back must still LEAVE.
      //
      // Swallowing back unconditionally trapped the user: on a call that was
      // connecting, silent, or already dead, the hang-up control did not end it
      // and back only shrank it — so the only way out was killing the app from
      // recents. A gesture that can strand someone in a broken call is worse
      // than the problem it was added to solve.
      if (status !== 'connected') { engine.hangUp('local_hangup', true); return false; }
      // MINIMISE INTO THE APP, not into the OS.
      //
      // enterPipMode() is Android's system picture-in-picture: it shrinks the
      // whole activity into a floating window, which lets you use OTHER apps
      // and still leaves crazzychat itself unusable. Minimising in-app leaves
      // the call running behind <CallBar/> and hands the app back.
      engine.minimizeScreen();
      if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats' as any);
      return true;
    });
    return () => sub.remove();
  }, [status]);

  // Foreground service + clear the OS ring, once, on connect.
  useEffect(() => { if (status === 'connected') engine.onConnected(); }, [status]);

  // Leave when the call is over, matching the legacy 200 ms settle.
  useEffect(() => {
    if (status !== 'ended') return;
    // Say why, but only when the user did not ask for it. endMessage returns
    // null for a hang-up either side made on purpose (2026-09-17).
    const snap = getSnapshot();
    const why = endMessage(snap.endReason, snap.error);
    if (why) Alert.alert('Call ended', why);
    // LEAVE, even when there is nothing to go back TO.
    //
    // router.back() is a no-op on an empty history, and a call answered from a
    // notification has exactly that: the app was launched INTO this screen. So
    // ending the call left the user staring at a dead "Call ended" screen with
    // no way out but the app switcher — reported on device.
    const t = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/' as any);
    }, 200);
    return () => clearTimeout(t);
  }, [status, router]);

  // `reconnecting` MUST have its own branch: this chain falls through to
  // 'Call ended', so without it a call that is recovering would announce
  // itself as already over — the opposite of what is happening.
  const statusText = status === 'connecting' ? 'Connecting…'
    : status === 'ringing' ? 'Ringing…'
    : status === 'reconnecting' ? 'Reconnecting…'
    : 'Call ended';
  const initial = (displayName.trim()[0] ?? '?').toUpperCase();

  // ── ADD PERSON TO THIS CALL ────────────────────────────────────────
  //
  // A 1:1 call had no way to become a three-person one — the button every other
  // messenger has did not exist here, which is what "I can't see the add option"
  // was about. The server issues an invite scoped to THIS call (migration 123),
  // so the person added joins the CALL, never the chat.
  //
  // Contacts are loaded when the sheet opens, not held in state: the list must
  // reflect who is reachable now, and this screen may sit open for a long time.
  const [addSheet, setAddSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);
  const addPerson = useCallback(async () => {
    try {
      const { listChats } = await import('../lib/chatService');
      const chats = await listChats();
      // YOURSELF must be excluded here, not just downstream. You are a member
      // of every direct chat, so without this your own name is offered in the
      // list — and tapping it does nothing at all, because inviteToCall drops
      // `u !== s.meId`. A row that silently no-ops is the same bug as a button
      // that silently no-ops.
      const { getSnapshot } = await import('../lib/call/store');
      const seen = new Set<string>([String(peerUid ?? ''), getSnapshot().meId]);
      const people: { id: string; name: string }[] = [];
      for (const c of chats ?? []) {
        // listChats returns ChatSummary, which has NO `members` — that lives on
        // ChatDetail (getChat). Reading c.members here yielded undefined for
        // every chat, so the list was ALWAYS empty and the sheet always said
        // "No other contacts to add yet", on every device. A direct summary
        // already carries the peer, so this needs no extra request either.
        if (c.type !== 'direct') continue;
        const uid = c.peerUserId;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        people.push({ id: uid, name: c.peerName || c.name || uid.slice(0, 8) });
      }
      if (!people.length) {
        setAddSheet({ title: 'Add to call', message: 'No other contacts to add yet.', actions: [] });
        return;
      }
      setAddSheet({
        title: 'Add to call',
        message: 'They join this call only — not the chat.',
        actions: people.slice(0, ADD_LIST_MAX).map(pp => ({
          label: pp.name,
          icon: 'person-add-outline' as const,
          onPress: () => { void engine.inviteToCall([pp.id]); },
        })),
      });
    } catch {
      setAddSheet({ title: 'Add to call', message: 'Could not load contacts just now.', actions: [] });
    }
  }, [peerUid]);


  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      {/* ADD PEOPLE, TOP-LEFT — same placement as the video screen so the
          control is in one place whichever call you are on. */}
      <TouchableOpacity
        onPress={addPerson}
        style={[S.addTopBtn, { top: insets.top + 8 }]}
        hitSlop={10}
        accessibilityLabel="Add people to this call"
      >
        <Ionicons name="person-add" size={20} color="#fff" />
      </TouchableOpacity>
      <View style={S.body}>
        <View style={S.avatarWrap}>
          <View style={S.avatar}><Text style={S.avatarTxt}>{initial}</Text></View>
        </View>
        <Text numberOfLines={1} style={S.name}>{displayName}</Text>
        {status === 'connected'
          ? <CallTimer style={S.status} startedAt={connectedAt} />
          : <Text style={S.status}>{statusText}</Text>}
        {error && <Text style={S.errorTxt}>{error}</Text>}
        {/* D-1: a 1:1 call is peer-to-peer, so this claim is the strong one. */}
        <CallEncryptionBadge protection="transport" />
      </View>

      {status === 'connected' && <CallExtras bottom={insets.bottom + 116} />}

      <View style={[S.controls, { paddingBottom: insets.bottom + 24 }]}>
        <CallControlButton icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={engine.toggleMute} />
        <CallControlButton icon={speaker ? 'volume-high' : 'volume-low'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={engine.toggleSpeaker} />
        <CallControlButton icon="call" label="End" danger onPress={hangUpFromScreen} />
      </View>

      {/* Without this the Add button is INERT: addPerson loads contacts and
          calls setAddSheet, but nothing renders it, so the tap does nothing
          visible. group-call-active.tsx always had its equivalent. */}
      <Sheet
        visible={!!addSheet}
        title={addSheet?.title}
        message={addSheet?.message}
        actions={addSheet?.actions ?? []}
        onClose={() => setAddSheet(null)}
      />
    </View>
  );
}

const hangUpFromScreen = () => engine.hangUp('local_hangup', true);

// ── original implementation (CALL_ENGINE_V2 off) — unchanged ──────────
function VoiceCallLegacy() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { chatId, peerUid, peerName, isIncoming, initialOffer } =
    useLocalSearchParams<{
      chatId: string;
      peerUid: string;
      peerName: string;
      isIncoming?: string;
      initialOffer?: string;        // JSON-stringified RTCSessionDescription
    }>();

  const [state,   setState]   = useState<CallState>('connecting');
  const [muted,   setMuted]   = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const pcRef           = useRef<RTCPeerConnection | null>(null);
  const disconnectGraceRef = useRef<any>(null);   // see onconnectionstatechange
  // E2EE signaling cipher (F6) — per-call key; plaintext passthrough for legacy peers.
  const cipherRef       = useRef<CallCipher>(plainCipher);
  // Candidates gathered BEFORE the cipher exists. ICE gathering starts the
  // instant setLocalDescription resolves, but newCallCipher is a network fetch
  // of the peer's key bundle — so host candidates (the ones that make a
  // same-LAN or friendly-NAT call work) are always ready first. Dropping them
  // is not fail-closed, it is just losing them: they are never re-gathered and
  // the sealed offer carries none (this is trickle ICE). Hold them here and
  // flush once the cipher lands. Same shape as pendingIce in group-call-active.
  const pendingIceRef   = useRef<any[]>([]);
  const localStreamRef  = useRef<any>(null);
  const meIdRef         = useRef<string>('');
  const ringTimerRef    = useRef<any>(null);
  const offsRef         = useRef<Array<() => void>>([]);
  // Epoch ms the call connected. The elapsed time is DERIVED from this (see
  // components/call/CallTimer) instead of being counted in screen state, so the
  // 1 Hz tick no longer re-renders this whole screen — and so the duration stays
  // accurate when the JS thread is throttled in the background.
  const connectedAtRef  = useRef(0);
  const connectedRef    = useRef(false);
  const loggedRef       = useRef(false);

  useEffect(() => { if (state === 'connected') connectedRef.current = true; }, [state]);

  // ── teardown ──────────────────────────────────────────────
  const teardown = useCallback((notify = true) => {
    offsRef.current.forEach(fn => { try { fn(); } catch {} });
    offsRef.current = [];
    if (ringTimerRef.current) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; }
    try { InCallManager.stop(); } catch {}
    stopCallForeground();   // release the mic foreground service + wake lock
    try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    if (disconnectGraceRef.current) { clearTimeout(disconnectGraceRef.current); disconnectGraceRef.current = null; }
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    if (notify && peerUid) {
      getSocket()
        .then(s => s.emit('webrtc_end', { to: peerUid, from: meIdRef.current, chatId }))
        .catch(() => {});
    }
  }, [peerUid, chatId]);

  const endCall = useCallback((notify = true) => {
    // Log this call to the local history exactly once.
    if (!loggedRef.current && peerUid) {
      loggedRef.current = true;
      const incoming = isIncoming === 'true' || isIncoming === '1';
      const dir: 'incoming' | 'outgoing' | 'missed' = incoming ? (connectedRef.current ? 'incoming' : 'missed') : 'outgoing';
      const durationSec = elapsedSeconds(connectedAtRef.current);
      addCallLog({ chatId, peerUid, peerName: peerName || 'crazzychat user', kind: 'audio', direction: dir, at: Date.now() - durationSec * 1000, durationSec }).catch(() => {});
      // Outgoing call we hung up before it was answered → tell the callee's device
      // to stop ringing and show a "missed call".
      if (!incoming && !connectedRef.current && peerUid) {
        cancelCall(peerUid, String(chatId || peerUid)).catch(() => {});
      }
    }
    setState('ended');
    teardown(notify);
    setTimeout(() => router.back(), 200);
  }, [teardown, router, peerUid, peerName, isIncoming]);

  // ── call-waiting / hold registration ───────────────────────
  // Lets a call arriving while we're busy become "call waiting": the incoming
  // screen can hold THIS call (pause our mic) and accept the new one, then we
  // resume when it ends and we regain focus.
  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const speakerRef = useRef(false);
  const heldRef = useRef(false);
  const meRef   = useRef<ActiveCall | null>(null);

  useEffect(() => {
    const me: ActiveCall = {
      chatId, peerUid, peerName: peerName || 'crazzychat user', kind: 'audio',
      hold:   () => { heldRef.current = true;  try {
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = false; });   // mute my mic
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = false; }); // silence the held peer
      } catch {} },
      resume: () => { heldRef.current = false; try {
        InCallManager.start({ media: 'audio', auto: true });               // re-acquire the audio route
        InCallManager.setForceSpeakerphoneOn(speakerRef.current ? true : null);
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = !mutedRef.current; });
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = true; });
      } catch {} },
      hangUp: () => endCall(true),
    };
    meRef.current = me;
    setActiveCall(me);
    return () => clearActiveCall(me);
  }, [chatId, peerUid, peerName, endCall]);

  // Regained focus after a call-waiting call ended → resume + re-assert active.
  useFocusEffect(useCallback(() => {
    if (heldRef.current && meRef.current) { meRef.current.resume(); setActiveCall(meRef.current); }
  }, []));

  // Once connected: keep audio alive via the mic foreground service, and clear
  // the native incoming-call ring (so it isn't later turned into a missed call).
  const fgStartedRef = useRef(false);
  useEffect(() => {
    if (state === 'connected' && !fgStartedRef.current) {
      fgStartedRef.current = true;
      startCallForeground(String(chatId || peerUid || 'call'), peerName || 'crazzychat user', '', false);
      dismissIncomingNotification();
    }
  }, [state, chatId, peerUid, peerName]);

  // ── timer ──────────────────────────────────────────────────
  // Stamp the connect instant once; <CallTimer> derives + renders the elapsed
  // time on its own, so nothing here re-renders the screen every second.
  const startTimer = useCallback(() => {
    if (!connectedAtRef.current) connectedAtRef.current = Date.now();
  }, []);

  // ── setup pipeline ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // 1. Audio session — InCallManager owns the call audio route. `auto`
        //    makes it follow wired/Bluetooth headsets automatically; earpiece
        //    is the default for a voice call (speaker off).
        try {
          InCallManager.start({ media: 'audio', auto: true });
          InCallManager.setForceSpeakerphoneOn(false);
        } catch {}

        // 2. Identity
        const me = await getCurrentUserAsync();
        if (!me?.id) throw new Error('Not signed in');
        meIdRef.current = me.id;

        // 3. Get media (audio only)
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        localStreamRef.current = stream;

        // 4. ICE config (cached TURN credentials — see lib/iceConfig). Falls
        //    back to STUN-only exactly as before if the request fails.
        const iceServers = await getIceServers();

        // 5. Build peer connection
        const pc = new RTCPeerConnection({ iceServers: iceServers as any });
        pcRef.current = pc;
        stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

        (pc as any).ontrack = (e: any) => {
          // Remote audio plays automatically on native; no <RTCView> needed for audio.
          if (state !== 'connected') {
            setState('connected');
            startTimer();
          }
        };

        // 6. Socket + signaling wires
        const s = await getSocket();

        const onAnswer = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) { console.warn('[call] answer from wrong peer'); return; }
          const sdp = cipherRef.current.open(data.answer || data.sdp);   // F6: sealed for E2EE calls
          if (!sdp?.type) { console.warn('[call] answer failed to open (E2EE cipher mismatch or bad sdp)'); return; }
          if (!pcRef.current || pcRef.current.signalingState !== 'have-local-offer') return; // already applied / closed
          console.warn('[call] ANSWER applied → setRemoteDescription');
          try { await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp)); }
          catch (e: any) { console.warn('[call] setRemoteDescription failed:', e?.message); return; }
          if (state !== 'connected') { setState('connected'); startTimer(); }
        };
        const onIce = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) return;
          const cand = cipherRef.current.open(data?.candidate);          // F6: sealed for E2EE calls
          if (!cand || !pcRef.current) return;
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
        };
        const onEnd = (data: any) => {
          if (data?.from === peerUid || data?.fromUid === peerUid) endCall(false);
        };
        s.on('webrtc_answer', onAnswer);
        s.on('webrtc_ice',    onIce);
        s.on('webrtc_end',    onEnd);
        offsRef.current.push(() => s.off('webrtc_answer', onAnswer));
        offsRef.current.push(() => s.off('webrtc_ice',    onIce));
        offsRef.current.push(() => s.off('webrtc_end',    onEnd));

        (pc as any).onicecandidate = (event: any) => {
          // FAIL CLOSED at the one place a candidate reaches the wire (mirrors
          // lib/vaultBeamDirect.ts's emitIce). `enc === false` is callCrypto's
          // plaintext passthrough — sealing with it is a no-op, so the raw
          // candidate, and the device IP in it, would go to our own server.
          if (!event.candidate || !peerUid) return;
          // Not yet sealable: HOLD, do not drop. See pendingIceRef.
          if (!cipherRef.current.enc) { pendingIceRef.current.push(event.candidate); return; }
          s.emit('webrtc_ice', { to: peerUid, from: meIdRef.current, candidate: cipherRef.current.seal(event.candidate) });
        };

        // `disconnected` is TRANSIENT — a Wi-Fi→LTE handover, a lift, a tunnel —
        // and usually recovers on its own. Ending the call on it drops a call on
        // every blip. Only `failed`/`closed` are terminal; `disconnected` gets an
        // ICE restart and a grace window first. (Mirrors lib/call/peer.ts.)
        (pc as any).onconnectionstatechange = () => {
          const st = (pc as any).connectionState;
          if (st !== 'disconnected' && disconnectGraceRef.current) {
            clearTimeout(disconnectGraceRef.current);
            disconnectGraceRef.current = null;
          }
          if (st === 'failed' || st === 'closed') { endCall(true); return; }
          if (st === 'disconnected' && !disconnectGraceRef.current) {
            try { (pc as any).restartIce?.(); } catch {}
            disconnectGraceRef.current = setTimeout(() => {
              disconnectGraceRef.current = null;
              if ((pc as any).connectionState === 'disconnected') endCall(true);
            }, DISCONNECT_GRACE_MS);
          }
        };

        // 7. Either accept the incoming offer, or create + send our own
        if (isIncoming === 'true' && initialOffer) {
          // F6: encrypted sig1 wire (new caller) or raw plaintext (legacy).
          const parsedWire = JSON.parse(String(initialOffer));
          const { cipher, offer: offerObj } = await openCallOffer(peerUid, parsedWire);
          cipherRef.current = cipher;
          if (!offerObj?.type) {
            throw new Error('Secure call setup failed — ask the caller to try again');
          }
          // FAIL CLOSED, the answering half. An offer that arrived UNSEALED is
          // indistinguishable from one our own server wrote, and answering it
          // would put our DTLS-SRTP fingerprint and every candidate on the wire
          // in the clear too. (Same rule, same reason: lib/vaultBeamDirect.ts.)
          if (!cipher.enc) {
            throw new Error("This call wasn't encrypted, so we didn't connect it. The caller is on an old version of crazzychat — ask them to update, then call again.");
          }
          await pc.setRemoteDescription(new RTCSessionDescription(offerObj));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          // Resend the one-shot answer a few times — a single socket 'transport
          // error' blip during setup used to drop it and strand the call. The
          // caller applies only the first (setRemoteDescription is guarded).
          const answerWire = { to: peerUid, from: meIdRef.current, answer: cipher.seal(answer) };
          console.warn('[call] sending ANSWER to', peerUid);
          s.emit('webrtc_answer', answerWire);
          let ansTries = 0;
          const ansTimer = setInterval(() => {
            if (connectedRef.current || ansTries >= 4) { clearInterval(ansTimer); return; }
            ansTries++; try { s.emit('webrtc_answer', answerWire); } catch {}
          }, 1500);
          offsRef.current.push(() => clearInterval(ansTimer));
          setState('connecting');
        } else {
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
          await pc.setLocalDescription(offer);
          // F6: seal the signaling under a per-call key (ratchet-wrapped once).
          const sealed = await newCallCipher(peerUid, offer);
          // FAIL CLOSED. This used to be `sealed ? sealed.offerWire : offer` —
          // a silent downgrade to a RAW SDP on our own socket, while the UI
          // kept its encryption claim. The SDP carries the DTLS-SRTP
          // fingerprint that anchors call-media encryption, so a server that
          // can rewrite it MITMs the call outright (lib/callCrypto.ts header).
          if (!sealed) {
            throw new Error("Can't place an encrypted call — we couldn't get this person's encryption keys. Ask them to open crazzychat once (or update it), then try again.");
          }
          cipherRef.current = sealed.cipher;
          // Flush what gathered while the key bundle was in flight. Sealed with
          // the real cipher, so this is the fail-closed guarantee kept intact —
          // nothing leaves unsealed, and nothing is thrown away either.
          if (pendingIceRef.current.length) {
            const held = pendingIceRef.current;
            pendingIceRef.current = [];
            for (const c of held) {
              try { s.emit('webrtc_ice', { to: peerUid, from: meIdRef.current, candidate: cipherRef.current.seal(c) }); } catch {}
            }
          }
          const offerWire = sealed.offerWire;
          // Notify peer it's an incoming call (separate event so the
          // recipient can show a UI before answering, and so that the
          // OFFER itself can ride alongside)
          const ringPayload = {
            to: peerUid,
            from: meIdRef.current,
            chatId,
            type: 'audio',
            callerName: me.name || me.email || 'crazzychat user',
            offer: offerWire,
          };
          s.emit('call_incoming', ringPayload);
          s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer: offerWire });
          // High-priority FCM wake-up so a killed/doze callee still rings.
          // Doorbell only — no SDP rides in the push (F6).
          initiateCall({ calleeId: peerUid, callId: String(chatId || peerUid), isVideo: false }).catch(() => {});
          setState('ringing');
          // Re-send the ring + offer every 3s while ringing (same sealed wire —
          // never re-encrypt per tick). Stops on connect/teardown or after ~30s.
          let rings = 0;
          ringTimerRef.current = setInterval(() => {
            if (connectedRef.current || rings >= 9) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; return; }
            rings++;
            try { s.emit('call_incoming', ringPayload); s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer: offerWire }); } catch {}
          }, 3000);
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? 'Call failed');
        endCall(true);
      }
    };

    run();
    return () => { cancelled = true; teardown(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerUid, chatId, isIncoming, initialOffer]);

  // ── controls ──────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks?.() ?? [];
    const next = !muted;
    tracks.forEach((t: any) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  // Stable identity so the memoized End button doesn't re-render on every pass
  // (and so the press event is never mistaken for the `notify` argument).
  const hangUp = useCallback(() => endCall(true), [endCall]);

  const toggleSpeaker = useCallback(() => {
    const next = !speaker;
    setSpeaker(next);
    speakerRef.current = next;
    // null route when speaker is OFF lets InCallManager keep using a connected
    // Bluetooth/wired headset instead of forcing the earpiece.
    try { InCallManager.setForceSpeakerphoneOn(next ? true : null); } catch {}
  }, [speaker]);

  // ── render ────────────────────────────────────────────────
  const statusText = state === 'connecting' ? 'Connecting…'
    : state === 'ringing'   ? 'Ringing…'
    : 'Call ended';
  const initial = (peerName?.trim()[0] ?? '?').toUpperCase();

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={S.body}>
        <View style={S.avatarWrap}>
          <View style={S.avatar}><Text style={S.avatarTxt}>{initial}</Text></View>
        </View>
        <Text numberOfLines={1} style={S.name}>{peerName || 'crazzychat user'}</Text>
        {state === 'connected'
          ? <CallTimer style={S.status} startedAt={connectedAtRef.current} />
          : <Text style={S.status}>{statusText}</Text>}
        {error && <Text style={S.errorTxt}>{error}</Text>}
      </View>

      <View style={[S.controls, { paddingBottom: insets.bottom + 24 }]}>
        <CallControlButton icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
        <CallControlButton icon={speaker ? 'volume-high' : 'volume-low'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={toggleSpeaker} />
        <CallControlButton icon="call" label="End" danger onPress={hangUp} />
      </View>
    </View>
  );
}

function makeStyles() { return StyleSheet.create({
  screen:     { flex: 1, backgroundColor: CALL.bg },
  addTopBtn:  { position: 'absolute', left: 16, zIndex: 5, width: 40, height: 40, borderRadius: 20,
                alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  body:       { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, gap: 16 },
  avatarWrap: { marginBottom: 16 },
  avatar:     { width: 140, height: 140, borderRadius: 70, backgroundColor: CALL.active, alignItems: 'center', justifyContent: 'center', shadowColor: CALL.active, shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt:  { color: '#fff', fontSize: 56, fontWeight: '800' },
  name:       { color: CALL.text, fontSize: 26, fontWeight: '700', textAlign: 'center' },
  status:     { color: CALL.textDim, fontSize: 16 },
  errorTxt:   { color: CALL.danger, fontSize: 13, marginTop: 8 },

  // Button metrics now live with the button (components/call/CallControlButton,
  // variant 'voice') — same values, one owner.
  controls:   { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24, paddingTop: 12 },
}); }
