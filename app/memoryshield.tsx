import { HEADER_TOP } from '../constants/layout';
import { ErrorBoundary } from '../components/ErrorBoundary';
﻿import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useMemo } from 'react';
import { Alert, Animated, Easing, Modal, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { DestructionLog, ShieldStatus, executeMemoryShield, loadDestructionLogs, loadShieldStatus, reasonLabels, saveShieldStatus } from '../constants/memoryShield';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

function MemoryShieldScreenContent() {
  const c = useColors();
  const S = useMemo(() => makeS(c), [c]);
  const router = useRouter();
  const [status, setStatus] = useState<ShieldStatus | null>(null);
  const [logs, setLogs] = useState<DestructionLog[]>([]);
  const [showNuclear, setShowNuclear] = useState(false);
  const [showPanicSetup, setShowPanicSetup] = useState(false);
  const [panicInput, setPanicInput] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [destroying, setDestroying] = useState(false);
  const [destroyed, setDestroyed] = useState(false);
  const [lastLog, setLastLog] = useState<DestructionLog | null>(null);
  const [countdown, setCountdown] = useState(5);
  const [countingDown, setCountingDown] = useState(false);
  const fadeIn = useRef(new Animated.Value(0)).current;
  const pulseRed = useRef(new Animated.Value(1)).current;
  const shieldAnim = useRef(new Animated.Value(0)).current;
  const warningAnim = useRef(new Animated.Value(0)).current;
  const countTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseRed, { toValue: 1.08, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulseRed, { toValue: 1.00, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ])).start();
    Animated.loop(Animated.timing(shieldAnim, { toValue: 1, duration: 8000, easing: Easing.linear, useNativeDriver: true })).start();
    load();
    return () => { if (countTimer.current) clearInterval(countTimer.current); };
  }, [fadeIn, pulseRed, shieldAnim]);

  const load = async () => {
    const s = await loadShieldStatus();
    const l = await loadDestructionLogs();
    setStatus(s); setLogs(l);
  };

  const updateStatus = async (updates: Partial<ShieldStatus>) => {
    if (!status) return;
    const updated = { ...status, ...updates };
    setStatus(updated);
    await saveShieldStatus(updated);
  };

  const startCountdown = () => {
    setCountingDown(true); setCountdown(5); let c = 5;
    countTimer.current = setInterval(() => {
      c--; setCountdown(c);
      if (c <= 0) { clearInterval(countTimer.current!); setCountingDown(false); triggerDestruction('manual'); }
    }, 1000);
  };

  const cancelCountdown = () => {
    if (countTimer.current) clearInterval(countTimer.current);
    setCountingDown(false); setCountdown(5); setShowNuclear(false); setConfirmText('');
  };

  const triggerDestruction = async (reason: 'manual' | 'panic' | 'breach' | 'timeout' | 'failedlogin') => {
    setDestroying(true); setShowNuclear(false);
    Animated.loop(Animated.sequence([
      Animated.timing(warningAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
      Animated.timing(warningAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
    ])).start();
    try {
      const log = await executeMemoryShield(reason);
      setLastLog(log); setDestroyed(true); setLogs(prev => [log, ...prev]);
    } catch { Alert.alert('Error', 'Destruction failed.'); }
    setDestroying(false);
  };

  const rotateStr = shieldAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const warningOpacity = warningAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] });

  if (destroyed) return (
    <LinearGradient colors={['#FFFFFF', '#060F24']} style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 }}>
      <Text style={{ fontSize: 80, marginBottom: 20 }}>💀</Text>
      <Text style={{ color: '#EF4444', fontSize: 26, fontWeight: '900', textAlign: 'center', marginBottom: 20 }}>MEMORY SHIELD EXECUTED</Text>
      <View style={{ backgroundColor: 'rgba(239,68,68,0.16)', borderRadius: 16, padding: 20, width: '100%', borderWidth: 1, borderColor: 'rgba(239,68,68,0.18)', marginBottom: 20 }}>
        {lastLog && (
          <View>
            <Text style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Time: {new Date(lastLog.timestamp).toLocaleString()}</Text>
            <Text style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Items destroyed: {lastLog.itemsDestroyed}</Text>
            <Text style={{ color: '#fff', fontSize: 13 }}>Reason: {reasonLabels[lastLog.reason]}</Text>
          </View>
        )}
      </View>
      <TouchableOpacity onPress={() => router.replace('/' as any)}>
        <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={{ borderRadius: 16, paddingVertical: 14, paddingHorizontal: 40 }}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>Return to Login</Text>
        </LinearGradient>
      </TouchableOpacity>
    </LinearGradient>
  );

  if (destroying) return (
    <LinearGradient colors={['#1a0000', '#2d0000', '#000']} style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Animated.View style={{ opacity: warningOpacity, position: 'absolute', width: '100%', height: '100%', backgroundColor: '#EF4444' }} />
      <Text style={{ fontSize: 80, marginBottom: 20 }}>💀</Text>
      <Text style={{ color: '#EF4444', fontSize: 22, fontWeight: '900', letterSpacing: 3 }}>DESTROYING...</Text>
      <Text style={{ color: '#FCA5A5', fontSize: 14, marginTop: 10 }}>Overwriting encryption keys</Text>
      <Text style={{ color: '#FCA5A5', fontSize: 14, marginTop: 4 }}>Wiping biometric data</Text>
      <Text style={{ color: '#FCA5A5', fontSize: 14, marginTop: 4 }}>Destroying VaultID</Text>
      <Text style={{ color: '#FCA5A5', fontSize: 14, marginTop: 4 }}>Clearing all messages</Text>
    </LinearGradient>
  );

  return (
    <LinearGradient colors={['#FFFFFF', '#040F20', '#060F24']} style={{ flex: 1 }}>
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <ScrollView contentContainerStyle={S.container}>
          <View style={S.header}>
            <TouchableOpacity onPress={() => router.back()} style={S.backBtn}>
              <Ionicons name="arrow-back" size={20} color="#4A9FFF" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={S.title}>💀 MemoryShield</Text>
              <Text style={{ color: '#3D5A7A', fontSize: 9, letterSpacing: 1.5 }}>INSTANT DATA DESTRUCTION</Text>
            </View>
          </View>

          <Animated.View style={[S.shieldContainer, { transform: [{ scale: pulseRed }] }]}>
            <LinearGradient colors={['#1a0000', '#2d0606', '#F9FAFB']} style={S.shieldCard}>
              <Animated.View style={[S.shieldRing, { transform: [{ rotate: rotateStr }] }]} />
              <Text style={{ fontSize: 70, marginBottom: 8 }}>💀</Text>
              <Text style={{ color: '#EF4444', fontSize: 20, fontWeight: '900', letterSpacing: 2 }}>MEMORYSHIELD</Text>
              <Text style={{ color: '#FCA5A5', fontSize: 11, marginTop: 4 }}>Armed and ready</Text>
              <View style={S.statusRow}>
                <View style={[S.statusDot, { backgroundColor: '#22C55E' }]} />
                <Text style={{ color: '#22C55E', fontSize: 12, fontWeight: '700' }}>SHIELD ACTIVE</Text>
              </View>
            </LinearGradient>
          </Animated.View>

          <TouchableOpacity onPress={() => setShowNuclear(true)} style={{ marginBottom: 16 }}>
            <LinearGradient colors={['#7F1D1D', '#991B1B', '#EF4444']} style={S.nuclearBtn}>
              <Text style={{ fontSize: 28 }}>☢️</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>TRIGGER MEMORYSHIELD</Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 }}>Instantly destroy ALL data</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>

          {status && (
            <View style={S.settingsCard}>
              <Text style={S.settingsTitle}>Shield Settings</Text>
              <View style={S.settingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={S.settingLabel}>Auto-Destruct Timer</Text>
                  <Text style={S.settingDesc}>Destroy if app unused</Text>
                </View>
                <Switch value={status.autoDestructEnabled} onValueChange={v => updateStatus({ autoDestructEnabled: v })} trackColor={{ false: '#1D2D44', true: '#EF4444' }} thumbColor={status.autoDestructEnabled ? '#fff' : '#3D5A7A'} />
              </View>
              {status.autoDestructEnabled && (
                <View style={S.timerRow}>
                  {[15, 30, 60, 120, 240].map(mins => (
                    <TouchableOpacity key={mins} onPress={() => updateStatus({ autoDestructMinutes: mins })} style={[S.timerChip, { backgroundColor: status.autoDestructMinutes === mins ? '#EF4444' : '#060E22', borderColor: status.autoDestructMinutes === mins ? '#EF4444' : '#0D1E3A' }]}>
                      <Text style={{ color: status.autoDestructMinutes === mins ? '#fff' : '#3D5A7A', fontSize: 12, fontWeight: '700' }}>{mins < 60 ? (mins + 'm') : (mins / 60 + 'h')}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={[S.settingRow, { marginTop: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={S.settingLabel}>Panic Word</Text>
                  <Text style={S.settingDesc}>Type to trigger shield instantly</Text>
                </View>
                <Switch value={status.panicWordEnabled} onValueChange={v => { updateStatus({ panicWordEnabled: v }); if (v) setShowPanicSetup(true); }} trackColor={{ false: '#1D2D44', true: '#EF4444' }} thumbColor={status.panicWordEnabled ? '#fff' : '#3D5A7A'} />
              </View>
              {status.panicWordEnabled && status.panicWord && (
                <View style={{ backgroundColor: c.bg, borderRadius: 10, padding: 10, marginTop: 8 }}>
                  <Text style={{ color: '#EF4444', fontSize: 14, fontWeight: '700' }}>{'*'.repeat(status.panicWord.length)}</Text>
                </View>
              )}
              <View style={[S.settingRow, { marginTop: 12 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={S.settingLabel}>Failed Login Limit</Text>
                  <Text style={S.settingDesc}>Destroy after X failed face scans</Text>
                </View>
              </View>
              <View style={S.timerRow}>
                {[3, 5, 10].map(n => (
                  <TouchableOpacity key={n} onPress={() => updateStatus({ failedLoginLimit: n })} style={[S.timerChip, { backgroundColor: status.failedLoginLimit === n ? '#EF4444' : '#060E22', borderColor: status.failedLoginLimit === n ? '#EF4444' : '#0D1E3A' }]}>
                    <Text style={{ color: status.failedLoginLimit === n ? '#fff' : '#3D5A7A', fontSize: 12, fontWeight: '700' }}>{n + ' fails'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          <View style={S.destroyCard}>
            <Text style={S.settingsTitle}>What Gets Destroyed</Text>
            {[
              { icon: '🔑', item: 'Private cryptographic keys', critical: true },
              { icon: '🧬', item: 'VaultID identity', critical: true },
              { icon: '👤', item: 'Enrolled face scans', critical: true },
              { icon: '💬', item: 'All messages and chats', critical: true },
              { icon: '📁', item: 'Shared files and media', critical: false },
              { icon: '👥', item: 'Contact list', critical: false },
              { icon: '⚙️', item: 'App settings', critical: false },
            ].map((d, i) => (
              <View key={i} style={S.destroyRow}>
                <Text style={{ fontSize: 16, width: 28 }}>{d.icon}</Text>
                <Text style={{ color: '#fff', fontSize: 13, flex: 1 }}>{d.item}</Text>
                {d.critical && <View style={{ backgroundColor: 'rgba(239,68,68,0.16)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}><Text style={{ color: '#EF4444', fontSize: 9, fontWeight: '800' }}>CRITICAL</Text></View>}
              </View>
            ))}
          </View>

          {logs.length > 0 && (
            <View style={S.logsCard}>
              <Text style={S.settingsTitle}>Destruction History</Text>
              {logs.map((log, i) => (
                <View key={i} style={S.logRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: '#EF4444', fontSize: 12, fontWeight: '700' }}>{reasonLabels[log.reason]}</Text>
                    <Text style={{ color: '#3D5A7A', fontSize: 10, marginTop: 2 }}>{new Date(log.timestamp).toLocaleString()}</Text>
                    <Text style={{ color: '#3D5A7A', fontSize: 10 }}>{log.itemsDestroyed} items destroyed</Text>
                  </View>
                  <Text style={{ fontSize: 20 }}>💀</Text>
                </View>
              ))}
            </View>
          )}

          <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={{ borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginBottom: 20 }} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }}>MEMORYSHIELD · CRYPTOGRAPHIC DESTRUCTION · WORLD FIRST</Text>
          </LinearGradient>
        </ScrollView>
      </Animated.View>

      <Modal visible={showNuclear} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', padding: 24 }}>
          <LinearGradient colors={['#1a0000', '#2d0606']} style={{ borderRadius: 24, padding: 24, borderWidth: 2, borderColor: '#EF4444' }}>
            <Text style={{ fontSize: 50, textAlign: 'center', marginBottom: 12 }}>☢️</Text>
            <Text style={{ color: '#EF4444', fontSize: 20, fontWeight: '900', textAlign: 'center', marginBottom: 4 }}>MEMORYSHIELD TRIGGER</Text>
            <Text style={{ color: '#FCA5A5', fontSize: 13, textAlign: 'center', marginBottom: 20, lineHeight: 20 }}>This will permanently destroy ALL your VaultChat data. THIS CANNOT BE UNDONE.</Text>
            {!countingDown ? (
              <View>
                <Text style={{ color: '#3D5A7A', fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>TYPE DESTROY TO CONFIRM</Text>
                <TextInput value={confirmText} onChangeText={setConfirmText} placeholder="Type DESTROY..." placeholderTextColor="#3D5A7A" style={{ backgroundColor: c.bg, borderRadius: 12, padding: 14, color: '#EF4444', fontSize: 16, fontWeight: '900', borderWidth: 1.5, borderColor: 'rgba(239,68,68,0.18)', marginBottom: 16, textAlign: 'center', letterSpacing: 2 }} autoCapitalize="characters" />
                <TouchableOpacity disabled={confirmText !== 'DESTROY'} style={{ opacity: confirmText === 'DESTROY' ? 1 : 0.4 }} onPress={startCountdown}>
                  <LinearGradient colors={['#7F1D1D', '#EF4444']} style={{ borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginBottom: 12 }}>
                    <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>EXECUTE MEMORYSHIELD</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setShowNuclear(false); setConfirmText(''); }} style={{ alignItems: 'center', paddingVertical: 12 }}>
                  <Text style={{ color: '#3D5A7A', fontSize: 14 }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ color: '#EF4444', fontSize: 60, fontWeight: '900' }}>{countdown}</Text>
                <Text style={{ color: '#FCA5A5', fontSize: 14, marginBottom: 20 }}>Destroying in {countdown} seconds...</Text>
                <TouchableOpacity onPress={cancelCountdown} style={{ backgroundColor: 'rgba(34,197,94,0.16)', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 30, borderWidth: 1, borderColor: '#166534' }}>
                  <Text style={{ color: '#4ADE80', fontSize: 15, fontWeight: '800' }}>CANCEL DESTRUCTION</Text>
                </TouchableOpacity>
              </View>
            )}
          </LinearGradient>
        </View>
      </Modal>

      <Modal visible={showPanicSetup} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'flex-end' }}>
          <LinearGradient colors={['#F9FAFB', '#0D1E3A']} style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 }}>
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '900', marginBottom: 4 }}>Set Panic Word</Text>
            <Text style={{ color: '#3D5A7A', fontSize: 13, marginBottom: 20, lineHeight: 20 }}>Choose a secret word. Typing it anywhere will trigger MemoryShield instantly.</Text>
            <TextInput value={panicInput} onChangeText={setPanicInput} placeholder="e.g. DANGER, HELP, SHIELD" placeholderTextColor="#1D2D44" style={{ backgroundColor: c.bg, borderRadius: 12, padding: 14, color: '#EF4444', fontSize: 16, fontWeight: '900', borderWidth: 1.5, borderColor: 'rgba(239,68,68,0.18)', marginBottom: 20, textAlign: 'center', letterSpacing: 2 }} autoCapitalize="characters" />
            <TouchableOpacity disabled={panicInput.length < 3} style={{ opacity: panicInput.length >= 3 ? 1 : 0.4 }} onPress={async () => { await updateStatus({ panicWord: panicInput, panicWordEnabled: true }); setShowPanicSetup(false); setPanicInput(''); Alert.alert('Panic Word Set', panicInput + ' will now trigger MemoryShield instantly.'); }}>
              <LinearGradient colors={['#7F1D1D', '#EF4444']} style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>Set Panic Word</Text>
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowPanicSetup(false); updateStatus({ panicWordEnabled: false }); }} style={{ alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ color: '#3D5A7A', fontSize: 14 }}>Cancel</Text>
            </TouchableOpacity>
          </LinearGradient>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  container: { paddingHorizontal: 18, paddingTop: HEADER_TOP, paddingBottom: 20 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#0D1E3A' },
  title: { color: '#fff', fontSize: 20, fontWeight: '900' },
  shieldContainer: { marginBottom: 16, borderRadius: 24 },
  shieldCard: { borderRadius: 24, padding: 28, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(239,68,68,0.18)', overflow: 'hidden' },
  shieldRing: { position: 'absolute', width: 260, height: 260, borderRadius: 130, borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)', borderStyle: 'dashed' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, backgroundColor: c.bg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  nuclearBtn: { borderRadius: 18, padding: 18, flexDirection: 'row', alignItems: 'center' },
  settingsCard: { backgroundColor: c.glassSoft, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#0D1E3A' },
  settingsTitle: { color: '#fff', fontSize: 14, fontWeight: '800', marginBottom: 14 },
  settingRow: { flexDirection: 'row', alignItems: 'center' },
  settingLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  settingDesc: { color: '#3D5A7A', fontSize: 11, marginTop: 2 },
  timerRow: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  timerChip: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5 },
  destroyCard: { backgroundColor: c.glassSoft, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.18)' },
  destroyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#0D1E3A', gap: 8 },
  logsCard: { backgroundColor: c.glassSoft, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#0D1E3A' },
  logRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#0D1E3A' },
});

export default function MemoryShieldScreen() {
  return (
    <ErrorBoundary fallbackTitle="MemoryShield Error" fallbackMessage="MemoryShield had a problem. Data is still protected.">
      <MemoryShieldScreenContent />
    </ErrorBoundary>
  );
}
