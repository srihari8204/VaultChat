// app/group-call-active.tsx — the group call screen. TWO BODIES, one route.
//
// GroupCallEngine (CALL_ENGINE_V2, the live path) draws a call that rides the
// LiveKit SFU: one upstream per participant, the server forwards. It PAGES —
// the grid shows a bounded set of tiles and tells the engine which cameras it
// wants, because subscribing to everyone is what makes a large call
// unaffordable however good the transport is.
//
// GroupCallLegacy (CALL_ENGINE_V2 off) is the original full mesh: one
// RTCPeerConnection per pair, roster over join_call/call_roster/
// call_peer_joined/call_peer_left, per-pair offer/answer/ice through the
// webrtc_* relay, glare avoided by "the smaller uid sends the offer". It is
// kept as the ROLLBACK — the server still caps it at MESH_MAX_PARTICIPANTS,
// because a mesh cannot hold more, and it is not where new work goes.
//
// NOTE: WebRTC can only be fully validated on real devices/networks.

import { HEADER_TOP } from '../constants/layout';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StatusBar, StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { mediaDevices, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, RTCView } from '@livekit/react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { type Palette } from '../constants/theme';
import { CALL_ENGINE_V2 } from '../constants/flags';
// The seat count comes from the same module the rest of the call rules live in,
// so the UI and the policy cannot drift. The SERVER is the authority (it refuses
// the join); this is only what the screen shows.
import { SFU_MAX as CALL_MAX } from '../lib/call/mode';
import { useTheme } from '../lib/theme';
import { getIceServers } from '../lib/iceConfig';
import { getChat, type ChatMember } from '../lib/chatService';
import { getSocket } from '../lib/socket';
import { newCallCipher, openCallOffer, plainCipher, type CallCipher } from '../lib/callCrypto';
import { getCurrentUserAsync } from './(constants)/authService';
import * as engine from '../lib/call/engine';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { CallTimer } from '../components/call/CallTimer';
import { CallExtras } from '../components/call/CallExtras';
import { CallEncryptionBadge, protectionFor } from '../components/call/CallEncryptionBadge';
import {
  useCallConnectedAt, useCallError, useCallFlag, useCallLocalUrl,
  useCallStatus, useCanModerate, useMyHandRaised, useParticipant,
  useParticipantIds, useRaisedHands, useSharingPeer, useVisibleParticipantIds,
} from '../hooks/useCall';

// How many people the Add sheet offers at once. 12 was the old value and it is
// wrong for a 64-seat call: in a 40-person group you could see 12 of the
// missing members and no way to reach the rest. The sheet scrolls, so this is
// only a guard against rendering an unbounded contact list in one pass.
const ADD_LIST_MAX = 50;


type Peer = { pc: RTCPeerConnection; url: string | null; name: string };

/**
 * Route entry. Same dispatcher as the 1:1 screens — one flag picks the
 * engine-backed renderer or the original body, both drawing the same grid from
 * the same styles and speaking the same wire.
 */
export default function GroupCallActive() {
  return CALL_ENGINE_V2 ? <GroupCallEngine /> : <GroupCallLegacy />;
}

/** One remote participant. Memoized and subscribed to its OWN peer, so a tile
 *  re-renders when that peer's stream changes and not when anyone else's does. */
