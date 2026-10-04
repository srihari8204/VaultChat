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
import { Alert, BackHandler, StatusBar, StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { mediaDevices, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, RTCView } from '@livekit/react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { type Palette } from '../constants/theme';
import { CALL_ENGINE_V2 } from '../constants/flags';
import { CALL } from '../constants/callTheme';
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
import { inviteAndDescribe } from '../components/call/inviteResult';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useCallConnectedAt, useCallError, useCallFlag, useCallLocalUrl,
  useCallStatus, useCanModerate, useMyHandRaised, useParticipant,
  useParticipantIds, useRaisedHands, useSharingPeer, useVisibleParticipantIds,
} from '../hooks/useCall';
import { setRingingPeer, setRingScreenPeer } from '../lib/ringTracker';
import { endMessage } from '../lib/call/endMessage';
import { getSnapshot } from '../lib/call/store';

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
    uid: string; width: `${number}%`; isVideo: boolean; onModerate?: (uid: string, name: string) => void;
  },
) {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const p = useParticipant(uid);
  const url = p?.streamUrl ?? null;
  const name = p?.name || (url ? 'Connected' : 'Connecting…');
  return (
    <TouchableOpacity
      style={[S.tile, { width }]}
      activeOpacity={onModerate ? 0.7 : 1}
      disabled={!onModerate}
      onPress={() => onModerate?.(uid, name)}
      // A host taps a tile to moderate; for everyone else it is a picture.
      accessibilityRole={onModerate ? 'button' : undefined}
      accessibilityLabel={[
        onModerate ? `Moderate ${name}` : name,
        p?.handRaisedAt ? 'hand raised' : '',
        p?.role === 'audience' ? 'in the audience' : '',
      ].filter(Boolean).join(', ')}
    >
      {isVideo && url
        ? <RTCView streamURL={url} style={S.video} objectFit="cover" />
        : <View style={S.audioTile}>
            {url ? <RTCView streamURL={url} style={{ width: 1, height: 1 }} /> : null}
            <Ionicons name="person" size={34} color={CALL.text} />
          </View>}
      {/* A raised hand has to be visible on the tile, not only in a list a host
          might not have open — the whole point is that it interrupts. */}
      {!!p?.handRaisedAt && (
        <View style={S.handBadge} accessibilityLabel="Hand raised"><Text style={S.handBadgeTxt}>✋</Text></View>
      )}
      {p?.role === 'audience' && (
        <View style={S.roleBadge}><Ionicons name="eye-outline" size={11} color={CALL.text} /></View>
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
  const insets = useSafeAreaInsets();
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
  const [sheet, setSheetState] = useState<{ title: string; message?: string; actions: SheetAction[] } | null>(null);
  // Role changes, the roster load and invites all resolve after a network round
  // trip, by which time the call may have ended and this screen left. Drop the
  // result then rather than set state on an unmounted screen (as voice/video do).
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setSheet = useCallback((v: typeof sheet) => { if (mounted.current) setSheetState(v); }, []);
  // Height of the control bar, measured. CallExtras is pinned from the bottom
  // and must clear it; the bar is 1-3 rows depending on width and call state,
  // so a literal cannot be right on every device. 110 is the single-row value
  // it used to hardcode, used until the first layout lands.
  const [controlsH, setControlsH] = useState(110);

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
  //
  // setRole resolves false when the server refused (not a host any more, the
  // session is gone, offline). That used to be dropped, so a refused demotion
  // looked done; the sheet now says so.
  const changeRole = useCallback(async (uid: string, name: string, role: 'cohost' | 'speaker' | 'audience') => {
    let ok = false;
    try { ok = await engine.setRole(uid, role); } catch { ok = false; }
    if (!ok) setSheet({ title: name, message: 'Could not change their role. Check your connection, or whether you are still a host.', actions: [] });
  }, [setSheet]);
  // Same contract as changeRole: a refused lower is reported, and the engine
  // puts the hand back up so the queue stays true.
  const lowerHand = useCallback(async (uid: string, name: string) => {
    let ok = false;
    try { ok = await engine.lowerPeerHand(uid); } catch { ok = false; }
    if (!ok) setSheet({ title: name, message: 'Could not lower their hand. Check your connection, or whether you are still a host.', actions: [] });
  }, [setSheet]);
  const moderate = useCallback((uid: string, name: string) => {
    setSheet({
      title: name,
      message: 'Change what this person can do',
      actions: [
        { label: 'Make co-host', icon: 'shield-outline', onPress: () => { void changeRole(uid, name, 'cohost'); } },
        { label: 'Make speaker', icon: 'mic-outline', onPress: () => { void changeRole(uid, name, 'speaker'); } },
        // Demoting someone mid-sentence cuts their mic for everyone: confirm it.
        { label: 'Move to audience', icon: 'people-outline', onPress: () => Alert.alert(
          `Move ${name} to the audience?`,
          'Their microphone and camera stop for everyone until someone makes them a speaker again.',
          [{ text: 'Cancel', style: 'cancel' },
           { text: 'Move', style: 'destructive', onPress: () => { void changeRole(uid, name, 'audience'); } }],
        ) },
        { label: 'Lower hand', icon: 'hand-left-outline', onPress: () => { void lowerHand(uid, name); } },
      ],
    });
  }, [changeRole, lowerHand, setSheet]);
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
  // Say what an invite tap did: zero rung (already here, call over) is not success.
  const reportInvite = useCallback((outcome: Promise<string>) => {
    void outcome.then(message => setSheet({ title: 'Add people', message, actions: [] }));
  }, [setSheet]);
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
        ...away.map(m => {
          const label = m.name || m.email || m.userId.slice(0, 8);
          return {
            label,
            icon: 'person-add-outline' as const,
            onPress: () => { reportInvite(inviteAndDescribe(() => engine.inviteToCall([m.userId]), label)); },
          };
        }),
        ...guests.map(g => ({
          label: g.name,
          icon: 'person-add-outline' as const,
          onPress: () => { reportInvite(inviteAndDescribe(() => engine.inviteToCall([g.id]), g.name)); },
        })),
      ].slice(0, ADD_LIST_MAX),
    });
  }, [chatId, peerIds, seatsLeft, reportInvite, setSheet]);

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
    return () => {
      engine.leaveScreen({ chatId: String(chatId ?? ''), peerUid: '' });
      // RELEASE THE RING CLAIM (2026-09-17). app/_layout.tsx claims it before
      // pushing here ("The call screens release it when they unmount") and
      // voicecall.tsx:176-177 / videocall.tsx:293-294 both honour that — this
      // screen never did, and did not even import ringTracker. After one group
      // call answered from a notification, _layout's duplicate-ring guard
      // (`getRingScreenPeer() === p.peerUid`) stayed pinned to that caller, so
      // the phone never rang for them again.
      setRingingPeer(null);
      setRingScreenPeer(null);
    };
  }, [chatId, name, isVideo, members]);

  useEffect(() => { if (status === 'connected') engine.onConnected(); }, [status]);

  useEffect(() => {
    if (status !== 'ended') return;
    // Say why, but only when the user did not ask for it. endMessage returns
    // null for a hang-up either side made on purpose (2026-09-17).
    const snap = getSnapshot();
    const why = endMessage(snap.endReason, snap.error);
    if (why) Alert.alert('Call ended', why);
    // A call answered from a notification has no history to go back to.
    const t = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, 200);
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

  // BACK MINIMISES THE CALL, IT DOES NOT END IT.
  //
  // videocall.tsx and voicecall.tsx both do this; the group screen had no
  // hardwareBackPress listener at all, so Android back popped the route while
  // the engine kept the call running - and the screen is the only place the
  // group call can be ended from. The user was left in a call with no visible
  // way out but the CallBar, and no way back to the grid except re-joining.
  //
  // Same shape as the 1:1 screens: only a CONNECTED call minimises. On one
  // that is still connecting or already dead, back must genuinely leave, or a
  // swallowed gesture strands the user in a call they cannot end (2026-09-17).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (status !== 'connected') { engine.hangUp('local_hangup', true); return false; }
      engine.minimizeScreen();
      if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats');
      return true;
    });
    return () => sub.remove();
  }, [status, router]);

  const cols = shown.length + 1 <= 1 ? 1 : shown.length + 1 <= 4 ? 2 : 3;
  const tileW = `${100 / cols - 2}%` as const;

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
          <TouchableOpacity
            onPress={invite} activeOpacity={0.7} style={S.addPeoplePill}
            accessibilityRole="button" accessibilityLabel={`Add people, ${tiles} of ${CALL_MAX} seats used`}
          >
            <Ionicons name="person-add" size={13} color={CALL.text} />
            <Text style={S.addPeopleTxt}>Add · {tiles}/{CALL_MAX}</Text>
          </TouchableOpacity>
        )}
        {/* null = the V2 engine path has no signalling cipher of ours: SDP goes
            to LiveKit over TLS and frames are sealed before publish, fail-closed
            in lib/call/room.ts. See protectionFor's contract. */}
        <CallEncryptionBadge protection={protectionFor(tiles, null)} />
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
          <Ionicons name="phone-portrait" size={13} color={CALL.text} />
          <Text style={S.shareBannerTxt} numberOfLines={1}>
            {sharer.name} is sharing their screen
          </Text>
        </View>
      ) : null}

      {error ? <Text style={S.err}>{error}</Text> : null}

      <ScrollView contentContainerStyle={S.grid}>
        <View style={[S.tile, { width: tileW }]}>
          {isVideo && !camOff && localUrl
            ? <RTCView streamURL={localUrl} style={S.video} objectFit="cover" mirror />
            : <View style={S.audioTile}><Ionicons name="person" size={34} color={CALL.text} /></View>}
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Previous participants"
            accessibilityState={{ disabled: page === 0 }}
            style={S.pagerBtn} disabled={page === 0}
            onPress={() => setPage(p => Math.max(0, p - 1))}
          >
            <Ionicons name="chevron-back" size={20} color={page === 0 ? CALL.pagerOff : CALL.text} />
          </TouchableOpacity>
          <Text style={S.pagerLabel}>
            {page === 0 ? 'Speaking' : `Page ${page + 1} of ${pages}`}
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Next participants"
            accessibilityState={{ disabled: page >= pages - 1 }}
            style={S.pagerBtn} disabled={page >= pages - 1}
            onPress={() => setPage(p => Math.min(pages - 1, p + 1))}
          >
            <Ionicons name="chevron-forward" size={20} color={page >= pages - 1 ? CALL.pagerOff : CALL.text} />
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

      {/* bottom is MEASURED, not guessed (2026-09-17). It used to be a literal
          110, tuned for a single-row control bar. Once `controls` gained
          flexWrap the bar became one row on a tablet, two on a phone and three
          at 320dp — so any literal is wrong on some device, and 110 put the
          chat/reaction buttons on top of the first row of call controls, where
          they intercepted taps on mic and camera. Measuring covers every width
          without a breakpoint. */}
      {status === 'connected' && <CallExtras bottom={controlsH + 12} />}

      <View
        // Clears the gesture bar / home indicator; 36 stays the floor on
        // devices without one.
        style={[S.controls, { paddingBottom: Math.max(36, insets.bottom + 16) }]}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          if (h && h !== controlsH) setControlsH(h);
        }}
      >
        <CtrlBtn icon={muted ? 'mic-off' : 'mic'} active={muted} onPress={engine.toggleMute} colors={colors} label={muted ? 'Unmute' : 'Mute'} />
        {isVideo && <CtrlBtn icon={camOff ? 'videocam-off' : 'videocam'} active={camOff} onPress={engine.toggleCamera} colors={colors} label={camOff ? 'Turn camera on' : 'Turn camera off'} />}
        {isVideo && <CtrlBtn icon="camera-reverse" onPress={engine.flipCamera} colors={colors} label="Switch camera" />}
        <CtrlBtn icon={speaker ? 'volume-high' : 'volume-low'} active={speaker} onPress={engine.toggleSpeaker} colors={colors} label={speaker ? 'Turn speaker off' : 'Turn speaker on'} />
        <CtrlBtn icon="hand-left" active={handUp} onPress={toggleHand} colors={colors} label={handUp ? 'Lower hand' : 'Raise hand'} />
        {/* Hidden at capacity rather than disabled: a button that does nothing
            invites tapping it, and "the call is full" is the more useful thing
            for the count in the header to be saying at that moment. */}
        {seatsLeft > 0 && <CtrlBtn icon="person-add" onPress={invite} colors={colors} label="Invite someone" />}
        <CtrlBtn icon="call" danger onPress={endGroupCall} colors={colors} label="End call" />
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
  // OUTBOUND candidates gathered before this link's cipher exists. Distinct
  // from pendingIce above, which holds INBOUND ones until the peer
  // connection is ready. Gathering starts on setLocalDescription; the
  // per-peer cipher only exists after a key-bundle fetch, so host
  // candidates are always ready first. Dropping them is not fail-closed,
  // it is loss - they are never re-gathered and the sealed offer carries
  // none (trickle ICE). In a mesh this is per-uid: one slow peer must not
  // cost the others their candidates.
  const pendingOutIce = useRef<Record<string, any[]>>({});
  const cipherFor = (uid: string) => ciphersRef.current[uid] ?? plainCipher;
  // Flush this link's held candidates, sealed. Called wherever a cipher is
  // assigned - holding them and never flushing would just be a slower drop.
  const flushOutIce = (uid: string, chatId: string) => {
    const held = pendingOutIce.current[uid];
    if (!held?.length) return;
    delete pendingOutIce.current[uid];
    const c = ciphersRef.current[uid];
    if (!c?.enc) return;   // still unsealable - drop rather than leak
    getSocket().then(s => {
      for (const cand of held) {
        try { s.emit('webrtc_ice', { to: uid, chatId, candidate: c.seal(cand) }); } catch {}
      }
    }).catch(() => {});
  };

  const setPeerUrl = (uid: string, url: string | null, nm?: string) =>
    setPeers(prev => ({ ...prev, [uid]: { pc: pcsRef.current[uid], url, name: nm ?? prev[uid]?.name ?? '' } }));

  const closePeer = useCallback((uid: string) => {
    try { pcsRef.current[uid]?.close(); } catch {}
    delete pcsRef.current[uid];
    delete pendingIce.current[uid];
    delete pendingOutIce.current[uid];
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
      // FAIL CLOSED at the one place a candidate reaches the wire (mirrors
      // lib/vaultBeamDirect.ts's emitIce). `cipherFor` falls back to
      // plainCipher, whose seal() is a no-op — so without this the raw
      // candidate, and the device IP in it, goes to our own server whenever
      // this link has no cipher yet or never got one.
      const c = ciphersRef.current[uid];
      if (!e.candidate) return;
      // Not yet sealable for THIS link: hold, do not drop.
      if (!c?.enc) { (pendingOutIce.current[uid] ||= []).push(e.candidate); return; }
      getSocket().then(s => s.emit('webrtc_ice', { to: uid, chatId, candidate: c.seal(e.candidate) })).catch(() => {});
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
        // FAIL CLOSED. This used to be `sealed ? sealed.offerWire :
        // pc.localDescription` — a raw SDP on our own socket. A mesh call is N
        // pairwise links; each one stands or falls on its own seal, so one
        // peer we cannot key costs that LINK, not the call.
        if (!sealed) {
          throw new Error("Couldn't add someone to this call securely — we don't have their encryption keys. Ask them to open crazzychat once (or update it) and rejoin.");
        }
        ciphersRef.current[uid] = sealed.cipher;
        flushOutIce(uid, chatId);
        s.emit('webrtc_offer', { to: uid, chatId, sdp: sealed.offerWire });
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
            if (!offer?.type) { setError('Secure group-call setup failed — ask them to rejoin the call'); return; }
            // FAIL CLOSED, the answering half. An UNSEALED offer is
            // indistinguishable from one our own server wrote, and answering it
            // would put our DTLS-SRTP fingerprint and candidates in the clear
            // too. Only this LINK is dropped — the rest of the mesh is fine.
            if (!cipher.enc) {
              setError("Someone joined on an old version of crazzychat and couldn't be connected securely — ask them to update.");
              return;
            }
            // Stored only once it is PROVEN sealed: the badge and the ICE
            // emitter both read this map, and a passthrough parked in it is a
            // false claim plus an open candidate tap.
            ciphersRef.current[from] = cipher;
            flushOutIce(from, chatId);
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
        {/* The LIVE per-link ciphers, not a build flag. Keyed off `peers` so a
            link is unsealed-until-proven: a peer present with no cipher yet
            reads as 'transport' and only flips once its seal exists. Every
            cipher write in ensurePeer/closePeer is paired with a setPeers, so
            the ref is never staler than this render. */}
        <CallEncryptionBadge
          protection={protectionFor(tiles, Object.keys(peers).map(uid => ciphersRef.current[uid]))}
        />
      </View>

      {error ? <Text style={S.err}>{error}</Text> : null}

      <ScrollView contentContainerStyle={S.grid}>
        {/* Local tile */}
        <View style={[S.tile, { width: `${100 / cols - 2}%` }]}>
          {isVideo && !camOff && localUrl
            ? <RTCView streamURL={localUrl} style={S.video} objectFit="cover" mirror />
            : <View style={S.audioTile}><Ionicons name="person" size={34} color={CALL.text} /></View>}
          <Text style={S.tileName}>You{muted ? ' 🔇' : ''}</Text>
        </View>
        {/* Remote tiles */}
        {remoteList.map(([uid, p]) => (
          <View key={uid} style={[S.tile, { width: `${100 / cols - 2}%` }]}>
            {isVideo && p.url
              ? <RTCView streamURL={p.url} style={S.video} objectFit="cover" />
              : <View style={S.audioTile}>{p.url ? <RTCView streamURL={p.url} style={{ width: 1, height: 1 }} /> : null}<Ionicons name="person" size={34} color={CALL.text} /></View>}
            <Text style={S.tileName} numberOfLines={1}>{p.url ? (p.name || 'Connected') : 'Connecting…'}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={S.controls}>
        <CtrlBtn icon={muted ? 'mic-off' : 'mic'} active={muted} onPress={toggleMute} colors={colors} label={muted ? 'Unmute' : 'Mute'} />
        {isVideo && <CtrlBtn icon={camOff ? 'videocam-off' : 'videocam'} active={camOff} onPress={toggleCam} colors={colors} label={camOff ? 'Turn camera on' : 'Turn camera off'} />}
        <CtrlBtn icon="call" danger onPress={hangUp} colors={colors} label="End call" />
      </View>
    </View>
  );
}

// Every control here is icon-only, so without a label a screen reader
// announces seven identical "button"s - including the one that ENDS THE CALL.
// A blind user could join a group call and have no way to leave it.
//
// The label states the ACTION the tap performs, not the icon drawn: a muted
// mic shows mic-off and the useful thing to say is "Unmute". accessibilityState
// carries the toggle position alongside it, so the current state is available
// without being guessed from the verb (2026-09-17).
function CtrlBtn({ icon, onPress, active, danger, colors, label }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
  colors: Palette;
  label?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // Only toggles carry a state; End and Switch camera are plain actions.
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={[CTRL_BTN.btn, { backgroundColor: danger ? colors.danger : active ? colors.primary : CALL.ctrl }]}>
      <Ionicons name={icon} size={26} color={CALL.text} />
    </TouchableOpacity>
  );
}

const CTRL_BTN = StyleSheet.create({
  btn: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
});

// Call chrome is always dark whatever the app theme (video surfaces sit on it),
// so the greys and whites here are deliberate; only the accent follows the theme.
const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: CALL.bg },
  topBar:    { paddingTop: HEADER_TOP, paddingHorizontal: 20, paddingBottom: 8, alignItems: 'center' },
  title:     { color: CALL.text, fontSize: 18, fontWeight: '800' },
  sub:       { color: CALL.textMuted, fontSize: 13, marginTop: 2 },
  err:       { color: CALL.errorText, textAlign: 'center', fontSize: 13, paddingHorizontal: 20 },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 6, paddingTop: 8 },
  tile:      { aspectRatio: 0.8, marginHorizontal: '1%', marginBottom: 10, borderRadius: 14, overflow: 'hidden', backgroundColor: CALL.tile, justifyContent: 'flex-end' },
  video:     { ...StyleSheet.absoluteFillObject, backgroundColor: CALL.video },
  audioTile: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  tileName:  { color: CALL.text, fontSize: 12, fontWeight: '600', padding: 6, backgroundColor: CALL.nameScrim },
  handBadge: { position: 'absolute', top: 6, left: 6, width: 26, height: 26, borderRadius: 13,
               alignItems: 'center', justifyContent: 'center', backgroundColor: CALL.badgeScrim },
  handBadgeTxt: { fontSize: 14 },
  roleBadge: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11,
               alignItems: 'center', justifyContent: 'center', backgroundColor: CALL.badgeScrim },
  handQueue: { color: CALL.handQueue, fontSize: 12, textAlign: 'center', paddingBottom: 6 },
  shareBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center',
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
    backgroundColor: CALL.shareTint,
  },
  shareBannerTxt: { color: CALL.text, fontSize: 12, fontWeight: '700', maxWidth: 260 },
  addPeoplePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center',
    marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14,
    backgroundColor: CALL.pill,
  },
  addPeopleTxt: { color: CALL.text, fontSize: 12, fontWeight: '600' },
  pager:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, paddingBottom: 4 },
  pagerBtn:   { padding: 8 },
  pagerLabel: { color: CALL.pagerDim, fontSize: 12, minWidth: 110, textAlign: 'center' },
  // flexWrap added 2026-09-17. CtrlBtn pins width:60 in its own body (see the
  // component above), so the call sites carry no width and no width-grep ever
  // found this: 7 controls x 60 + 6 x 22 gap = 552dp against 369dp on an Honor.
  // justifyContent:'center' meant it overflowed BOTH ends symmetrically, so the
  // first and last buttons — Mute and End call — were the two off-screen. A
  // video group call with a free seat renders all 7, and SFU_MAX is 64
  // (lib/call/mode.ts), so that is the normal case, not an edge case.
  // Wrapping is enough: the sibling above is a ScrollView (flexGrow/flexShrink 1),
  // so it yields the 82dp a second line needs and the grid just scrolls.
  controls:  { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 22, paddingVertical: 24, paddingBottom: 36 },
});
