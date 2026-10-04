// app/offline-mode.tsx — Offline mode: connection status and the real outbox.
//
// Everything on this screen is read from the app's own state:
//   • connection — NetInfo, live.
//   • outbox     — the localDb 'msg' queue that lib/messageQueue sends from
//                  (text, reactions, edits and deletes made while offline).
//   • retry      — messageQueue.retry() for rejected rows, flush() for the rest.
//
// It used to seed a demo queue ("Alice Chen…") into storage, add a made-up
// 5.2 MB to the cache size, fake progress with an 800 ms sleep per item and
// then announce "N messages sent successfully" without sending anything. It
// also cleared every storage key containing "cache" or "temp", which took the
// local-first caches with it. Cache clean-up now goes to /cache-cleanup, which
// plans what it deletes.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';
import { getCachedChat, queueCount, queueList } from '../lib/localDb';
import { flush, on, retry } from '../lib/messageQueue';
import { describeRetry, summarizeOutbox, unreadableRows, type OutboxRow, type OutboxSummary } from '../lib/outboxSummary';

// Keys written only by the old mock version of this screen (a seeded demo
// queue and a fake "last sync"). Removed by exact name, nothing else.
const LEGACY_MOCK_KEYS = ['vc_offline_queue', 'vc_last_sync'];
// One page is plenty for a count; the queue itself drains in pages of 200.
const OUTBOX_READ_LIMIT = 1000;
// Label colour on the solid primary button. The palette has no on-primary
// token; white is the brand's button text in both themes.
const ON_PRIMARY = '#FFFFFF';

type Outbox = OutboxSummary & { unreadable: number; chatNames: Record<string, string> };

/** Name of a chat from the local cache, for the failed-message links. */
async function chatName(id: string): Promise<string> {
  const c = await getCachedChat(id).catch(() => null);
  return (c?.type === 'direct' ? c?.peerName : c?.name) || c?.name || c?.peerName || 'Chat';
}

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

const OFFLINE_FACTS: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; works: boolean }[] = [
  { icon: 'chatbubbles-outline', label: 'Read messages already on this phone', works: true },
  { icon: 'create-outline', label: 'Write text messages, reactions, edits and deletes — they wait in the outbox', works: true },
  { icon: 'cloud-upload-outline', label: 'Send photos, files and voice notes (they upload only while online)', works: false },
  { icon: 'call-outline', label: 'Voice and video calls', works: false },
];

