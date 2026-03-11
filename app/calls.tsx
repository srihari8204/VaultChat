
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';
import webrtcService, { CallHistoryEntry, CallSession } from '../constants/webrtcService';

const CONTACTS = [
  { id: '1', name: 'Alice', emoji: '👩', online: true },
  { id: '2', name: 'Bob', emoji: '👨', online: true },
  { id: '3', name: 'Sarah', emoji: '👧', online: false },
  { id: '4', name: 'Mike', emoji: '👦', online: false },
  { id: '5', name: 'VaultBot', emoji: '🤖', online: true },
];

const TIME_LIMITS = [
  { label: 'No limit', value: 0 },
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
];

function CallsContent() {
  const router = useRouter();
  const [history, setHistory] = useState<CallHistoryEntry[]>([]);
  const [activeCall, setActiveCall] = useState<CallSession | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [showNewCall, setShowNewCall] = useState(false);
  const [showCallOptions, setShowCallOptions] = useState(false);
  const [selectedContact, setSelectedContact] = useState<typeof CONTACTS[0] | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [timeLimit, setTimeLimit] = useState(0);
  const [showTimeLimits, setShowTimeLimits] = useState(false);
  const fadeIn = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    setHistory(webrtcService.getHistory());

    const onStateChange = (session: CallSession) => setActiveCall({ ...session });
    const onDuration = (d: number) => setCallDuration(d);
    const onEnded = () => { setActiveCall(null); setCallDuration(0); setHistory(webrtcService.getHistory()); };

    webrtcService.on('callStateChanged', onStateChange);
    webrtcService.on('durationUpdate', onDuration);
    webrtcService.on('callEnded', onEnded);

    return () => {
      webrtcService.off('callStateChanged', onStateChange);
      webrtcService.off('durationUpdate', onDuration);
      webrtcService.off('callEnded', onEnded);
    };
  }, []);

  useEffect(() => {
    if (activeCall?.state === 'calling') {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [activeCall?.state]);

  const startCall = (type: 'audio' | 'video') => {
    if (!selectedContact) return;
    setShowCallOptions(false);
    setShowNewCall(false);
    webrtcService.startCall({
      contactId: selectedContact.id,
      contactName: selectedContact.name,
      contactEmoji: selectedContact.emoji,
      type,
      isAnonymous,
      timeLimitMinutes: timeLimit > 0 ? timeLimit : undefined,
    });
  };

  const formatDuration = (s: number) => webrtcService.formatDuration(s);

  const formatHistoryTime = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    return Math.floor(d / 86400000) + 'd ago';
  };

  const getCallIcon = (entry: CallHistoryEntry) => {
    if (entry.direction === 'missed') return '📵';
    if (entry.type === 'video') return entry.direction === 'incoming' ? '📹' : '🎥';
    return entry.direction === 'incoming' ? '📲' : '📞';
  };

  const getCallColor = (entry: CallHistoryEntry) => {
    if (entry.direction === 'missed') return '#EF4444';
    if (entry.direction === 'incoming') return '#10B981';
    return '#4A9FFF';
  };

  return (
    <LinearGradient colors={['#020B18', '#040F20', '#060F24']} style={{ flex: 1 }}>
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <View style={S.header}>
          <TouchableOpacity onPress={() => router.push('/chats' as any)} style={S.backBtn}>
            <Text style={{ color: '#4A9FFF', fontSize: 18 }}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={S.title}>Calls</Text>
            <Text style={{ color: '#3D5A7A', fontSize: 10, letterSpacing: 1 }}>END-TO-END ENCRYPTED</Text>
          </View>
          <TouchableOpacity onPress={() => setShowNewCall(true)} style={S.newCallBtn}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>+</Text>
          </TouchableOpacity>
        </View>

        {activeCall && (
          <View style={[S.activeCallBanner, { backgroundColor: activeCall.state === 'connected' ? '#052E16' : '#1a0a00', borderColor: activeCall.state === 'connected' ? '#166534' : '#F59E0B' }]}>
            <Animated.View style={{ transform: [{ scale: activeCall.state === 'calling' ? pulseAnim : new Animated.Value(1) }] }}>
              <Text style={{ fontSize: 28 }}>{activeCall.isAnonymous ? '👻' : activeCall.contactEmoji}</Text>
            </Animated.View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>
                {activeCall.isAnonymous ? 'Anonymous Call' : activeCall.contactName}
              </Text>
              <Text style={{ color: activeCall.state === 'connected' ? '#10B981' : '#F59E0B', fontSize: 12, fontWeight: '700' }}>
                {activeCall.state === 'calling' ? 'Calling...' : formatDuration(callDuration)}
              </Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/videocall' as any)} style={S.returnBtn}>
              <Text style={{ color: '#4A9FFF', fontSize: 12, fontWeight: '700' }}>Return</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => webrtcService.endCall()} style={S.endBanner}>
              <Text style={{ fontSize: 20 }}>📵</Text>
            </TouchableOpacity>
          </View>
        )}

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 30 }}>
          <View style={S.statsRow}>
            {[
              { label: 'Total Calls', value: history.length.toString(), icon: '📞' },
              { label: 'Video Calls', value: history.filter(h => h.type === 'video').length.toString(), icon: '🎥' },
              { label: 'Anonymous', value: history.filter(h => h.isAnonymous).length.toString(), icon: '👻' },
              { label: 'Encrypted', value: history.filter(h => h.isEncrypted).length.toString(), icon: '🔐' },
            ].map((s, i) => (
              <View key={i} style={S.statCard}>
                <Text style={{ fontSize: 22 }}>{s.icon}</Text>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', marginTop: 4 }}>{s.value}</Text>
                <Text style={{ color: '#3D5A7A', fontSize: 10, marginTop: 2, textAlign: 'center' }}>{s.label}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity onPress={() => setShowNewCall(true)} style={{ marginHorizontal: 18, marginBottom: 16 }}>
            <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={S.newCallCard}>
              <Text style={{ fontSize: 36 }}>📞</Text>
              <View style={{ flex: 1, marginLeft: 16 }}>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>New Secure Call</Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 }}>Audio • Video • Anonymous • Encrypted</Text>
              </View>
              <Text style={{ color: '#fff', fontSize: 24 }}>→</Text>
            </LinearGradient>
          </TouchableOpacity>

          <View style={S.section}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={S.sectionTitle}>Recent Calls</Text>
              {history.length > 0 && (
                <TouchableOpacity onPress={() => { webrtcService.clearHistory(); setHistory([]); }}>
                  <Text style={{ color: '#EF4444', fontSize: 12 }}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
            {history.length === 0 ? (
              <View style={S.emptyCard}>
                <Text style={{ fontSize: 40, marginBottom: 10 }}>📋</Text>
                <Text style={{ color: '#3D5A7A', fontSize: 14 }}>No calls yet</Text>
                <Text style={{ color: '#1D2D44', fontSize: 12, marginTop: 4 }}>Make your first encrypted call</Text>
              </View>
            ) : (
              history.map((entry, i) => (
                <TouchableOpacity key={i} style={S.historyRow} onPress={() => {
                  const c = CONTACTS.find(x => x.id === entry.contactId);
                  if (c) { setSelectedContact(c); setIsAnonymous(entry.isAnonymous); setShowCallOptions(true); }
                }}>
                  <View style={[S.callIconBox, { backgroundColor: getCallColor(entry) + '22', borderColor: getCallColor(entry) + '44' }]}>
                    <Text style={{ fontSize: 22 }}>{getCallIcon(entry)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ fontSize: 18 }}>{entry.contactEmoji}</Text>
                      <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{entry.contactName}</Text>
                      {entry.isAnonymous && <View style={S.anonBadge}><Text style={{ color: '#A78BFA', fontSize: 9, fontWeight: '800' }}>ANON</Text></View>}
                      {entry.isEncrypted && <Text style={{ fontSize: 12 }}>🔐</Text>}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                      <Text style={{ color: getCallColor(entry), fontSize: 11 }}>
                        {entry.direction === 'incoming' ? '↙️ Incoming' : entry.direction === 'missed' ? '❌ Missed' : '↗️ Outgoing'}
                      </Text>
                      <Text style={{ color: '#3D5A7A', fontSize: 11 }}>• {entry.type === 'video' ? 'Video' : 'Audio'}</Text>
                      {entry.duration > 0 && <Text style={{ color: '#3D5A7A', fontSize: 11 }}>• {formatDuration(entry.duration)}</Text>}
                    </View>
                  </View>
                  <Text style={{ color: '#3D5A7A', fontSize: 11 }}>{formatHistoryTime(entry.timestamp)}</Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        </ScrollView>
      </Animated.View>

      <Modal visible={showNewCall} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} activeOpacity={1} onPress={() => setShowNewCall(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['#0A1628', '#0D1E3A']} style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 }}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 4 }}>New Secure Call</Text>
              <Text style={{ color: '#3D5A7A', fontSize: 12, marginBottom: 20 }}>All calls are end-to-end encrypted</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
                <TouchableOpacity onPress={() => setIsAnonymous(false)} style={{ flex: 1, backgroundColor: !isAnonymous ? '#1D4ED8' : '#060E22', borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: !isAnonymous ? '#3B82F6' : '#0D1E3A' }}>
                  <Text style={{ fontSize: 24 }}>👤</Text>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 }}>Normal</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setIsAnonymous(true)} style={{ flex: 1, backgroundColor: isAnonymous ? '#7C3AED' : '#060E22', borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: isAnonymous ? '#A78BFA' : '#0D1E3A' }}>
                  <Text style={{ fontSize: 24 }}>👻</Text>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 }}>Anonymous</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowTimeLimits(true)} style={{ flex: 1, backgroundColor: timeLimit > 0 ? '#F59E0B22' : '#060E22', borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 1.5, borderColor: timeLimit > 0 ? '#F59E0B' : '#0D1E3A' }}>
                  <Text style={{ fontSize: 24 }}>⏱️</Text>
                  <Text style={{ color: timeLimit > 0 ? '#F59E0B' : '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 }}>{timeLimit > 0 ? timeLimit + ' min' : 'Time Limit'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={{ color: '#3D5A7A', fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>SELECT CONTACT</Text>
              {CONTACTS.map((c, i) => (
                <TouchableOpacity key={i} onPress={() => { setSelectedContact(c); setShowNewCall(false); setShowCallOptions(true); }} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#060E22', borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#0D1E3A', gap: 12 }}>
                  <View style={{ position: 'relative' }}>
                    <Text style={{ fontSize: 28 }}>{c.emoji}</Text>
                    {c.online && <View style={{ position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: '#10B981', borderWidth: 2, borderColor: '#060E22' }} />}
                  </View>
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 }}>{c.name}</Text>
                  <Text style={{ color: c.online ? '#10B981' : '#3D5A7A', fontSize: 11 }}>{c.online ? 'Online' : 'Offline'}</Text>
                  <Text style={{ fontSize: 16 }}>📞</Text>
                </TouchableOpacity>
              ))}
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showTimeLimits} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} activeOpacity={1} onPress={() => setShowTimeLimits(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['#0A1628', '#0D1E3A']} style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 }}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 16 }}>Call Time Limit</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {TIME_LIMITS.map((t, i) => (
                  <TouchableOpacity key={i} onPress={() => { setTimeLimit(t.value); setShowTimeLimits(false); }} style={{ backgroundColor: timeLimit === t.value ? '#F59E0B' : '#060E22', borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1.5, borderColor: timeLimit === t.value ? '#F59E0B' : '#0D1E3A' }}>
                    <Text style={{ color: timeLimit === t.value ? '#000' : '#fff', fontSize: 14, fontWeight: '700' }}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showCallOptions && selectedContact !== null} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} activeOpacity={1} onPress={() => setShowCallOptions(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['#0A1628', '#0D1E3A']} style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 }}>
              <View style={{ alignItems: 'center', marginBottom: 24 }}>
                <Text style={{ fontSize: 56 }}>{isAnonymous ? '👻' : selectedContact?.emoji}</Text>
                <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginTop: 10 }}>{isAnonymous ? 'Anonymous Call' : selectedContact?.name}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {isAnonymous && <View style={{ backgroundColor: '#2D1B69', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}><Text style={{ color: '#A78BFA', fontSize: 11, fontWeight: '700' }}>👻 ANONYMOUS</Text></View>}
                  <View style={{ backgroundColor: '#052E16', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}><Text style={{ color: '#10B981', fontSize: 11, fontWeight: '700' }}>🔐 ENCRYPTED</Text></View>
                  {timeLimit > 0 && <View style={{ backgroundColor: '#1a0a00', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 }}><Text style={{ color: '#F59E0B', fontSize: 11, fontWeight: '700' }}>⏱️ {timeLimit} MIN</Text></View>}
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 20, justifyContent: 'center' }}>
                <TouchableOpacity onPress={() => startCall('audio')} style={{ alignItems: 'center', gap: 10 }}>
                  <LinearGradient colors={['#1D4ED8', '#3B82F6']} style={{ width: 74, height: 74, borderRadius: 37, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: 34 }}>📞</Text>
                  </LinearGradient>
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>Audio Call</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => startCall('video')} style={{ alignItems: 'center', gap: 10 }}>
                  <LinearGradient colors={['#7C3AED', '#A78BFA']} style={{ width: 74, height: 74, borderRadius: 37, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: 34 }}>🎥</Text>
                  </LinearGradient>
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>Video Call</Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>
    </LinearGradient>
  );
}

export default function CallsScreen() {
  return (
    <ErrorBoundary fallbackTitle="Calls Error" fallbackMessage="The calls screen had a problem. Other features still work.">
      <CallsContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 50, paddingBottom: 12, gap: 10 },
  title: { color: '#fff', fontSize: 22, fontWeight: '900' },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#0A1628', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#0D1E3A' },
  newCallBtn: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1D4ED8' },
  activeCallBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 18, marginBottom: 12, borderRadius: 16, padding: 14, borderWidth: 1.5 },
  returnBtn: { backgroundColor: '#0A1628', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  endBanner: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center' },
  statsRow: { flexDirection: 'row', paddingHorizontal: 14, gap: 8, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: '#0A1628', borderRadius: 14, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#0D1E3A' },
  newCallCard: { borderRadius: 20, padding: 20, flexDirection: 'row', alignItems: 'center' },
  section: { paddingHorizontal: 18 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '900' },
  emptyCard: { backgroundColor: '#0A1628', borderRadius: 18, padding: 40, alignItems: 'center', borderWidth: 1, borderColor: '#0D1E3A' },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0A1628', borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#0D1E3A', gap: 12 },
  callIconBox: { width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  anonBadge: { backgroundColor: '#2D1B69', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
});