const ParticipantTile = memo(function ParticipantTile(
  { uid, width, isVideo, onModerate }: {
    uid: string; width: string; isVideo: boolean; onModerate?: (uid: string, name: string) => void;
  },
) {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const p = useParticipant(uid);
  const url = p?.streamUrl ?? null;
  const name = p?.name || (url ? 'Connected' : 'Connecting…');
  return (
    <TouchableOpacity
      style={[S.tile, { width: width as any }]}
      activeOpacity={onModerate ? 0.7 : 1}
      disabled={!onModerate}
      onPress={() => onModerate?.(uid, name)}
    >
      {isVideo && url
        ? <RTCView streamURL={url} style={S.video} objectFit="cover" />
        : <View style={S.audioTile}>
            {url ? <RTCView streamURL={url} style={{ width: 1, height: 1 }} /> : null}
            <Ionicons name="person" size={34} color="#fff" />
          </View>}
      {/* A raised hand has to be visible on the tile, not only in a list a host
          might not have open — the whole point is that it interrupts. */}
      {!!p?.handRaisedAt && (
        <View style={S.handBadge}><Text style={S.handBadgeTxt}>✋</Text></View>
      )}
      {p?.role === 'audience' && (
        <View style={S.roleBadge}><Ionicons name="eye-outline" size={11} color="#fff" /></View>
      )}
      <Text style={S.tileName} numberOfLines={1}>{name}</Text>
    </TouchableOpacity>
  );
});

