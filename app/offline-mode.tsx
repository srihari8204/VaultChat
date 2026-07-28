// app/offline-mode.tsx — Offline Mode Manager
// Connection status, message queue, sync progress, cache management

import React, { useState, useEffect, useRef , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  StatusBar, Platform, Alert, ActivityIndicator, Animated,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;


const QUEUE_KEY = 'vc_offline_queue';

type QueuedMessage = {
  id: string;
  chatName: string;
  preview: string;
  timestamp: string;
  status: 'pending' | 'sending' | 'failed';
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function OfflineModeScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [isOnline, setIsOnline] = useState(true);
  const [connectionType, setConnectionType] = useState('wifi');
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const syncAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Monitor connection
    const unsub = NetInfo.addEventListener(state => {
      setIsOnline(!!state.isConnected);
      setConnectionType(state.type || 'unknown');

      // Auto-sync when coming back online
      if (state.isConnected && queue.length > 0) {
        // Don't auto-trigger, just update status
      }
    });

    loadQueueAndCache();
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    ).start();

    return () => unsub();
  }, [queue.length, pulseAnim]);

  const loadQueueAndCache = async () => {
    try {
      // Load queued messages
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      if (raw) {
        setQueue(JSON.parse(raw));
      } else {
        // Seed demo queue for display
        const demo: QueuedMessage[] = [
          { id: '1', chatName: 'Alice Chen', preview: 'Hey, are you free tonight?', timestamp: new Date(Date.now() - 120000).toISOString(), status: 'pending' },
          { id: '2', chatName: 'Dev Team', preview: 'Updated the PR, ready for review', timestamp: new Date(Date.now() - 300000).toISOString(), status: 'pending' },
          { id: '3', chatName: 'Bob Martinez', preview: 'Thanks for the docs!', timestamp: new Date(Date.now() - 600000).toISOString(), status: 'failed' },
        ];
        setQueue(demo);
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(demo));
      }

      // Calculate cache size
      const keys = await AsyncStorage.getAllKeys();
      const pairs = await AsyncStorage.multiGet(keys);
      let total = 0;
      for (const [k, v] of pairs) {
        total += (k?.length ?? 0) + (v?.length ?? 0);
      }
      setCacheSize(total + 5_200_000); // Add simulated cached media

      // Last sync
      const ls = await AsyncStorage.getItem('vc_last_sync');
      setLastSync(ls || new Date(Date.now() - 3600000).toISOString());
    } catch {}
  };

  const retryAll = async () => {
    if (!isOnline) {
      Alert.alert('Offline', 'You need an internet connection to send messages.');
      return;
    }
    if (queue.length === 0) return;

    setRetrying(true);
    setSyncing(true);
    setSyncProgress(0);
    syncAnim.setValue(0);

    const total = queue.length;
    const updated = [...queue];

    for (let i = 0; i < total; i++) {
      updated[i] = { ...updated[i], status: 'sending' };
      setQueue([...updated]);

      // Simulate network send
      await new Promise(r => setTimeout(r, 800));

      const p = (i + 1) / total;
      setSyncProgress(p);
      Animated.timing(syncAnim, { toValue: p, duration: 200, useNativeDriver: false }).start();
    }

    // All sent
    setQueue([]);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([]));
    const now = new Date().toISOString();
    setLastSync(now);
    await AsyncStorage.setItem('vc_last_sync', now);

    setSyncing(false);
    setRetrying(false);
    Alert.alert('Synced', `${total} messages sent successfully.`);
  };

  const clearCache = () => {
    Alert.alert('Clear Cache', 'Remove cached messages and media?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive', onPress: async () => {
          const keys = await AsyncStorage.getAllKeys();
          const cacheKeys = keys.filter(k => k.includes('cache') || k.includes('temp'));
          if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);
          setCacheSize(0);
          Alert.alert('Done', 'Cache cleared.');
        },
      },
    ]);
  };

  const syncProgressWidth = syncAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  const pendingCount = queue.filter(m => m.status === 'pending').length;
  const failedCount = queue.filter(m => m.status === 'failed').length;

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      <LinearGradient colors={['#F9FAFB', colors.bg]} style={s.header}>
        <View style={[s.headerRow, { marginTop: TOP }]}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={16}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Offline Mode</Text>
          <View style={{ width: 24 }} />
        </View>
      </LinearGradient>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── Connection Status ───────────────────────── */}
        <LinearGradient
          colors={isOnline ? ['#0A2E1A', '#F9FAFB'] : ['#2E0A0A', '#F9FAFB']}
          style={s.card}
        >
          <View style={s.statusRow}>
            <Animated.View style={[
              s.statusDot,
              { backgroundColor: isOnline ? colors.primary : colors.danger, opacity: pulseAnim },
            ]} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[s.statusTitle, { color: isOnline ? colors.primary : colors.danger }]}>
                {isOnline ? 'Online' : 'Offline'}
              </Text>
              <Text style={s.statusSub}>
                {isOnline
                  ? `Connected via ${connectionType.toUpperCase()}`
                  : 'No internet connection'}
              </Text>
            </View>
            <Ionicons
              name={isOnline ? 'wifi' : 'wifi-outline'}
              size={28}
              color={isOnline ? colors.primary : colors.danger}
            />
          </View>
        </LinearGradient>

        {/* ── Message Queue ──────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="mail-outline" size={20} color={colors.accent} />
            <Text style={s.cardTitle}>Message Queue</Text>
            <View style={s.badge}>
              <Text style={s.badgeText}>{queue.length}</Text>
            </View>
          </View>

          {pendingCount > 0 && (
            <View style={s.queueSummary}>
              <Text style={s.queueText}>{pendingCount} pending</Text>
              {failedCount > 0 && <Text style={[s.queueText, { color: colors.danger }]}>{failedCount} failed</Text>}
            </View>
          )}

          {queue.length === 0 ? (
            <View style={s.emptyQueue}>
              <Ionicons name="checkmark-circle-outline" size={32} color={colors.primary} />
              <Text style={s.emptyText}>All messages sent</Text>
            </View>
          ) : (
            queue.map((msg, i) => (
              <View key={msg.id} style={s.msgRow}>
                <View style={[
                  s.msgStatusDot,
                  {
                    backgroundColor:
                      msg.status === 'pending' ? '#FF9F43'
                      : msg.status === 'sending' ? colors.accent
                      : colors.danger,
                  },
                ]} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.msgChat}>{msg.chatName}</Text>
                  <Text style={s.msgPreview} numberOfLines={1}>{msg.preview}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.msgTime}>{timeAgo(msg.timestamp)}</Text>
                  <Text style={[s.msgStatus, {
                    color: msg.status === 'failed' ? colors.danger : colors.textDim,
                  }]}>
                    {msg.status === 'sending' ? 'Sending...' : msg.status}
                  </Text>
                </View>
              </View>
            ))
          )}

          {/* Auto-retry status */}
          <View style={s.autoRetryRow}>
            <Ionicons name="refresh-outline" size={16} color={colors.textDim} />
            <Text style={s.autoRetryText}>Auto-retry: {isOnline ? 'Active' : 'Waiting for connection'}</Text>
          </View>
        </LinearGradient>

        {/* ── Retry All Button ───────────────────────── */}
        {queue.length > 0 && (
          <TouchableOpacity
            style={[s.retryBtn, !isOnline && s.retryBtnDisabled]}
            onPress={retryAll}
            disabled={retrying || !isOnline}
            activeOpacity={0.7}
          >
            {retrying ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <>
                <Ionicons name="refresh" size={20} color={colors.text} />
                <Text style={s.retryBtnText}>Retry All ({queue.length})</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {/* ── Sync Progress ──────────────────────────── */}
        {syncing && (
          <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
            <Text style={s.cardTitlePlain}>Syncing Data...</Text>
            <View style={s.syncBarBg}>
              <Animated.View style={[s.syncBarFill, { width: syncProgressWidth }]} />
            </View>
            <Text style={s.syncPct}>{Math.round(syncProgress * 100)}%</Text>
          </LinearGradient>
        )}

        {/* ── Last Sync ──────────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="sync-outline" size={20} color={colors.accent} />
            <Text style={s.cardTitle}>Last Sync</Text>
          </View>
          <Text style={s.lastSyncText}>
            {lastSync ? timeAgo(lastSync) : 'Never synced'}
          </Text>
          {lastSync && (
            <Text style={s.lastSyncDate}>
              {new Date(lastSync).toLocaleString()}
            </Text>
          )}
        </LinearGradient>

        {/* ── Offline Features Available ──────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="apps-outline" size={20} color={colors.accent} />
            <Text style={s.cardTitle}>Available Offline</Text>
          </View>

          {[
            { icon: 'chatbubbles-outline', label: 'Read cached messages', available: true },
            { icon: 'create-outline', label: 'Compose new messages', available: true },
            { icon: 'images-outline', label: 'View saved media', available: true },
            { icon: 'search-outline', label: 'Search message history', available: true },
            { icon: 'call-outline', label: 'Voice / Video calls', available: false },
            { icon: 'cloud-upload-outline', label: 'Send media', available: false },
          ].map((feat, i) => (
            <View key={i} style={s.featureRow}>
              <Ionicons name={feat.icon as any} size={18} color={feat.available ? colors.primary : colors.danger} />
              <Text style={[s.featureLabel, { color: feat.available ? colors.text : colors.textDim }]}>
                {feat.label}
              </Text>
              <Ionicons
                name={feat.available ? 'checkmark-circle' : 'close-circle'}
                size={18}
                color={feat.available ? colors.primary : colors.danger}
              />
            </View>
          ))}
        </LinearGradient>

        {/* ── Cache Management ────────────────────────── */}
        <LinearGradient colors={['#0F2847', '#F9FAFB']} style={s.card}>
          <View style={s.sectionHeader}>
            <Ionicons name="folder-outline" size={20} color={'#FF9F43'} />
            <Text style={s.cardTitle}>Cache</Text>
          </View>

          <View style={s.cacheRow}>
            <Text style={s.cacheLabel}>Cache Size</Text>
            <Text style={s.cacheValue}>{formatBytes(cacheSize)}</Text>
          </View>

          <TouchableOpacity style={s.clearCacheBtn} onPress={clearCache} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={18} color={colors.danger} />
            <Text style={s.clearCacheText}>Clear Cache</Text>
          </TouchableOpacity>
        </LinearGradient>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { paddingBottom: 16, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: c.text, fontSize: 20, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  card: { borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#112240' },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  cardTitlePlain: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 12 },

  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 16, height: 16, borderRadius: 8 },
  statusTitle: { fontSize: 20, fontWeight: '800' },
  statusSub: { color: c.textDim, fontSize: 13, marginTop: 2 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  badge: { backgroundColor: c.accent, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 8 },
  badgeText: { color: c.text, fontSize: 12, fontWeight: '700' },

  queueSummary: { flexDirection: 'row', gap: 14, marginBottom: 12 },
  queueText: { color: '#FF9F43', fontSize: 13, fontWeight: '600' },

  emptyQueue: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  emptyText: { color: c.primary, fontSize: 14 },

  msgRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#112240' },
  msgStatusDot: { width: 10, height: 10, borderRadius: 5 },
  msgChat: { color: c.text, fontSize: 14, fontWeight: '600' },
  msgPreview: { color: c.textDim, fontSize: 13, marginTop: 2 },
  msgTime: { color: c.textDim, fontSize: 11 },
  msgStatus: { fontSize: 11, marginTop: 2, textTransform: 'capitalize' },

  autoRetryRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#112240', gap: 8 },
  autoRetryText: { color: c.textDim, fontSize: 12 },

  retryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, marginBottom: 16, gap: 8,
  },
  retryBtnDisabled: { opacity: 0.4 },
  retryBtnText: { color: c.text, fontSize: 16, fontWeight: '700' },

  syncBarBg: { height: 8, borderRadius: 4, backgroundColor: '#1A2A44', overflow: 'hidden', marginBottom: 8 },
  syncBarFill: { height: 8, borderRadius: 4, backgroundColor: c.accent },
  syncPct: { color: c.accent, fontSize: 14, fontWeight: '700', textAlign: 'center' },

  lastSyncText: { color: c.accent, fontSize: 18, fontWeight: '700', marginTop: 4 },
  lastSyncDate: { color: c.textDim, fontSize: 13, marginTop: 4 },

  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#112240' },
  featureLabel: { flex: 1, fontSize: 14, marginLeft: 10 },

  cacheRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  cacheLabel: { color: c.text, fontSize: 14 },
  cacheValue: { color: '#FF9F43', fontSize: 16, fontWeight: '700' },

  clearCacheBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: c.danger + '50', marginTop: 10, gap: 8 },
  clearCacheText: { color: c.danger, fontSize: 14, fontWeight: '600' },
});
