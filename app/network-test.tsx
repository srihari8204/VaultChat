// @ts-nocheck
// app/network-test.tsx — Built-in Network Speed Test
// Download/upload speed, ping/latency, jitter, animated gauge
// Connection type from NetInfo, history in AsyncStorage

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Platform, Dimensions, Animated, Easing,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SW } = Dimensions.get('window');
const C = { bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF', card: '#0A1628', danger: '#FF3C6E', green: '#10B981', text: '#FFFFFF', muted: '#8A9BBF', yellow: '#FBBF24' };

const STORAGE_KEY = 'vaultchat_speedtest_history';
const GAUGE_SIZE = 220;
const GAUGE_STROKE = 12;
const TEST_FILE_URL = 'https://speed.cloudflare.com/__down?bytes=5000000'; // 5MB
const UPLOAD_URL = 'https://speed.cloudflare.com/__up';

type TestResult = {
  id: string;
  download: number;
  upload: number;
  ping: number;
  jitter: number;
  connectionType: string;
  timestamp: number;
};

type TestPhase = 'idle' | 'ping' | 'download' | 'upload' | 'done';

export default function NetworkTestScreen() {
  const router = useRouter();
  const needleAnim = useRef(new Animated.Value(0)).current;

  // State
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [download, setDownload] = useState(0);
  const [upload, setUpload] = useState(0);
  const [ping, setPing] = useState(0);
  const [jitter, setJitter] = useState(0);
  const [connectionType, setConnectionType] = useState('Unknown');
  const [connectionDetails, setConnectionDetails] = useState('');
  const [history, setHistory] = useState<TestResult[]>([]);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  useEffect(() => {
    loadHistory();
    checkConnection();
    checkServerStatus();
  }, []);

  useEffect(() => {
    // Animate needle based on current speed
    const speed = phase === 'download' ? download : phase === 'upload' ? upload : 0;
    const maxSpeed = 200; // 200 Mbps max gauge
    const ratio = Math.min(speed / maxSpeed, 1);
    Animated.timing(needleAnim, {
      toValue: ratio,
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [download, upload, phase]);

  const checkConnection = async () => {
    const state = await NetInfo.fetch();
    setConnectionType(state.type || 'Unknown');
    if (state.type === 'wifi') {
      setConnectionDetails('WiFi');
    } else if (state.type === 'cellular') {
      const gen = (state as any).details?.cellularGeneration || '';
      setConnectionDetails(gen ? gen.toUpperCase() : 'Cellular');
    } else {
      setConnectionDetails(state.type || 'Unknown');
    }
  };

  const checkServerStatus = async () => {
    try {
      const start = Date.now();
      await fetch('https://speed.cloudflare.com/__down?bytes=1', { method: 'HEAD' });
      const elapsed = Date.now() - start;
      setServerOnline(elapsed < 5000);
    } catch {
      setServerOnline(false);
    }
  };

  const loadHistory = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
  };

  const saveHistory = async (result: TestResult) => {
    try {
      const updated = [result, ...history].slice(0, 20);
      setHistory(updated);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {}
  };

  // ── Ping Test ──
  const testPing = async (): Promise<{ avgPing: number; jitter: number }> => {
    const pings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      try {
        await fetch('https://speed.cloudflare.com/__down?bytes=1', { cache: 'no-store' });
      } catch {}
      pings.push(Date.now() - start);
      setProgress((i + 1) / 5 * 100);
    }
    const avg = pings.reduce((a, b) => a + b, 0) / pings.length;
    // Jitter = avg deviation from mean
    const j = pings.reduce((a, b) => a + Math.abs(b - avg), 0) / pings.length;
    return { avgPing: Math.round(avg), jitter: Math.round(j) };
  };

  // ── Download Test ──
  const testDownload = async (): Promise<number> => {
    const sizes = [1000000, 2000000, 5000000]; // 1MB, 2MB, 5MB
    let totalBytes = 0;
    let totalTime = 0;

    for (let i = 0; i < sizes.length; i++) {
      const url = `https://speed.cloudflare.com/__down?bytes=${sizes[i]}`;
      const start = Date.now();
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        const blob = await resp.blob();
        totalBytes += blob.size;
      } catch {
        totalBytes += sizes[i] * 0.8; // estimate
      }
      totalTime += Date.now() - start;
      const speed = (totalBytes * 8) / (totalTime / 1000) / 1000000; // Mbps
      setDownload(parseFloat(speed.toFixed(2)));
      setProgress((i + 1) / sizes.length * 100);
    }

    const finalSpeed = (totalBytes * 8) / (totalTime / 1000) / 1000000;
    return parseFloat(finalSpeed.toFixed(2));
  };

  // ── Upload Test ──
  const testUpload = async (): Promise<number> => {
    const sizes = [100000, 500000, 1000000]; // 100KB, 500KB, 1MB
    let totalBytes = 0;
    let totalTime = 0;

    for (let i = 0; i < sizes.length; i++) {
      const data = new Uint8Array(sizes[i]);
      const start = Date.now();
      try {
        await fetch(UPLOAD_URL, {
          method: 'POST',
          body: data,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      } catch {}
      totalBytes += sizes[i];
      totalTime += Date.now() - start;
      const speed = (totalBytes * 8) / (totalTime / 1000) / 1000000;
      setUpload(parseFloat(speed.toFixed(2)));
      setProgress((i + 1) / sizes.length * 100);
    }

    const finalSpeed = (totalBytes * 8) / (totalTime / 1000) / 1000000;
    return parseFloat(finalSpeed.toFixed(2));
  };

  // ── Run full test ──
  const runTest = async () => {
    setPhase('ping');
    setDownload(0);
    setUpload(0);
    setPing(0);
    setJitter(0);
    setProgress(0);

    await checkConnection();

    // Ping
    const { avgPing, jitter: j } = await testPing();
    setPing(avgPing);
    setJitter(j);

    // Download
    setPhase('download');
    setProgress(0);
    const dl = await testDownload();
    setDownload(dl);

    // Upload
    setPhase('upload');
    setProgress(0);
    const ul = await testUpload();
    setUpload(ul);

    // Done
    setPhase('done');
    setProgress(100);

    const result: TestResult = {
      id: Date.now().toString(),
      download: dl,
      upload: ul,
      ping: avgPing,
      jitter: j,
      connectionType: connectionDetails,
      timestamp: Date.now(),
    };
    saveHistory(result);
  };

  // ── Gauge rendering ──
  const renderGauge = () => {
    const speed = phase === 'download' ? download : phase === 'upload' ? upload : (phase === 'done' ? download : 0);
    const maxSpeed = 200;
    const ratio = Math.min(speed / maxSpeed, 1);
    // Semicircle from -135deg to 135deg (270 deg arc)
    const needleAngle = -135 + ratio * 270;

    const ticks = [0, 25, 50, 100, 150, 200];

    return (
      <View style={styles.gaugeContainer}>
        {/* Gauge background arc */}
        <View style={[styles.gauge, { width: GAUGE_SIZE, height: GAUGE_SIZE / 2 + 20 }]}>
          {/* Background semicircle */}
          <View style={styles.gaugeArcBg} />
          {/* Colored arc overlay */}
          <View style={[styles.gaugeArcFill, {
            borderColor: speed > 100 ? C.green : speed > 50 ? C.cyan : speed > 20 ? C.accent : C.yellow,
          }]} />
          {/* Tick marks */}
          {ticks.map(t => {
            const angle = -135 + (t / maxSpeed) * 270;
            return (
              <View key={t} style={[styles.gaugeTick, {
                transform: [{ rotate: `${angle}deg` }, { translateY: -GAUGE_SIZE / 2 + 20 }],
              }]}>
                <Text style={styles.gaugeTickLabel}>{t}</Text>
              </View>
            );
          })}
          {/* Needle */}
          <View style={[styles.gaugeNeedle, { transform: [{ rotate: `${needleAngle}deg` }] }]}>
            <View style={styles.needleLine} />
          </View>
          {/* Center dot */}
          <View style={styles.gaugeCenterDot} />
        </View>
        {/* Speed display */}
        <Text style={styles.gaugeSpeed}>{speed.toFixed(1)}</Text>
        <Text style={styles.gaugeUnit}>Mbps</Text>
        {phase !== 'idle' && phase !== 'done' && (
          <Text style={styles.gaugePhase}>
            {phase === 'ping' ? 'Testing Ping...' : phase === 'download' ? 'Download Test...' : 'Upload Test...'}
          </Text>
        )}
      </View>
    );
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getConnectionIcon = () => {
    switch (connectionDetails.toLowerCase()) {
      case 'wifi': return '📶';
      case '5g': return '5G';
      case '4g': case 'lte': return '4G';
      case '3g': return '3G';
      default: return '🌐';
    }
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={['#020B18', '#0A1628', '#020B18']} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Speed Test</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Connection Info */}
        <View style={styles.connectionRow}>
          <View style={styles.connectionBadge}>
            <Text style={styles.connectionIcon}>{getConnectionIcon()}</Text>
            <Text style={styles.connectionLabel}>{connectionDetails}</Text>
          </View>
          <View style={[styles.serverDot, { backgroundColor: serverOnline === null ? C.yellow : serverOnline ? C.green : C.danger }]} />
          <Text style={styles.serverLabel}>
            {serverOnline === null ? 'Checking...' : serverOnline ? 'Server Online' : 'Server Offline'}
          </Text>
        </View>

        {/* Gauge */}
        {renderGauge()}

        {/* Progress bar */}
        {phase !== 'idle' && phase !== 'done' && (
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        )}

        {/* Test Button */}
        <TouchableOpacity
          onPress={runTest}
          disabled={phase !== 'idle' && phase !== 'done'}
          style={[styles.testButton, (phase !== 'idle' && phase !== 'done') && styles.testButtonDisabled]}
        >
          <LinearGradient
            colors={(phase !== 'idle' && phase !== 'done') ? ['#333', '#222'] : [C.accent, '#2D7AE0']}
            style={styles.testButtonGradient}
          >
            {(phase !== 'idle' && phase !== 'done') ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.testButtonText}>{phase === 'done' ? 'Test Again' : 'Start Test'}</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {/* Results */}
        {phase === 'done' && (
          <View style={styles.resultsGrid}>
            <View style={[styles.resultCard, { borderLeftColor: C.cyan }]}>
              <Text style={styles.resultLabel}>Download</Text>
              <Text style={styles.resultValue}>{download.toFixed(1)}</Text>
              <Text style={styles.resultUnit}>Mbps</Text>
            </View>
            <View style={[styles.resultCard, { borderLeftColor: C.accent }]}>
              <Text style={styles.resultLabel}>Upload</Text>
              <Text style={styles.resultValue}>{upload.toFixed(1)}</Text>
              <Text style={styles.resultUnit}>Mbps</Text>
            </View>
            <View style={[styles.resultCard, { borderLeftColor: C.green }]}>
              <Text style={styles.resultLabel}>Ping</Text>
              <Text style={styles.resultValue}>{ping}</Text>
              <Text style={styles.resultUnit}>ms</Text>
            </View>
            <View style={[styles.resultCard, { borderLeftColor: C.yellow }]}>
              <Text style={styles.resultLabel}>Jitter</Text>
              <Text style={styles.resultValue}>{jitter}</Text>
              <Text style={styles.resultUnit}>ms</Text>
            </View>
          </View>
        )}

        {/* History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>History</Text>
          {history.length === 0 ? (
            <Text style={styles.noHistory}>No previous tests</Text>
          ) : (
            history.map(item => (
              <View key={item.id} style={styles.historyRow}>
                <View style={styles.historyLeft}>
                  <Text style={styles.historyDate}>{formatDate(item.timestamp)}</Text>
                  <Text style={styles.historyConn}>{item.connectionType}</Text>
                </View>
                <View style={styles.historyRight}>
                  <View style={styles.historyMetric}>
                    <Text style={styles.historyMetricLabel}>↓</Text>
                    <Text style={styles.historyMetricValue}>{item.download.toFixed(1)}</Text>
                  </View>
                  <View style={styles.historyMetric}>
                    <Text style={styles.historyMetricLabel}>↑</Text>
                    <Text style={styles.historyMetricValue}>{item.upload.toFixed(1)}</Text>
                  </View>
                  <View style={styles.historyMetric}>
                    <Text style={[styles.historyMetricLabel, { color: C.green }]}>⏱</Text>
                    <Text style={styles.historyMetricValue}>{item.ping}ms</Text>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  backArrow: { color: C.accent, fontSize: 20 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // Connection
  connectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 16 },
  connectionBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, marginRight: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.1)' },
  connectionIcon: { fontSize: 16, marginRight: 6 },
  connectionLabel: { color: '#FFF', fontSize: 14, fontWeight: '600' },
  serverDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  serverLabel: { color: C.muted, fontSize: 13 },

  // Gauge
  gaugeContainer: { alignItems: 'center', marginVertical: 16 },
  gauge: { alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' },
  gaugeArcBg: { position: 'absolute', top: 0, width: GAUGE_SIZE, height: GAUGE_SIZE, borderRadius: GAUGE_SIZE / 2, borderWidth: GAUGE_STROKE, borderColor: 'rgba(74,159,255,0.08)' },
  gaugeArcFill: { position: 'absolute', top: 0, width: GAUGE_SIZE, height: GAUGE_SIZE, borderRadius: GAUGE_SIZE / 2, borderWidth: GAUGE_STROKE, borderTopColor: 'transparent' },
  gaugeTick: { position: 'absolute', bottom: 0, alignItems: 'center' },
  gaugeTickLabel: { color: C.muted, fontSize: 9 },
  gaugeNeedle: { position: 'absolute', bottom: 10, width: 3, height: GAUGE_SIZE / 2 - 20, backgroundColor: C.danger, borderRadius: 2, transformOrigin: 'bottom center' },
  needleLine: { width: 3, height: '100%', backgroundColor: C.cyan, borderRadius: 2 },
  gaugeCenterDot: { position: 'absolute', bottom: 4, width: 16, height: 16, borderRadius: 8, backgroundColor: '#FFF' },
  gaugeSpeed: { color: '#FFF', fontSize: 42, fontWeight: '800', marginTop: 8 },
  gaugeUnit: { color: C.muted, fontSize: 14, marginTop: -2 },
  gaugePhase: { color: C.cyan, fontSize: 13, fontWeight: '600', marginTop: 8 },

  // Progress
  progressBar: { height: 4, backgroundColor: 'rgba(74,159,255,0.1)', borderRadius: 2, marginVertical: 12, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: C.cyan, borderRadius: 2 },

  // Test Button
  testButton: { borderRadius: 14, overflow: 'hidden', marginVertical: 16, elevation: 4, shadowColor: C.accent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
  testButtonDisabled: { opacity: 0.7 },
  testButtonGradient: { paddingVertical: 16, alignItems: 'center', borderRadius: 14 },
  testButtonText: { color: '#FFF', fontSize: 18, fontWeight: '800', letterSpacing: 1 },

  // Results
  resultsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  resultCard: { width: (SW - 42) / 2, backgroundColor: C.card, borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)', borderLeftWidth: 3 },
  resultLabel: { color: C.muted, fontSize: 12, marginBottom: 4 },
  resultValue: { color: '#FFF', fontSize: 28, fontWeight: '800' },
  resultUnit: { color: C.muted, fontSize: 12, marginTop: 2 },

  // History
  section: { marginTop: 20 },
  sectionTitle: { color: '#FFF', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  noHistory: { color: C.muted, fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.06)' },
  historyLeft: { flex: 1 },
  historyDate: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  historyConn: { color: C.muted, fontSize: 11, marginTop: 2 },
  historyRight: { flexDirection: 'row', gap: 14 },
  historyMetric: { alignItems: 'center' },
  historyMetricLabel: { color: C.accent, fontSize: 12 },
  historyMetricValue: { color: '#FFF', fontSize: 13, fontWeight: '700', marginTop: 2 },
});
