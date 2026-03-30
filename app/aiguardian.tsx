import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
    Alert, Animated,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

const THREAT_EVENTS = [
  { id: '1', time: '2 min ago',  icon: '✅', type: 'Normal Login',        detail: 'Yanamalakuduru · Recognised device',  color: '#22C55E', bg: '#052e16' },
  { id: '2', time: '1 hr ago',   icon: '⚠️', type: 'New Device Detected', detail: 'Samsung Galaxy · First time login',    color: '#F59E0B', bg: '#451a03' },
  { id: '3', time: '3 hrs ago',  icon: '✅', type: 'Message Sent',        detail: '12 messages · All encrypted',          color: '#22C55E', bg: '#052e16' },
  { id: '4', time: 'Yesterday',  icon: '✅', type: 'Face Scan Passed',    detail: '468-point match · 99.8% confidence',   color: '#22C55E', bg: '#052e16' },
  { id: '5', time: '2 days ago', icon: '🚨', type: 'Login Attempt Failed','detail': 'Wrong Face · 3 attempts blocked',   color: '#EF4444', bg: '#450a0a' },
];

const AI_FEATURES = [
  { icon: '🧠', title: 'Behavior Analysis',     desc: 'Learns your typing & usage patterns', active: true  },
  { icon: '👁️', title: 'Anomaly Detection',     desc: 'Flags unusual login times or locations', active: true  },
  { icon: '📍', title: 'Location Intelligence', desc: 'Recognises your trusted locations',    active: true  },
  { icon: '📱', title: 'Device Fingerprinting', desc: 'Identifies trusted devices',           active: true  },
  { icon: '⏰', title: 'Time Pattern Guard',    desc: 'Detects logins at unusual hours',      active: false },
  { icon: '🤖', title: 'AI Impersonation Guard','desc': 'Detects if someone cloned your style',active: false },
];