// ── engine-backed renderer (CALL_ENGINE_V2) ───────────────────────────
// Everything the legacy body did by hand — peer map, glare rule, offer/answer,
// ICE buffering, cipher, teardown — now lives in lib/call. This screen draws.
// It also gains what the mesh never had: a foreground service so audio survives
// backgrounding, an FCM doorbell so a killed device rings, call logging, call
// waiting, a duration timer, a speaker toggle and flip camera.
function GroupCallEngine() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { chatId, video, name, members } = useLocalSearchParams<{
    chatId: string; video?: string; name?: string; members?: string;
  }>();
  const isVideo = video === '1';

  const status      = useCallStatus();
  const connectedAt = useCallConnectedAt();
  const error       = useCallError();
  const muted       = useCallFlag('muted');
  const camOff      = useCallFlag('cameraOff');
  const sharer      = useSharingPeer();
  const speaker     = useCallFlag('speaker');
  const localUrl    = useCallLocalUrl();
  const peerIds     = useParticipantIds();
  const handUp      = useMyHandRaised();
  const canModerate = useCanModerate();
  const hands       = useRaisedHands();
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);

  // The COUNT is the whole call, never the visible page — "9 on call" in a room
  // of 40 is a lie, and it is also what the encryption badge reads. Declared
  // here, above the callbacks that close over it, because a useCallback
  // dependency array is evaluated during render.
  const tiles = peerIds.length + 1;
  const seatsLeft = Math.max(0, CALL_MAX - tiles);

  // Moderation is a menu rather than inline buttons: the actions are rare,
  // mutually exclusive, and destructive-ish (demoting someone mid-sentence), so
  // they belong behind a deliberate tap rather than next to a video surface
  // where a mis-tap is easy.
  // Five actions: Android's Alert renders three, so 'Move to audience' and
  // 'Lower hand' were unreachable there. Sheet takes as many as we give it.
  const moderate = useCallback((uid: string, name: string) => {
    setSheet({
      title: name,
      message: 'Change what this person can do',
      actions: [
        { label: 'Make co-host', icon: 'shield-outline', onPress: () => engine.setRole(uid, 'cohost') },
        { label: 'Make speaker', icon: 'mic-outline', onPress: () => engine.setRole(uid, 'speaker') },
        { label: 'Move to audience', icon: 'people-outline', onPress: () => engine.setRole(uid, 'audience') },
        { label: 'Lower hand', icon: 'hand-left-outline', onPress: () => engine.lowerPeerHand(uid) },
      ],
    });
  }, []);
  const toggleHand = useCallback(() => engine.raiseHand(!handUp), [handUp]);

  // ── invite: how a call actually fills up ────────────────────────────
  //
  // A group call rings once, when it opens. Anyone asleep, on another call, or
  // added to the group afterwards was then shut out for the rest of it, and the
  // only way back in was to hang up and start again — which rings everyone a
  // second time. With 64 seats that gap is the difference between a call that
  // can grow and one that cannot.
  //
  // The list is read WHEN THE SHEET OPENS, not held in state: it must reflect
  // who is on the call right now, and members can be added to the group during
  // a call. Anyone already here is filtered out by the engine — ringing someone
  // whose phone is showing this call is the one obviously wrong outcome.
  const invite = useCallback(async () => {
    const id = String(chatId ?? '');
    if (!id) return;
    let roster: ChatMember[] = [];
    try {
      const chat = await getChat(id);
      roster = (chat?.members ?? []).filter((m: ChatMember) => !m.leftAt);
    } catch {
      setSheet({ title: 'Add people', message: 'Could not load the group just now.', actions: [] });
      return;
    }
    const here = new Set(peerIds);
    const away = roster.filter(m => !here.has(m.userId));

    // GROUP MEMBERS ARE NOT THE ONLY PEOPLE YOU CAN ADD.
    //
    // This used to offer `away` and nothing else, so once everyone in the group
    // had joined it said "Everyone in this group is already on the call" and
    // there was no way to pull anybody else in — reported as "after 3 members I
    // am unable to add users", which is exactly what happens in a 3-person
    // group. The 1:1 screens have always offered every direct contact.
    //
    // The server has supported this the whole time: POST /calls/{id}/ring
    // issues a call_invites grant for anyone named who is not a chat member,
    // and mayJoinCall admits them on it (migration 123). The grant is scoped to
    // THIS call — being added to a call gives no access to the group, its
    // history, or any later call. Only the picker was missing.
    const seen = new Set<string>([...here, ...away.map(m => m.userId)]);
    const guests: { id: string; name: string }[] = [];
    try {
      const { listChats } = await import('../lib/chatService');
      for (const c of (await listChats()) ?? []) {
        if (c.type !== 'direct') continue;
        const uid = c.peerUserId;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        guests.push({ id: uid, name: c.peerName || c.name || uid.slice(0, 8) });
      }
    } catch { /* group members alone are still a usable list */ }

    if (!away.length && !guests.length) {
      setSheet({ title: 'Add people', message: 'Nobody left to add.', actions: [] });
      return;
    }
    // Bounded to what the sheet can show at once. Ringing "everyone missing" in
    // one tap is what the START of a call is for; this is for naming people.
    setSheet({
      title: 'Add people',
      message: `${seatsLeft} of ${CALL_MAX} seats free`,
      // Group members first — they are the expected candidates — then everyone
      // else you already talk to. Both go through the same invite.
      actions: [
        ...away.map(m => ({
          label: m.name || m.email || m.userId.slice(0, 8),
          icon: 'person-add-outline' as const,
          onPress: () => { void engine.inviteToCall([m.userId]); },
        })),
        ...guests.map(g => ({
          label: g.name,
          icon: 'person-add-outline' as const,
          onPress: () => { void engine.inviteToCall([g.id]); },
        })),
      ].slice(0, ADD_LIST_MAX),
    });
  }, [chatId, peerIds, seatsLeft]);

  useEffect(() => {
    engine.startGroup({
      chatId: String(chatId ?? ''),
      groupName: String(name ?? 'Group call'),
      kind: isVideo ? 'video' : 'audio',
      // The hub passes the roster so the engine rings each member; joining an
      // in-progress call passes none.
      ring: members ? String(members).split(',').filter(Boolean) : [],
    });
    // Scoped like the 1:1 screens: unscoped, this cleanup ended whatever call
    // was live, so leaving a group call that had already been replaced by a
    // newly answered 1:1 hung THAT up instead. A group session is identified by
    // an empty peerUid — the same key startGroup's duplicate guard uses.
    return () => { engine.leaveScreen({ chatId: String(chatId ?? ''), peerUid: '' }); };
  }, [chatId, name, isVideo, members]);

  useEffect(() => { if (status === 'connected') engine.onConnected(); }, [status]);

  useEffect(() => {
    if (status !== 'ended') return;
    const t = setTimeout(() => router.back(), 200);
    return () => clearTimeout(t);
  }, [status, router]);

  // ── which faces are on screen, and which tracks that costs ──────────
  //
  // Rendering every participant is what makes a large call unaffordable: each
  // tile is a subscribed video track and a decoder, so an unbounded grid is 63
  // inbound decodes at 64 people — the same quadratic mesh was abandoned for,
  // moved from the encoder to the decoder.
  //
  // So the grid PAGES rather than growing, and tells the engine which cameras it
  // actually wants (lib/call/visibleSet.ts). Below the page size nothing changes
  // at all: `null` means "everyone", which is exactly what a 3-person call did
  // before any of this existed.
  //
  // Page 0 follows the conversation — active speakers first — so the person
  // talking is on the page you are looking at. Later pages are plain roster
  // order: once you have deliberately paged away, the grid must stop moving
  // under you. Someone can therefore appear on both, which is correct: page 0
  // is "who is talking", not a slice.
  const PAGE = 9;
  const [page, setPage] = useState(0);
  const autoPage = useVisibleParticipantIds(PAGE);
  const pages = Math.max(1, Math.ceil(peerIds.length / PAGE));
  // People leave: a page that no longer exists would render empty forever.
  useEffect(() => { if (page >= pages) setPage(0); }, [page, pages]);

  const paged = peerIds.length > PAGE;
  const shown = !paged ? peerIds
    : page === 0 ? autoPage
    : peerIds.slice(page * PAGE, page * PAGE + PAGE);
  const shownKey = shown.join(' ');

  useEffect(() => {
    // Re-declared on `status` as well as on the page: the grid mounts and pages
    // before the SFU connection exists, and a declaration made then is dropped.
    // Without this the call would stay subscribed to everyone until the user
    // happened to turn a page.
    engine.setVisibleParticipants(paged ? shownKey.split(' ').filter(Boolean) : null);
  }, [shownKey, paged, status]);

  const cols = shown.length + 1 <= 1 ? 1 : shown.length + 1 <= 4 ? 2 : 3;
  const tileW = `${100 / cols - 2}%`;

  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden />

      <View style={S.topBar}>
        <Text style={S.title} numberOfLines={1}>{name || 'Group call'}</Text>
        {status === 'connected'
          ? <CallTimer style={S.sub} startedAt={connectedAt} />
          // A recovering group call keeps its timer's place but says what is
          // happening; showing the participant count would imply everything is
          // fine while the transport is being rebuilt.
          : <Text style={S.sub}>{status === 'reconnecting' ? 'Reconnecting…' : `${tiles} on call`}</Text>}

        {/* ADDING PEOPLE HAS TO BE FINDABLE.
            The person-add control exists in the row below, but it is one
            unlabelled icon among six, four screens deep — reported as "I can't
            see the add user option", which is a fair reading of the UI rather
            than a missing feature. The participant count is where someone
            already looks to ask "who is on this call", so it is the natural
            place to also answer "and how do I add someone". Same handler, same
            capacity rule — this is a second door, not a second feature. */}
        {status === 'connected' && seatsLeft > 0 && (
          <TouchableOpacity onPress={invite} activeOpacity={0.7} style={S.addPeoplePill}>
            <Ionicons name="person-add" size={13} color="#fff" />
            <Text style={S.addPeopleTxt}>Add · {tiles}/{CALL_MAX}</Text>
          </TouchableOpacity>
        )}
        {/* D-1: derived from the live participant count, so a call that grows
            past the mesh cap stops claiming a guarantee it no longer has. */}
        <CallEncryptionBadge protection={protectionFor(tiles)} />
      </View>

      {/* SOMEONE IS SHARING, AND THE GROUP HAD NO WAY TO KNOW.
          The share itself always arrived — the tile URL prefers screens.get(uid)
          over the camera — but the grid gave no sign it had happened, so a
          share read as "screen share is not working". The 1:1 screen has had
          this banner all along; the flag it uses (peerSharing) is dispatched
          only for s.peerUid and is therefore always false in a group, which is
          why participants carry their own `sharing`. */}
      {sharer ? (
        <View style={S.shareBanner} pointerEvents="none">
          <Ionicons name="phone-portrait" size={13} color="#fff" />
          <Text style={S.shareBannerTxt} numberOfLines={1}>
            {sharer.name} is sharing their screen
          </Text>
        </View>
      ) : null}

      {error ? <Text style={S.err}>{error}</Text> : null}

      <ScrollView contentContainerStyle={S.grid}>
        <View style={[S.tile, { width: tileW as any }]}>
          {isVideo && !camOff && localUrl
            ? <RTCView streamURL={localUrl} style={S.video} objectFit="cover" mirror />
            : <View style={S.audioTile}><Ionicons name="person" size={34} color="#fff" /></View>}
          <Text style={S.tileName}>You{muted ? ' 🔇' : ''}</Text>
        </View>
        {shown.map(uid => (
          <ParticipantTile
            key={uid} uid={uid} width={tileW} isVideo={isVideo}
            onModerate={canModerate ? moderate : undefined}
          />
        ))}
      </ScrollView>

      {/* Only when there is somewhere to page TO. A call of four must not grow
          controls it can never use. */}
      {paged && (
        <View style={S.pager}>
          <TouchableOpacity
            style={S.pagerBtn} disabled={page === 0}
            onPress={() => setPage(p => Math.max(0, p - 1))}
          >
            <Ionicons name="chevron-back" size={20} color={page === 0 ? '#555' : '#fff'} />
          </TouchableOpacity>
          <Text style={S.pagerLabel}>
            {page === 0 ? 'Speaking' : `Page ${page + 1} of ${pages}`}
          </Text>
          <TouchableOpacity
            style={S.pagerBtn} disabled={page >= pages - 1}
            onPress={() => setPage(p => Math.min(pages - 1, p + 1))}
          >
            <Ionicons name="chevron-forward" size={20} color={page >= pages - 1 ? '#555' : '#fff'} />
          </TouchableOpacity>
        </View>
      )}

      {/* The host's queue, in the order people asked. Only shown to someone who
          can actually act on it — to anyone else it would be a list of requests
          they are powerless to grant. */}
      {canModerate && hands.length > 0 && (
        <Text style={S.handQueue} numberOfLines={1}>
          ✋ {hands.length} waiting — tap a tile to give the floor
        </Text>
      )}

      {status === 'connected' && <CallExtras bottom={110} />}

      <View style={S.controls}>
        <CtrlBtn icon={muted ? 'mic-off' : 'mic'} active={muted} onPress={engine.toggleMute} colors={colors} />
        {isVideo && <CtrlBtn icon={camOff ? 'videocam-off' : 'videocam'} active={camOff} onPress={engine.toggleCamera} colors={colors} />}
        {isVideo && <CtrlBtn icon="camera-reverse" onPress={engine.flipCamera} colors={colors} />}
        <CtrlBtn icon={speaker ? 'volume-high' : 'volume-low'} active={speaker} onPress={engine.toggleSpeaker} colors={colors} />
        <CtrlBtn icon="hand-left" active={handUp} onPress={toggleHand} colors={colors} />
        {/* Hidden at capacity rather than disabled: a button that does nothing
            invites tapping it, and "the call is full" is the more useful thing
            for the count in the header to be saying at that moment. */}
        {seatsLeft > 0 && <CtrlBtn icon="person-add" onPress={invite} colors={colors} />}
        <CtrlBtn icon="call" danger onPress={endGroupCall} colors={colors} />
      </View>

      <Sheet
        visible={!!sheet}
        title={sheet?.title}
        message={sheet?.message}
        actions={sheet?.actions ?? []}
        onClose={() => setSheet(null)}
      />
    </View>
  );
}

