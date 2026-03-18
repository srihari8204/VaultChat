// @ts-nocheck
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const FEATURES = [
  'Military-grade encryption',
  'Biometric authentication',
  'Zero data collection',
  'On-device AI processing',
];

function WelcomeContent() {
  const router = useRouter();

  // Animation values
  const logoFade = useRef(new Animated.Value(0)).current;
  const logoSlide = useRef(new Animated.Value(30)).current;
  const titleFade = useRef(new Animated.Value(0)).current;
  const titleSlide = useRef(new Animated.Value(30)).current;
  const featuresFade = useRef(new Animated.Value(0)).current;
  const featuresSlide = useRef(new Animated.Value(30)).current;
  const btnFade = useRef(new Animated.Value(0)).current;
  const btnSlide = useRef(new Animated.Value(30)).current;
  const disclaimerFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const springConfig = { tension: 50, friction: 9, useNativeDriver: true };

    // Staggered entrance animations
    Animated.sequence([
      // Logo
      Animated.parallel([
        Animated.spring(logoSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(logoFade, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    ]).start();

    // Title - 200ms delay
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(titleSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(titleFade, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start();
    }, 200);

    // Features - 400ms delay
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(featuresSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(featuresFade, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start();
    }, 400);

    // Buttons - 600ms delay
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(btnSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(btnFade, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]).start();
    }, 600);

    // Disclaimer - 800ms delay
    setTimeout(() => {
      Animated.timing(disclaimerFade, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    }, 800);
  }, []);

  return (
    <View style={S.container}>
      {/* Logo section */}
      <View style={S.topSection}>
        <Animated.View style={[S.logoArea, { opacity: logoFade, transform: [{ translateY: logoSlide }] }]}>
          {/* Shield icon built from View */}
          <View style={S.shieldOuter}>
            <View style={S.shieldInner}>
              <View style={S.shieldCheck}>
                <View style={S.checkLong} />
                <View style={S.checkShort} />
              </View>
            </View>
          </View>
        </Animated.View>

        <Animated.View style={[S.titleArea, { opacity: titleFade, transform: [{ translateY: titleSlide }] }]}>
          <Text style={S.appName}>VaultChat</Text>
          <Text style={S.tagline}>Private messaging, redefined</Text>
        </Animated.View>
      </View>

      {/* Features list */}
      <Animated.View style={[S.featuresSection, { opacity: featuresFade, transform: [{ translateY: featuresSlide }] }]}>
        {FEATURES.map((feature, index) => (
          <View key={index}>
            <View style={S.featureRow}>
              <View style={S.featureDot} />
              <Text style={S.featureText}>{feature}</Text>
            </View>
            {index < FEATURES.length - 1 && <View style={S.featureDivider} />}
          </View>
        ))}
      </Animated.View>

      {/* Buttons section */}
      <Animated.View style={[S.btnSection, { opacity: btnFade, transform: [{ translateY: btnSlide }] }]}>
        <TouchableOpacity
          onPress={() => router.push('/signup' as any)}
          style={S.btnPrimary}
          activeOpacity={0.85}
        >
          <Text style={S.btnPrimaryText}>Create Account</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.push('/login' as any)}
          style={S.btnSecondary}
          activeOpacity={0.7}
        >
          <Text style={S.btnSecondaryText}>Sign In</Text>
        </TouchableOpacity>

        <Animated.View style={{ opacity: disclaimerFade }}>
          <Text style={S.disclaimer}>
            By continuing, you agree to our Terms of Service{'\n'}and Privacy Policy. Your data never leaves your device.
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
  container: {
    flex: 1,
    backgroundColor: '#000000',
    paddingHorizontal: 28,
    paddingTop: 80,
    paddingBottom: 48,
  },

  // Top section
  topSection: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoArea: {
    marginBottom: 32,
  },
  shieldOuter: {
    width: 72,
    height: 82,
    borderRadius: 36,
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 4,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shieldInner: {
    width: 56,
    height: 64,
    borderRadius: 28,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shieldCheck: {
    width: 20,
    height: 14,
    position: 'relative',
  },
  checkLong: {
    position: 'absolute',
    bottom: 0,
    left: 2,
    width: 18,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.8)',
    transform: [{ rotate: '-45deg' }],
  },
  checkShort: {
    position: 'absolute',
    bottom: 2,
    left: 0,
    width: 10,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.8)',
    transform: [{ rotate: '45deg' }],
  },

  titleArea: {
    alignItems: 'center',
  },
  appName: {
    color: '#FFFFFF',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 3,
    textAlign: 'center',
  },
  tagline: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontWeight: '400',
    letterSpacing: 1,
    marginTop: 10,
    textAlign: 'center',
  },

  // Features
  featuresSection: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 20,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 18,
  },
  featureDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255,255,255,0.35)',
    marginRight: 16,
  },
  featureText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
  featureDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },

  // Buttons
  btnSection: {
    gap: 14,
  },
  btnPrimary: {
    backgroundColor: '#FFFFFF',
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  btnSecondary: {
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'transparent',
  },
  btnSecondaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  disclaimer: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 10,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 8,
    letterSpacing: 0.2,
  },
});
