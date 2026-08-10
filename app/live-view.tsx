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
import { useColors } from '../lib/theme';
import { AppText } from '../components/ui/Text';
import { SPACING, RADIUS } from '../constants/theme';
import {
  endBroadcast, getBroadcast, waitForPlaylist, watchBroadcast, unwatchBroadcast,
  listBroadcastChat, sendBroadcastChat,
  type Broadcast, type BroadcastMessage,
} from '../lib/broadcast';
import { getBroadcastToken } from '../lib/call/sfuToken';
// sfuRoom pulls in livekit-client, a browser library that needs polyfills
// installed at import time. Loading it LAZILY means a failure there degrades to
// "could not publish" instead of a white screen: a viewer can still watch the
// HLS stream even if publishing is broken, and that is worth preserving.
type SfuSession = Awaited<ReturnType<typeof import('../lib/call/sfuRoom').joinSfuRoom>>;

export default function LiveViewScreen() {
  const { id, host } = useLocalSearchParams<{ id: string; host?: string }>();
  const isHost = host === '1';
  const colors = useColors();
  const router = useRouter();
  const video = useRef<Video>(null);

  const [b, setB] = useState<Broadcast | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);

  // The HOST publishes into the LiveKit room; egress transcodes that room to
  // HLS. Without this nothing reaches the SFU and egress renders an empty
  // stream — the gap that made "Go Live" wait forever.
  //
  // e2eeKey is null ON PURPOSE: a transcoder cannot read encrypted frames, so a
  // broadcast is not end-to-end encrypted. That is recorded server-side
  // (migration 079, e2ee=false) and shown to the user before they publish.
  useEffect(() => {
    if (!isHost) return;
    let session: SfuSession | null = null;
    let cancelled = false;
    (async () => {
      try {
        const cred = await getBroadcastToken(String(id));
        if (cancelled) return;
        const { joinSfuRoom } = await import('../lib/call/sfuRoom');
        session = await joinSfuRoom({
          url: cred.url,
          token: cred.token,
          identity: cred.identity,
          publish: true,
          video: true,
          e2eeKey: null,
        });
        if (cancelled) await session.leave();
      } catch (e: any) {
        if (!cancelled) {
          console.warn('[broadcast] could not publish —', e?.message ?? e);
          setFailed(true);
          setWaiting(false);
        }
      }
    })();
    return () => { cancelled = true; void session?.leave(); };
  }, [id, isHost]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await getBroadcast(String(id));
        if (cancelled) return;
        setB(initial);
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
  }, [id]);

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
    const tick = async () => {
      if (!alive) return;
      // The heartbeat is what keeps us in the viewer set; it expires server-side
      // so a viewer who vanishes stops being counted.
      setViewers(await watchBroadcast(String(id)));
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

  const stop = useCallback(async () => {
    await endBroadcast(String(id), b?.viewerCount ?? 0, b?.peakViewers ?? 0);
    router.back();
  }, [id, b, router]);

  const confirmStop = () => Alert.alert(
    'End broadcast?',
    'Viewers will be disconnected.',
    [{ text: 'Keep going', style: 'cancel' }, { text: 'End', style: 'destructive', onPress: stop }],
  );

  return (
    <View style={S.root}>
      <Stack.Screen options={{ title: b?.title || 'Live', headerTransparent: true, headerTintColor: '#fff' }} />

      {waiting ? (
        <View style={S.center}>
          <ActivityIndicator color="#fff" />
          <AppText style={S.centerText}>
            {isHost ? 'Starting your broadcast…' : 'Waiting for the stream…'}
          </AppText>
        </View>
      ) : failed || !b?.hlsUrl ? (
        <View style={S.center}>
          <Ionicons name="cloud-offline-outline" size={40} color="#94A3B8" />
          <AppText style={S.centerText}>
            {isHost
              ? 'The broadcast could not start. Nothing was published.'
              : 'This stream is not available.'}
          </AppText>
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

      {/* Chat overlays the video rather than splitting the screen — a phone in
          portrait has no room for both, and viewers came for the stream. */}
      {!waiting && !failed && (
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

      {isHost && !waiting && (
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