export default function AIGuardianScreen() {
  const router = useRouter();
  const [aiScore]      = useState(97);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzed,    setAnalyzed]    = useState(false);

  const pulseAnim  = useRef(new Animated.Value(1)).current;
  const brainAnim  = useRef(new Animated.Value(0)).current;
  const scoreAnim  = useRef(new Animated.Value(0)).current;
  const glowAnim   = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    // Pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 1400, useNativeDriver: true }),
      ])
    ).start();
    // Glow
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 0.8, duration: 2000, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.3, duration: 2000, useNativeDriver: true }),
      ])
    ).start();
    // Score count up
    Animated.timing(scoreAnim, { toValue: aiScore, duration: 1500, useNativeDriver: false }).start();
  }, [aiScore, glowAnim, pulseAnim, scoreAnim]);

  const runAnalysis = () => {
    setIsAnalyzing(true);
    setAnalyzed(false);
    Animated.loop(
      Animated.timing(brainAnim, { toValue: 1, duration: 800, useNativeDriver: true })
    ).start();
    setTimeout(() => {
      setIsAnalyzing(false);
      setAnalyzed(true);
      brainAnim.stopAnimation();
      Alert.alert(
        '🧠 AI Analysis Complete!',
        '✅ No threats detected\n✅ Behaviour matches your profile\n✅ All devices trusted\n✅ Location recognised\n\nAI Security Score: 97/100 — Excellent!',
        [{ text: 'Great! 🛡️' }]
      );
    }, 3000);
  };

  const brainRotate = brainAnim.interpolate({
    inputRange: [0, 1], outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.container}>

      {/* ── HEADER ─────────────────────────────────── */}
      <LinearGradient colors={['#030A18', '#050D1F']} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>🤖 AI Guardian</Text>
          <Text style={styles.headerSub}>Behavioral Security · World-First 🏆</Text>
        </View>
        <View style={{ width: 50 }} />
      </LinearGradient>

      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── AI SCORE HERO ──────────────────────────── */}
        <LinearGradient
          colors={['#0D1E3A', '#050D1F']}
          style={styles.heroCard}
        >
          {/* Glow behind brain */}
          <Animated.View style={[styles.heroGlow, { opacity: glowAnim }]} />

          {/* Brain pulse */}
          <Animated.View style={[styles.brainWrap, { transform: [{ scale: pulseAnim }] }]}>
            <LinearGradient
              colors={['#1D4ED8', '#7C3AED']}
              style={styles.brainCircle}
            >
              <Text style={styles.brainEmoji}>🧠</Text>
            </LinearGradient>
          </Animated.View>

          <Text style={styles.heroTitle}>AI Security Score</Text>

          {/* Score ring */}
          <View style={styles.scoreRingWrap}>
            <LinearGradient
              colors={['#1D4ED8', '#7C3AED']}
              style={styles.scoreRingOuter}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              <View style={styles.scoreRingInner}>
                <Text style={styles.scoreNumber}>{aiScore}</Text>
                <Text style={styles.scoreMax}>/100</Text>
              </View>
            </LinearGradient>
          </View>

          <View style={styles.heroStatusRow}>
            <View style={styles.heroDot} />
            <Text style={styles.heroStatus}>AI Guardian Active · Monitoring in real-time</Text>
          </View>

          {/* Stats row */}
          <View style={styles.heroStats}>
            {[
              { val: '0',   label: 'Threats',  color: '#22C55E' },
              { val: '127', label: 'Events',   color: '#4A9FFF' },
              { val: '99%', label: 'Accuracy', color: '#A78BFA' },
            ].map((s, i) => (
              <View key={i} style={styles.heroStat}>
                <Text style={[styles.heroStatVal, { color: s.color }]}>{s.val}</Text>
                <Text style={styles.heroStatLabel}>{s.label}</Text>
              </View>
            ))}
          </View>
        </LinearGradient>

        {/* ── ANALYZE NOW BUTTON ─────────────────────── */}
        <View style={styles.analyzeSection}>
          <TouchableOpacity onPress={runAnalysis} disabled={isAnalyzing} activeOpacity={0.85}>
            <LinearGradient
              colors={isAnalyzing ? ['#0F1729', '#0F1729'] : ['#1D4ED8', '#7C3AED']}
              style={styles.analyzeBtn}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              {isAnalyzing ? (
                <>
                  <Animated.Text style={[styles.analyzeBtnIcon,
                    { transform: [{ rotate: brainRotate }] }]}>
                    🧠
                  </Animated.Text>
                  <Text style={styles.analyzeBtnText}>AI Analyzing...</Text>
                </>
              ) : (
                <>
                  <Text style={styles.analyzeBtnIcon}>🤖</Text>
                  <Text style={styles.analyzeBtnText}>
                    {analyzed ? 'Run Again' : 'Run AI Security Scan'}
                  </Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── RECENT EVENTS ──────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📋 SECURITY EVENTS</Text>
          {THREAT_EVENTS.map(event => (
            <TouchableOpacity
              key={event.id}
              style={styles.eventCard}
              onPress={() => Alert.alert(event.type, `${event.detail}\n\nTime: ${event.time}`)}
              activeOpacity={0.7}
            >
              <LinearGradient
                colors={[event.bg, '#030A18']}
                style={styles.eventCardInner}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              >
                <View style={[styles.eventIconBox, { backgroundColor: event.color + '20' }]}>
                  <Text style={styles.eventIcon}>{event.icon}</Text>
                </View>
                <View style={styles.eventInfo}>
                  <Text style={styles.eventType}>{event.type}</Text>
                  <Text style={styles.eventDetail}>{event.detail}</Text>
                </View>
                <Text style={styles.eventTime}>{event.time}</Text>
              </LinearGradient>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── AI FEATURES ────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🤖 AI CAPABILITIES</Text>
          <View style={styles.card}>
            {AI_FEATURES.map((feature, i) => (
              <View key={i}>
                <View style={styles.featureRow}>
                  <View style={[styles.featureIconBox,
                    { backgroundColor: feature.active ? '#0D2A5A' : '#0D1E3A' }]}>
                    <Text style={styles.featureIcon}>{feature.icon}</Text>
                  </View>
                  <View style={styles.featureInfo}>
                    <Text style={styles.featureTitle}>{feature.title}</Text>
                    <Text style={styles.featureDesc}>{feature.desc}</Text>
                  </View>
                  <View style={[styles.featureStatusBadge,
                    { backgroundColor: feature.active ? '#052e16' : '#0D1E3A' }]}>
                    <Text style={[styles.featureStatus,
                      { color: feature.active ? '#22C55E' : '#2D4A6B' }]}>
                      {feature.active ? '✅ ON' : '○ OFF'}
                    </Text>
                  </View>
                </View>
                {i < AI_FEATURES.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </View>
        </View>

        {/* ── HOW IT WORKS ───────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>💡 HOW AI GUARDIAN WORKS</Text>
          <LinearGradient
            colors={['#F9FAFB', '#0D1E3A']}
            style={styles.howCard}
          >
            {[
              { step: '1', text: 'AI learns your normal usage patterns over 7 days' },
              { step: '2', text: 'Every login is compared against your behaviour profile' },
              { step: '3', text: 'Anomalies trigger instant alerts and can block access' },
              { step: '4', text: 'Score updates in real-time based on threat events' },
            ].map((item, i) => (
              <View key={i} style={[styles.howRow, i > 0 && { marginTop: 12 }]}>
                <LinearGradient
                  colors={['#1D4ED8', '#7C3AED']}
                  style={styles.howStepCircle}
                >
                  <Text style={styles.howStepNum}>{item.step}</Text>
                </LinearGradient>
                <Text style={styles.howText}>{item.text}</Text>
              </View>
            ))}
          </LinearGradient>
        </View>

        {/* ── WORLD FIRST BADGE ──────────────────────── */}
        <LinearGradient
          colors={['#1D4ED8', '#7C3AED']}
          style={styles.worldFirstBadge}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        >
          <Text style={styles.worldFirstEmoji}>🏆</Text>
          <View>
            <Text style={styles.worldFirstTitle}>World-First Feature</Text>
            <Text style={styles.worldFirstSub}>
              No other messenger has AI behavioral security built in
            </Text>
          </View>
        </LinearGradient>

        <View style={{ height: 50 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#030A18' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54, paddingBottom: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: '#0D1E3A',
  },
  backBtn: { padding: 6 },
  backArrow: { color: '#4A9FFF', fontSize: 26, fontWeight: '300' },
  headerTitle: { color: '#000000', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  headerSub:   { color: '#2D4A6B', fontSize: 11, textAlign: 'center' },

  // HERO CARD
  heroCard: {
    margin: 16, borderRadius: 24, padding: 24,
    alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: '#0D1E3A',
    overflow: 'hidden',
  },
  heroGlow: {
    position: 'absolute', width: 200, height: 200,
    borderRadius: 100, backgroundColor: '#1D4ED8',
    top: -40,
  },
  brainWrap: {},
  brainCircle: {
    width: 80, height: 80, borderRadius: 40,
    justifyContent: 'center', alignItems: 'center',
    elevation: 12, shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6, shadowRadius: 12,
  },
  brainEmoji: { fontSize: 36 },
  heroTitle:  { color: '#000000', fontSize: 16, fontWeight: '700' },

  scoreRingWrap: {},
  scoreRingOuter: {
    width: 110, height: 110, borderRadius: 55,
    justifyContent: 'center', alignItems: 'center',
    elevation: 10, shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5, shadowRadius: 10,
  },
  scoreRingInner: {
    width: 94, height: 94, borderRadius: 47,
    backgroundColor: '#030A18',
    justifyContent: 'center', alignItems: 'center',
  },
  scoreNumber: { color: '#000000', fontSize: 32, fontWeight: '900', lineHeight: 36 },
  scoreMax:    { color: '#2D4A6B', fontSize: 13, textAlign: 'center' },

  heroStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E',
  },
  heroStatus: { color: '#22C55E', fontSize: 11, fontWeight: '600' },

  heroStats: { flexDirection: 'row', gap: 32, marginTop: 4 },
  heroStat:  { alignItems: 'center', gap: 4 },
  heroStatVal:   { fontSize: 22, fontWeight: '900' },
  heroStatLabel: { color: '#2D4A6B', fontSize: 11, fontWeight: '600' },

  // ANALYZE BUTTON
  analyzeSection: { paddingHorizontal: 16, marginBottom: 20, alignItems: 'center' },
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 32, paddingVertical: 16, borderRadius: 20,
    elevation: 8, shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5, shadowRadius: 10,
  },
  analyzeBtnIcon: { fontSize: 22 },
  analyzeBtnText: { color: '#000000', fontSize: 16, fontWeight: '800' },

  // SECTIONS
  section: { marginHorizontal: 16, marginBottom: 20 },
  sectionTitle: {
    color: '#2D4A6B', fontSize: 11, fontWeight: '800',
    letterSpacing: 1, marginBottom: 10, marginLeft: 4,
  },
  card: {
    backgroundColor: '#F9FAFB', borderRadius: 16,
    borderWidth: 1, borderColor: '#0D1E3A', overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: '#0D1E3A', marginLeft: 56 },

  // EVENT CARDS
  eventCard: { marginBottom: 8 },
  eventCardInner: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: 14, gap: 12,
    borderWidth: 1, borderColor: '#0D1E3A',
  },
  eventIconBox: {
    width: 40, height: 40, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
  },
  eventIcon:   { fontSize: 20 },
  eventInfo:   { flex: 1 },
  eventType:   { color: '#000000', fontSize: 13, fontWeight: '700' },
  eventDetail: { color: '#3D5A7A', fontSize: 11, marginTop: 2 },
  eventTime:   { color: '#2D4A6B', fontSize: 10 },

  // FEATURES
  featureRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12, gap: 12,
  },
  featureIconBox: {
    width: 36, height: 36, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
  },
  featureIcon:  { fontSize: 18 },
  featureInfo:  { flex: 1 },
  featureTitle: { color: '#000000', fontSize: 13, fontWeight: '600' },
  featureDesc:  { color: '#3D5A7A', fontSize: 11, marginTop: 2 },
  featureStatusBadge: {
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  featureStatus: { fontSize: 11, fontWeight: '700' },

  // HOW IT WORKS
  howCard: {
    borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: '#0D1E3A',
  },
  howRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  howStepCircle: {
    width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    flexShrink: 0,
  },
  howStepNum: { color: '#000000', fontSize: 13, fontWeight: '800' },
  howText:    { color: '#4A6B8A', fontSize: 13, lineHeight: 20, flex: 1 },

  // WORLD FIRST
  worldFirstBadge: {
    marginHorizontal: 16, marginBottom: 16,
    borderRadius: 16, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  worldFirstEmoji: { fontSize: 36 },
  worldFirstTitle: { color: '#000000', fontSize: 15, fontWeight: '800' },
  worldFirstSub:   { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
});