const endGroupCall = () => engine.hangUp('local_hangup', true);

// ── original implementation (CALL_ENGINE_V2 off) — unchanged ──────────
function GroupCallLegacy() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { chatId, video, name } = useLocalSearchParams<{ chatId: string; video?: string; name?: string }>();
  const isVideo = video === '1';

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(!isVideo);
  const [error, setError] = useState<string | null>(null);

  const meRef = useRef<string>('');
  const localStreamRef = useRef<any>(null);
  const iceRef = useRef<any[]>([]);
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({});
  const offsRef = useRef<Array<() => void>>([]);
  const pendingIce = useRef<Record<string, any[]>>({});
  // F6: per-peer E2EE signaling cipher (mesh = one ratchet-wrapped call key per
  // link). Defaults to plaintext passthrough for legacy peers.
  const ciphersRef = useRef<Record<string, CallCipher>>({});
  const cipherFor = (uid: string) => ciphersRef.current[uid] ?? plainCipher;

  const setPeerUrl = (uid: string, url: string | null, nm?: string) =>
    setPeers(prev => ({ ...prev, [uid]: { pc: pcsRef.current[uid], url, name: nm ?? prev[uid]?.name ?? '' } }));

  const closePeer = useCallback((uid: string) => {
    try { pcsRef.current[uid]?.close(); } catch {}
    delete pcsRef.current[uid];
    delete pendingIce.current[uid];
    delete ciphersRef.current[uid];
    setPeers(prev => { const n = { ...prev }; delete n[uid]; return n; });
  }, []);

  const ensurePeer = useCallback(async (uid: string, shouldOffer: boolean) => {
    if (pcsRef.current[uid]) return pcsRef.current[uid];
    const pc = new RTCPeerConnection({ iceServers: iceRef.current as any });
    pcsRef.current[uid] = pc;
    setPeers(prev => ({ ...prev, [uid]: { pc, url: null, name: '' } }));
    try { localStreamRef.current?.getTracks().forEach((t: any) => pc.addTrack(t, localStreamRef.current)); } catch {}
    (pc as any).onicecandidate = (e: any) => {
      if (e.candidate) getSocket().then(s => s.emit('webrtc_ice', { to: uid, chatId, candidate: cipherFor(uid).seal(e.candidate) })).catch(() => {});
    };
    (pc as any).ontrack = (e: any) => { const rs = e.streams?.[0]; if (rs) setPeerUrl(uid, rs.toURL()); };
    (pc as any).oniceconnectionstatechange = () => {
      const st = (pc as any).iceConnectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') {/* peer-left handles removal */}
    };
    if (shouldOffer) {
      try {
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        const s = await getSocket();
        // F6: seal the offer under a per-peer call key (ratchet-wrapped once).
        const sealed = await newCallCipher(uid, pc.localDescription);
        if (sealed) ciphersRef.current[uid] = sealed.cipher;
        s.emit('webrtc_offer', { to: uid, chatId, sdp: sealed ? sealed.offerWire : pc.localDescription });
      } catch (err: any) { setError(err?.message ?? 'offer failed'); }
    }
    return pc;
  }, [chatId]);

  // ── setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getCurrentUserAsync();
        meRef.current = me?.id ?? '';
        // Cached TURN credentials (lib/iceConfig): one fetch for the whole mesh
        // instead of a race between the peers coming up.
        iceRef.current = await getIceServers();
        const stream = await mediaDevices.getUserMedia({ audio: true, video: isVideo ? { facingMode: 'user' } : false });
        if (cancelled) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        localStreamRef.current = stream;
        try { InCallManager.start({ media: isVideo ? 'video' : 'audio', auto: true }); InCallManager.setForceSpeakerphoneOn(isVideo); } catch {}
        setLocalUrl(stream.toURL());

        const s = await getSocket();
        const smaller = (uid: string) => meRef.current < uid;   // glare rule

        const onRoster = ({ chatId: cid, peers: list }: any) => {
          if (cid !== chatId) return;
          for (const uid of list) ensurePeer(uid, smaller(uid));
        };
        const onJoined = ({ chatId: cid, uid }: any) => { if (cid === chatId && uid !== meRef.current) ensurePeer(uid, smaller(uid)); };
        const onLeft = ({ chatId: cid, uid }: any) => { if (cid === chatId) closePeer(uid); };
        const onOffer = async ({ from, sdp }: any) => {
          if (!from || !sdp) return;
          const pc = await ensurePeer(from, false);
          try {
            // F6: sdp is either an encrypted sig1 wire (new peer) or raw SDP (legacy).
            const { cipher, offer } = await openCallOffer(from, sdp);
            ciphersRef.current[from] = cipher;
            if (!offer?.type) { setError('Secure group-call setup failed'); return; }
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            (pendingIce.current[from] || []).forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
            pendingIce.current[from] = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            s.emit('webrtc_answer', { to: from, chatId, sdp: cipher.seal(pc.localDescription) });
          } catch (err: any) { setError(err?.message ?? 'answer failed'); }
        };
        const onAnswer = async ({ from, sdp }: any) => {
          const pc = pcsRef.current[from];
          const ans = cipherFor(from).open(sdp);   // F6: decrypt for E2EE peers
          if (pc && ans?.type) { try { await pc.setRemoteDescription(new RTCSessionDescription(ans)); (pendingIce.current[from] || []).forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); pendingIce.current[from] = []; } catch {} }
        };
        const onIce = async ({ from, candidate }: any) => {
          const pc = pcsRef.current[from];
          const cand = cipherFor(from).open(candidate);   // F6: decrypt; buffer plaintext
          if (!cand) return;
          if (pc && (pc as any).remoteDescription) { pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {}); }
          else { (pendingIce.current[from] = pendingIce.current[from] || []).push(cand); }
        };

        // P6.1: the server refuses a join that would push a full-mesh call
        // past its capacity (each extra participant costs EVERY phone another
        // peer connection + outbound encode). Surface it and leave, rather
        // than sitting on a call screen that never receives a roster.
        const onFull = ({ chatId: cid, max }: any) => {
          if (cid !== chatId) return;
          Alert.alert(
            'Call is full',
            `Group calls support up to ${max ?? 5} people on this connection. Ask someone to leave, then try again.`,
            [{ text: 'OK', onPress: () => router.back() }],
          );
        };

        s.on('call_roster', onRoster);
        s.on('call_peer_joined', onJoined);
        s.on('call_peer_left', onLeft);
        s.on('call_full', onFull);
        s.on('webrtc_offer', onOffer);
        s.on('webrtc_answer', onAnswer);
        s.on('webrtc_ice', onIce);
        offsRef.current = [
          () => s.off('call_roster', onRoster), () => s.off('call_peer_joined', onJoined),
          () => s.off('call_peer_left', onLeft), () => s.off('call_full', onFull),
          () => s.off('webrtc_offer', onOffer),
          () => s.off('webrtc_answer', onAnswer), () => s.off('webrtc_ice', onIce),
        ];
        s.emit('join_call', { chatId });
      } catch (err: any) {
        if (!cancelled) { setError(err?.message ?? 'Could not start the call'); }
      }
    })();

    return () => {
      cancelled = true;
      try { InCallManager.stop(); } catch {}
      offsRef.current.forEach(fn => { try { fn(); } catch {} });
      getSocket().then(s => s.emit('leave_call', { chatId })).catch(() => {});
      Object.keys(pcsRef.current).forEach(uid => { try { pcsRef.current[uid].close(); } catch {} });
      try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    };
  }, [chatId, isVideo, ensurePeer, closePeer, router]);

  const toggleMute = () => {
    const next = !muted; setMuted(next);
    try { localStreamRef.current?.getAudioTracks().forEach((t: any) => { t.enabled = !next; }); } catch {}
  };
  const toggleCam = () => {
    const next = !camOff; setCamOff(next);
    try { localStreamRef.current?.getVideoTracks().forEach((t: any) => { t.enabled = !next; }); } catch {}
  };
  const hangUp = () => router.back();

  const remoteList = Object.entries(peers);
  const tiles = remoteList.length + 1;
  const cols = tiles <= 1 ? 1 : tiles <= 4 ? 2 : 3;

  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden />

      <View style={S.topBar}>
        <Text style={S.title} numberOfLines={1}>{name || 'Group call'}</Text>
        <Text style={S.sub}>{tiles} on call</Text>
        <CallEncryptionBadge protection={protectionFor(tiles)} />
      </View>

      {error ? <Text style={S.err}>{error}</Text> : null}

      <ScrollView contentContainerStyle={S.grid}>
        {/* Local tile */}
        <View style={[S.tile, { width: `${100 / cols - 2}%` }]}>
          {isVideo && !camOff && localUrl
            ? <RTCView streamURL={localUrl} style={S.video} objectFit="cover" mirror />
            : <View style={S.audioTile}><Ionicons name="person" size={34} color="#fff" /></View>}
          <Text style={S.tileName}>You{muted ? ' 🔇' : ''}</Text>
        </View>
        {/* Remote tiles */}
        {remoteList.map(([uid, p]) => (
          <View key={uid} style={[S.tile, { width: `${100 / cols - 2}%` }]}>
            {isVideo && p.url
              ? <RTCView streamURL={p.url} style={S.video} objectFit="cover" />
              : <View style={S.audioTile}>{p.url ? <RTCView streamURL={p.url} style={{ width: 1, height: 1 }} /> : null}<Ionicons name="person" size={34} color="#fff" /></View>}
            <Text style={S.tileName} numberOfLines={1}>{p.url ? (p.name || 'Connected') : 'Connecting…'}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={S.controls}>
        <CtrlBtn icon={muted ? 'mic-off' : 'mic'} active={muted} onPress={toggleMute} colors={colors} />
        {isVideo && <CtrlBtn icon={camOff ? 'videocam-off' : 'videocam'} active={camOff} onPress={toggleCam} colors={colors} />}
        <CtrlBtn icon="call" danger onPress={hangUp} colors={colors} />
      </View>
    </View>
  );
}

function CtrlBtn({ icon, onPress, active, danger, colors }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={{ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: danger ? colors.danger : active ? colors.primary : 'rgba(255,255,255,0.12)' }}>
      <Ionicons name={icon} size={26} color="#fff" />
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: '#0B0B10' },
  topBar:    { paddingTop: HEADER_TOP, paddingHorizontal: 20, paddingBottom: 8, alignItems: 'center' },
  title:     { color: '#fff', fontSize: 18, fontWeight: '800' },
  sub:       { color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 2 },
  err:       { color: '#FCA5A5', textAlign: 'center', fontSize: 13, paddingHorizontal: 20 },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 6, paddingTop: 8 },
  tile:      { aspectRatio: 0.8, marginHorizontal: '1%', marginBottom: 10, borderRadius: 14, overflow: 'hidden', backgroundColor: '#1A1A22', justifyContent: 'flex-end' },
  video:     { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  audioTile: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  tileName:  { color: '#fff', fontSize: 12, fontWeight: '600', padding: 6, backgroundColor: 'rgba(0,0,0,0.4)' },
  handBadge: { position: 'absolute', top: 6, left: 6, width: 26, height: 26, borderRadius: 13,
               alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
  handBadgeTxt: { fontSize: 14 },
  roleBadge: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11,
               alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' },
  handQueue: { color: '#FFD479', fontSize: 12, textAlign: 'center', paddingBottom: 6 },
  shareBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center',
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
    backgroundColor: 'rgba(157,110,255,0.30)',
  },
  shareBannerTxt: { color: '#fff', fontSize: 12, fontWeight: '700', maxWidth: 260 },
  addPeoplePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center',
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  addPeopleTxt: { color: '#fff', fontSize: 12, fontWeight: '600' },
  pager:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, paddingBottom: 4 },
  pagerBtn:   { padding: 8 },
  pagerLabel: { color: '#bbb', fontSize: 12, minWidth: 110, textAlign: 'center' },
  controls:  { flexDirection: 'row', justifyContent: 'center', gap: 22, paddingVertical: 24, paddingBottom: 36 },
});
