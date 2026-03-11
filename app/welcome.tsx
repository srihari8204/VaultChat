import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

function WelcomeContent() {
  const router = useRouter();

  const fadeAnim   = useRef(new Animated.Value(0)).current;
  const slideAnim  = useRef(new Animated.Value(40)).current;
  const logoScale  = useRef(new Animated.Value(0.7)).current;
  const ring1      = useRef(new Animated.Value(0)).current;
  const ring2      = useRef(new Animated.Value(0)).current;
  const ring3      = useRef(new Animated.Value(0)).current;
  const glowAnim   = useRef(new Animated.Value(0)).current;
  const btnSlide   = useRef(new Animated.Value(60)).current;
  const btnFade    = useRef(new Animated.Value(0)).current;
  const orbitAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 800, useNativeDriver: true }),
      Animated.spring(logoScale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]).start();

    setTimeout(() => {
      Animated.parallel([
        Animated.timing(btnSlide, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(btnFade,  { toValue: 1, duration: 500, useNativeDriver: true }),
      ]).start();
    }, 600);

    // Pulsing rings
    const pulseRing = (anim: Animated.Value, delay: number) => {
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 2200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])).start();
    };
    pulseRing(ring1, 0);
    pulseRing(ring2, 700);
    pulseRing(ring3, 1400);

    // Glow pulse
    Animated.loop(Animated.sequence([
      Animated.timing(glowAnim, { toValue: 1, duration: 2000, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 2000, useNativeDriver: false }),
    ])).start();

    // Orbit
    Animated.loop(Animated.timing(orbitAnim, { toValue: 1, duration: 8000, easing: Easing.linear, useNativeDriver: true })).start();
  }, []);

  const ring1Scale   = ring1.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ring1Opacity = ring1.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.4, 0] });
  const ring2Scale   = ring2.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ring2Opacity = ring2.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.35, 0] });
  const ring3Scale   = ring3.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ring3Opacity = ring3.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.3, 0] });
  const glowColor    = glowAnim.interpolate({ inputRange: [0, 1], outputRange: ['rgba(74,159,255,0.12)', 'rgba(74,159,255,0.28)'] });
  const orbitDeg     = orbitAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const FEATURES = [
    { icon: '🔐', text: 'AES-256 End-to-End Encryption' },
    { icon: '👁️', text: '3D Biometric Face Authentication' },
    { icon: '⛓️', text: 'Blockchain Identity Verification' },
    { icon: '🛡️', text: 'Real-Time Threat Protection' },
  ];

  return (
    <View style={S.container}>
      <LinearGradient colors={['#010812', '#020B18', '#040F20']} style={StyleSheet.absoluteFillObject} />

      {/* Background ambient glow */}
      <Animated.View style={[S.ambientGlow, { backgroundColor: glowColor }]} />
      <View style={[S.ambientGlow2]} />

      {/* Grid dots */}
      {Array.from({ length: 30 }).map((_, i) => (
        <View key={i} style={{
          position: 'absolute',
          left: (i % 6) * 70 + 10,
          top: Math.floor(i / 6) * 100 + 20,
          width: 2, height: 2, borderRadius: 1,
          backgroundColor: 'rgba(74,159,255,0.12)',
        }} />
      ))}

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {/* Logo section */}
        <View style={S.logoSection}>
          {/* Pulsing rings */}
          {[
            { scale: ring1Scale, opacity: ring1Opacity },
            { scale: ring2Scale, opacity: ring2Opacity },
            { scale: ring3Scale, opacity: ring3Opacity },
          ].map((r, i) => (
            <Animated.View key={i} style={[S.pulseRing, { transform: [{ scale: r.scale }], opacity: r.opacity }]} />
          ))}

          {/* Orbit ring */}
          <Animated.View style={[S.orbitRing, { transform: [{ rotate: orbitDeg }] }]}>
            <View style={S.orbitDot} />
          </Animated.View>

          {/* Logo */}
          <Animated.View style={[S.logoWrap, { transform: [{ scale: logoScale }] }]}>
            <LinearGradient colors={['rgba(74,159,255,0.25)', 'rgba(124,58,237,0.2)']} style={S.logoGrad}>
              <Text style={S.logoEmoji}>🔐</Text>
            </LinearGradient>
          </Animated.View>

          <Animated.View style={{ transform: [{ translateY: slideAnim }], alignItems: 'center', marginTop: 22, gap: 6 }}>
            <Text style={S.appName}>VaultChat</Text>
            <Text style={S.tagline}>The World's Most Secure Messenger</Text>
          </Animated.View>
        </View>

        {/* Feature pills */}
        <Animated.View style={[S.featuresWrap, { opacity: btnFade, transform: [{ translateY: btnSlide }] }]}>
          {FEATURES.map((f, i) => (
            <View key={i} style={S.featurePill}>
              <Text style={{ fontSize: 14 }}>{f.icon}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600' }}>{f.text}</Text>
            </View>
          ))}
        </Animated.View>

        {/* Buttons */}
        <Animated.View style={[S.btnSection, { opacity: btnFade, transform: [{ translateY: btnSlide }] }]}>
          <TouchableOpacity onPress={() => router.push('/signup' as any)} style={S.btnPrimary}>
            <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={S.btnGrad}>
              <Text style={S.btnPrimaryText}>Create Secure Account</Text>
              <Text style={{ fontSize: 18 }}>→</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.push('/login' as any)} style={S.btnSecondary}>
            <Text style={S.btnSecondaryText}>Sign In to Existing Account</Text>
          </TouchableOpacity>

          <Text style={S.disclaimer}>
            Protected by AES-256 encryption · Zero data collection{'\n'}
            Your privacy is non-negotiable.
          </Text>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export default function WelcomeScreen() {
  return (
    <ErrorBoundary fallbackTitle="Welcome Error" fallbackMessage="Welcome screen had a problem.">
      <WelcomeContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#010812' },
  ambientGlow: { position: 'absolute', top: -100, alignSelf: 'center', width: 400, height: 400, borderRadius: 200 },
  ambientGlow2: { position: 'absolute', bottom: 0, left: -80, width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(124,58,237,0.06)' },
  logoSection: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  pulseRing: { position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.5)' },
  orbitRing: { position: 'absolute', width: 160, height: 160, borderRadius: 80, borderWidth: 1, borderColor: 'rgba(74,159,255,0.1)', justifyContent: 'flex-start', alignItems: 'center' },
  orbitDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4A9FFF', marginTop: -4 },
  logoWrap: { width: 100, height: 100, borderRadius: 50, overflow: 'hidden', borderWidth: 2, borderColor: 'rgba(74,159,255,0.4)' },
  logoGrad: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  logoEmoji: { fontSize: 46 },
  appName: { color: '#FFFFFF', fontSize: 36, fontWeight: '900', letterSpacing: -0.5 },
  tagline: { color: 'rgba(255,255,255,0.38)', fontSize: 12, fontWeight: '500', textAlign: 'center', letterSpacing: 0.5 },
  featuresWrap: { paddingHorizontal: 24, gap: 8, marginBottom: 28 },
  featurePill: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(10,22,40,0.7)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: 'rgba(74,159,255,0.1)' },
  btnSection: { paddingHorizontal: 24, paddingBottom: 48, gap: 12 },
  btnPrimary: { borderRadius: 18, overflow: 'hidden' },
  btnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 18, gap: 10 },
  btnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '900', letterSpacing: 0.3 },
  btnSecondary: { backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 18, paddingVertical: 16, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.25)' },
  btnSecondaryText: { color: '#4A9FFF', fontSize: 15, fontWeight: '700' },
  disclaimer: { color: 'rgba(255,255,255,0.2)', fontSize: 10, textAlign: 'center', lineHeight: 16, marginTop: 4 },
});
