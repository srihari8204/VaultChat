// app/group-call-active.tsx — REAL mesh group call (no SFU).
//
// Each participant holds one RTCPeerConnection to every other participant
// (full mesh — fine for small groups; an SFU is only needed for scale). The
// call room + roster is signalled by the server (join_call/call_roster/
// call_peer_joined/call_peer_left); per-pair offer/answer/ice flow through the
// existing webrtc_* relay, tagged with `to`/`from`. Glare is avoided by the
// deterministic rule "the smaller uid sends the offer".
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
import { useTheme } from '../lib/theme';
import { getIceServers } from '../lib/iceConfig';
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
  useParticipantIds, useRaisedHands,
} from '../hooks/useCall';

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
  const speaker     = useCallFlag('speaker');
  const localUrl    = useCallLocalUrl();
  const peerIds     = useParticipantIds();
  const handUp      = useMyHandRaised();
  const canModerate = useCanModerate();
  const hands       = useRaisedHands();
  const [sheet, setSheet] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);

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

  const tiles = peerIds.length + 1;
  const cols = tiles <= 1 ? 1 : tiles <= 4 ? 2 : 3;
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
        {/* D-1: derived from the live participant count, so a call that grows
            past the mesh cap stops claiming a guarantee it no longer has. */}
        <CallEncryptionBadge protection={protectionFor(tiles)} />
      </View>

      {error ? <Text style={S.err}>{error}</Text> : null}

      <ScrollView contentContainerStyle={S.grid}>
        <View style={[S.tile, { width: tileW as any }]}>
          {isVideo && !camOff && localUrl
            ? <RTCView streamURL={localUrl} style={S.video} objectFit="cover" mirror />
            : <View style={S.audioTile}><Ionicons name="person" size={34} color="#fff" /></View>}
          <Text style={S.tileName}>You{muted ? ' 🔇' : ''}</Text>
        </View>
        {peerIds.map(uid => (
          <ParticipantTile
            key={uid} uid={uid} width={tileW} isVideo={isVideo}
            onModerate={canModerate ? moderate : undefined}
          />
        ))}
      </ScrollView>

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
  controls:  { flexDirection: 'row', justifyContent: 'center', gap: 22, paddingVertical: 24, paddingBottom: 36 },
});