export default function OfflineModeScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [connectionType, setConnectionType] = useState('unknown');
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<string | null>(null);
  // Queue events can land after the screen is gone; no state updates then.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadOutbox = useCallback(async (): Promise<Outbox | null> => {
    try {
      const [rows, stored] = await Promise.all([
        queueList<OutboxRow>('msg', OUTBOX_READ_LIMIT), queueCount('msg').catch(() => 0),
      ]);
      const sum = summarizeOutbox(rows);
      const names = await Promise.all(sum.failedChatIds.map(chatName));
      const next: Outbox = {
        ...sum,
        unreadable: unreadableRows(stored, rows.length, OUTBOX_READ_LIMIT),
        chatNames: Object.fromEntries(sum.failedChatIds.map((id, i) => [id, names[i]])),
      };
      if (!mounted.current) return null;
      setOutbox(next);
      setLoadError(null);
      return next;
    } catch (e: any) {
      if (mounted.current) setLoadError(e?.message ?? 'Could not read the outbox');
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) loadOutbox(); };
    const unsubNet = NetInfo.addEventListener(state => {
      if (!alive) return;
      setIsOnline(!!state.isConnected);
      setConnectionType(state.type || 'unknown');
    });
    // The queue says when a row is added, sent, retried or rejected; recount then.
    const offs = [on('pending', refresh), on('sent', refresh), on('failed', refresh), on('retry', refresh)];
    refresh();
    AsyncStorage.multiRemove(LEGACY_MOCK_KEYS).catch(() => {});
    return () => { alive = false; unsubNet(); offs.forEach(off => off()); };
  }, [loadOutbox]);

  const unsent = outbox ? outbox.waiting + outbox.failed : 0;

  const retryNow = useCallback(async () => {
    if (retrying || !outbox) return;
    if (!isOnline) {
      Alert.alert('Offline', 'Messages are sent automatically when the connection comes back.');
      return;
    }
    setRetrying(true);
    setRetryResult(null);
    const before = outbox;
    try {
      // retry() moves a rejected row back to the queue and starts a flush;
      // flush() sends whatever was already waiting.
      for (const id of outbox.failedIds) await retry(id);
      await flush();
    } catch (e: any) {
      Alert.alert('Could not retry', e?.message ?? 'Try again');
    } finally {
      // Say what happened, from the recount — never assume success.
      const after = await loadOutbox();
      if (mounted.current) {
        setRetrying(false);
        if (after) setRetryResult(describeRetry(before, after));
      }
    }
  }, [retrying, outbox, isOnline, loadOutbox]);

  const statusColor = isOnline === false ? colors.danger : colors.primary;

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[s.headerRow, { marginTop: HEADER_TOP }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={16} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Offline mode</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Connection ───────────────────────────── */}
        <View style={s.card} accessible accessibilityLabel={
          isOnline === null ? 'Checking connection' : isOnline ? `Online, connected via ${connectionType}` : 'Offline, no internet connection'}>
          <View style={s.statusRow}>
            <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[s.statusTitle, { color: statusColor }]}>
                {isOnline === null ? 'Checking…' : isOnline ? 'Online' : 'Offline'}
              </Text>
              <Text style={s.dim}>
                {isOnline === null ? ' ' : isOnline ? `Connected via ${connectionType}` : 'No internet connection'}
              </Text>
            </View>
            <Ionicons name={isOnline === false ? 'cloud-offline-outline' : 'wifi'} size={26} color={statusColor} />
          </View>
        </View>

        {/* ── Outbox ───────────────────────────────── */}
        <View style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="paper-plane-outline" size={20} color={colors.textDim} />
            <Text style={s.cardTitle} accessibilityRole="header">Outbox</Text>
          </View>

          {loadError ? (
            <View accessibilityRole="alert">
              <Text style={s.dim}>Could not read the outbox. {loadError}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try reading the outbox again" onPress={() => { void loadOutbox(); }} style={s.outlineBtn} activeOpacity={0.7}>
                <Text style={s.outlineBtnTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : !outbox ? (
            <ActivityIndicator color={colors.primary} />
          ) : unsent === 0 ? (
            <View style={s.emptyRow}>
              <Ionicons name="checkmark-circle-outline" size={22} color={colors.primary} />
              <Text style={s.body}>{outbox.unreadable > 0 ? 'Nothing else waiting that could be read.' : 'Nothing waiting to send.'}</Text>
            </View>
          ) : (
            <>
              {outbox.waiting > 0 && (
                <Text style={s.body}>
                  {outbox.waiting} waiting to send{outbox.chats > 1 ? ` across ${outbox.chats} chats` : ''}. They go out on their own when the connection returns.
                </Text>
              )}
              {outbox.failed > 0 && (
                <Text style={[s.body, { color: colors.danger, marginTop: 6 }]}>
                  {outbox.failed} not sent — the server refused {outbox.failed === 1 ? 'it' : 'them'}. Each one is marked in its chat.
                </Text>
              )}
              {outbox.failedChatIds.map(id => (
                <TouchableOpacity
                  key={id}
                  style={s.chatLink}
                  onPress={() => router.push({ pathname: '/chat', params: { id } })}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${outbox.chatNames[id] ?? 'chat'}, has a message that was not sent`}
                >
                  <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
                  <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{outbox.chatNames[id] ?? 'Chat'}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </TouchableOpacity>
              ))}
              {outbox.oldestAt != null && <Text style={[s.dim, { marginTop: 6 }]}>Oldest from {timeAgo(outbox.oldestAt)}</Text>}

              <TouchableOpacity
                style={[s.primaryBtn, (!isOnline || retrying) && { opacity: 0.5 }]}
                onPress={retryNow}
                disabled={retrying || !isOnline}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={outbox.failed > 0 ? `Retry ${unsent} unsent messages` : `Send ${unsent} waiting messages now`}
                accessibilityState={{ disabled: retrying || !isOnline, busy: retrying }}
              >
                {retrying ? <ActivityIndicator color={ON_PRIMARY} /> : (
                  <Text style={s.primaryBtnTxt}>{outbox.failed > 0 ? 'Retry now' : 'Send now'}</Text>
                )}
              </TouchableOpacity>
              {!isOnline && <Text style={[s.dim, { marginTop: 8 }]}>Connect to the internet to send.</Text>}
            </>
          )}
          {!loadError && retryResult && (
            <Text style={[s.dim, { marginTop: 8 }]} accessibilityLiveRegion="polite">{retryResult}</Text>
          )}
          {!loadError && outbox && outbox.unreadable > 0 && (
            <Text style={[s.dim, { marginTop: 8 }]}>
              {outbox.unreadable} more queued {outbox.unreadable === 1 ? 'item' : 'items'} could not be read (the local store may be locked), so {outbox.unreadable === 1 ? 'it is' : 'they are'} not counted here.
            </Text>
          )}
        </View>

        {/* ── What works offline ───────────────────── */}
        <View style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="apps-outline" size={20} color={colors.textDim} />
            <Text style={s.cardTitle} accessibilityRole="header">Without a connection</Text>
          </View>
          {OFFLINE_FACTS.map(f => (
            <View key={f.label} style={s.featureRow} accessible accessibilityLabel={`${f.label}: ${f.works ? 'works offline' : 'needs a connection'}`}>
              <Ionicons name={f.icon} size={18} color={colors.textDim} />
              <Text style={s.featureLabel}>{f.label}</Text>
              <Ionicons name={f.works ? 'checkmark-circle' : 'close-circle'} size={18} color={f.works ? colors.primary : colors.danger} />
            </View>
          ))}
        </View>

        {/* ── Storage ──────────────────────────────── */}
        <TouchableOpacity
          style={[s.card, s.linkRow]}
          onPress={() => router.push('/cache-cleanup')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Cache cleanup. See what is cached on this phone and free up space"
        >
          <Ionicons name="folder-outline" size={20} color={colors.textDim} />
          <View style={{ flex: 1 }}>
            <Text style={s.linkTitle}>Cache cleanup</Text>
            <Text style={s.dim}>See what is cached on this phone and free up space</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 12 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: c.text, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 48 },

  card: { borderRadius: 16, padding: 18, marginBottom: 14, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  body: { color: c.text, fontSize: 14, lineHeight: 20 },
  dim: { color: c.textDim, fontSize: 13, lineHeight: 18 },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 14, height: 14, borderRadius: 7 },
  statusTitle: { fontSize: 20, fontWeight: '800' },

  emptyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  primaryBtn: { marginTop: 14, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  primaryBtnTxt: { color: ON_PRIMARY, fontSize: 16, fontWeight: '700' },
  chatLink: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 6 },
  outlineBtn: { marginTop: 10, alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  outlineBtnTxt: { color: c.primary, fontWeight: '700' },

  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  featureLabel: { flex: 1, color: c.text, fontSize: 14, lineHeight: 19 },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  linkTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
});
