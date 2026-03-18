import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Dimensions, Easing, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { BehaviorAlert, TypingPattern, analyzeTypingPattern, getAlertColor, getAlertIcon, loadAlerts, loadTypingPattern, recordKeystroke, resetPattern } from '../constants/behavioralSecurity';

const { width } = Dimensions.get('window');

function BehavioralScreenContent() {
  const router = useRouter();
  const [pattern, setPattern] = useState<TypingPattern | null>(null);
  const [alerts, setAlerts] = useState<BehaviorAlert[]>([]);
  const [lastAlert, setLastAlert] = useState<BehaviorAlert | null>(null);
  const [testInput, setTestInput] = useState('');
  const [keyCount, setKeyCount] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const fadeIn = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const brainAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.05, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1.00, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ])).start();
    Animated.loop(Animated.timing(brainAnim, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true })).start();
    load();
  }, []);

  const load = async () => {
    const p = await loadTypingPattern();
    const a = await loadAlerts();
    setPattern(p);
    setAlerts(a);
  };

  const handleKeyPress = async (text: string) => {
    setTestInput(text);
    recordKeystroke();
    setKeyCount(text.length);
    if (text.length > 0 && text.length % 10 === 0) {
      setIsAnalyzing(true);
      const result = await analyzeTypingPattern();
      setLastAlert(result);
      setAlerts(prev => [result, ...prev].slice(0, 20));
      const p = await loadTypingPattern();
      setPattern(p);
      setIsAnalyzing(false);
    }
  };

  const handleReset = () => {
    Alert.alert('Reset Pattern', 'This will delete your baseline typing pattern.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => { await resetPattern(); setPattern(null); setAlerts([]); setLastAlert(null); setKeyCount(0); setTestInput(''); } },
    ]);
  };

  const alertColor = lastAlert ? getAlertColor(lastAlert.type) : '#1D4ED8';
  const brainRotate = brainAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <LinearGradient colors={['#020B18', '#040F20', '#060F24']} style={{ flex: 1 }}>
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <ScrollView contentContainerStyle={S.container}>
          <View style={S.header}>
            <TouchableOpacity onPress={() => router.back()} style={S.backBtn}>
              <Text style={{ color: '#4A9FFF', fontSize: 18 }}>←</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={S.title}>AI Behavioral Security</Text>
              <Text style={{ color: '#3D5A7A', fontSize: 9, letterSpacing: 1.5 }}>KEYSTROKE DYNAMICS</Text>
            </View>
          </View>

          <Animated.View style={[S.brainCard, { transform: [{ scale: pulseAnim }] }]}>
            <LinearGradient colors={['#0D1E3A', '#0A1628']} style={S.brainInner}>
              <Animated.View style={[S.brainRing, { transform: [{ rotate: brainRotate }] }]} />
              <Text style={{ fontSize: 60, marginBottom: 8 }}>🧠</Text>
              <Text style={{ color: '#4A9FFF', fontSize: 18, fontWeight: '900' }}>BEHAVIORAL AI</Text>
              <Text style={{ color: '#3D5A7A', fontSize: 11, marginTop: 4, textAlign: 'center' }}>
                {pattern ? ('Trained on ' + pattern.sessionCount + ' sessions') : 'Not yet trained'}
              </Text>
              <View style={[S.statusPill, { backgroundColor: pattern ? '#052E16' : '#1a0000', borderColor: pattern ? '#166534' : '#7F1D1D' }]}>
                <View style={[S.statusDot, { backgroundColor: pattern ? '#10B981' : '#EF4444' }]} />
                <Text style={{ color: pattern ? '#10B981' : '#EF4444', fontSize: 11, fontWeight: '700' }}>
                  {pattern ? 'AI TRAINED' : 'NEEDS TRAINING'}
                </Text>
              </View>
            </LinearGradient>
          </Animated.View>

          {lastAlert && (
            <View style={[S.alertBanner, { backgroundColor: alertColor + '22', borderColor: alertColor }]}>
              <Text style={{ fontSize: 20 }}>{lastAlert.type === 'imposter' ? '🚨' : lastAlert.type === 'unusual' ? '⚠️' : '✅'}</Text>
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={{ color: alertColor, fontSize: 13, fontWeight: '900' }}>{getAlertIcon(lastAlert.type)}</Text>
                <Text style={{ color: '#3D5A7A', fontSize: 11, marginTop: 2 }}>{lastAlert.confidence}% confidence</Text>
              </View>
            </View>
          )}

          <View style={S.testCard}>
            <Text style={S.cardTitle}>Type to Train the AI</Text>
            <Text style={{ color: '#3D5A7A', fontSize: 12, marginBottom: 12, lineHeight: 18 }}>Type naturally. The AI learns your unique keystroke rhythm and detects imposters.</Text>
            <TextInput value={testInput} onChangeText={handleKeyPress} placeholder="Start typing here to train the AI..." placeholderTextColor="#1D2D44" multiline style={S.testInput} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={{ color: '#3D5A7A', fontSize: 11 }}>{'Keystrokes: ' + keyCount}</Text>
              <Text style={{ color: isAnalyzing ? '#A78BFA' : '#3D5A7A', fontSize: 11, fontWeight: isAnalyzing ? '700' : '400' }}>
                {isAnalyzing ? 'Analyzing...' : 'Next at ' + (Math.ceil((keyCount + 1) / 10) * 10) + ' keys'}
              </Text>
            </View>
            <View style={{ marginTop: 10, height: 4, backgroundColor: '#0A1628', borderRadius: 2 }}>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: alertColor, width: (((keyCount % 10) / 10 * 100) + '%') as any}} />
            </View>
          </View>

          {pattern && (
            <View style={S.metricsCard}>
              <Text style={S.cardTitle}>Your Biometric Profile</Text>
              {[
                { label: 'Average Typing Speed', value: Math.floor(pattern.avgSpeed) + 'ms per key', icon: '⚡' },
                { label: 'Training Sessions', value: pattern.sessionCount.toString(), icon: '🎯' },
                { label: 'Rhythm Samples', value: pattern.rhythm.length.toString(), icon: '📊' },
                { label: 'Pause Patterns', value: pattern.pausePattern.length.toString(), icon: '⏸️' },
              ].map((m, i) => (
                <View key={i} style={S.metricRow}>
                  <Text style={{ fontSize: 16, width: 28 }}>{m.icon}</Text>
                  <Text style={{ color: '#3D5A7A', fontSize: 12, flex: 1 }}>{m.label}</Text>
                  <Text style={{ color: '#4A9FFF', fontSize: 13, fontWeight: '700' }}>{m.value}</Text>
                </View>
              ))}
            </View>
          )}

          {alerts.length > 0 && (
            <View style={S.historyCard}>
              <Text style={S.cardTitle}>Alert History</Text>
              {alerts.slice(0, 8).map((a, i) => (
                <View key={i} style={[S.historyRow, { borderLeftColor: getAlertColor(a.type) }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: getAlertColor(a.type), fontSize: 11, fontWeight: '800' }}>{getAlertIcon(a.type)}</Text>
                    <Text style={{ color: '#3D5A7A', fontSize: 10, marginTop: 2 }}>{new Date(a.timestamp).toLocaleTimeString()}</Text>
                  </View>
                  <Text style={{ color: getAlertColor(a.type), fontSize: 13, fontWeight: '700' }}>{a.confidence + '%'}</Text>
                </View>
              ))}
            </View>
          )}

          <TouchableOpacity onPress={handleReset} style={S.resetBtn}>
            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '700' }}>Reset AI Training Data</Text>
          </TouchableOpacity>

          <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={{ borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginBottom: 20 }} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }}>AI BEHAVIORAL SECURITY · KEYSTROKE DYNAMICS · WORLD FIRST</Text>
          </LinearGradient>
        </ScrollView>
      </Animated.View>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container: { paddingHorizontal: 18, paddingTop: 50, paddingBottom: 20 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#0A1628', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#0D1E3A' },
  title: { color: '#fff', fontSize: 18, fontWeight: '900' },
  brainCard: { marginBottom: 16, borderRadius: 24 },
  brainInner: { borderRadius: 24, padding: 28, alignItems: 'center', borderWidth: 1.5, borderColor: '#0D1E3A', overflow: 'hidden' },
  brainRing: { position: 'absolute', width: 240, height: 240, borderRadius: 120, borderWidth: 1, borderColor: 'rgba(29,78,216,0.2)', borderStyle: 'dashed' },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1, marginTop: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  alertBanner: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1.5 },
  testCard: { backgroundColor: '#0A1628', borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#0D1E3A' },
  cardTitle: { color: '#fff', fontSize: 14, fontWeight: '800', marginBottom: 12 },
  testInput: { backgroundColor: '#060E22', borderRadius: 14, padding: 14, color: '#fff', fontSize: 14, borderWidth: 1.5, borderColor: '#0D1E3A', minHeight: 100, textAlignVertical: 'top' },
  metricsCard: { backgroundColor: '#0A1628', borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#0D1E3A' },
  metricRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#060E22', gap: 8 },
  historyCard: { backgroundColor: '#0A1628', borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#0D1E3A' },
  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderLeftWidth: 3, paddingLeft: 10, marginBottom: 4 },
  resetBtn: { backgroundColor: '#3B0A0A', borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#7F1D1D', marginBottom: 14 },
});

export default function BehavioralScreen() {
  return (
    <ErrorBoundary fallbackTitle="AI Guard Error" fallbackMessage="AI Guard had a problem. Other features still work.">
      <BehavioralScreenContent />
    </ErrorBoundary>
  );
}
