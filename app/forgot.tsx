import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = {
  bg: '#FFFFFF', primary: '#4A9FFF', secondary: '#7C3AED',
  accent: '#10B981', warning: '#F59E0B',
  textDim: 'rgba(255,255,255,0.5)', textFaint: 'rgba(255,255,255,0.22)',
};

function ForgotContent() {
  const router = useRouter();
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  const STEPS = [
    { n: '1', icon: '&#128737;', label: 'Verify Identity', desc: 'Answer 2 of your recovery security questions', color: C.warning },
    { n: '2', icon: '&#9993;',   label: 'Get Reset Link',  desc: 'A secure link is sent to your registered email', color: C.primary },
    { n: '3', icon: '&#128274;', label: 'Create Password', desc: 'Set a new strong password for your account', color: C.accent },
    { n: '4', icon: '&#128065;', label: 'Face Scan',       desc: 'Re-verify your identity with biometrics', color: '#A78BFA' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#FFFFFF','#FFFFFF','#040F20']} style={S.fill} />
      <View style={{ position: 'absolute', top: -60, alignSelf: 'center', width: 300, height: 300, borderRadius: 150, backgroundColor: 'rgba(245,158,11,0.04)' }} />

      <Animated.View style={{ flex: 1, paddingHorizontal: 24, opacity: fadeAnim }}>
        <TouchableOpacity onPress={() => router.back()} style={[S.backBtn, { marginTop: 54 }]}>
          <Text style={{ color: C.primary, fontSize: 18 }}>&#8592;</Text>
        </TouchableOpacity>

        <Animated.View style={{ transform: [{ translateY: slideAnim }], marginTop: 28 }}>
          <View style={{ alignItems: 'center', gap: 12, marginBottom: 36 }}>
            <View style={S.iconWrap}>
              <Text style={{ fontSize: 40 }}>&#128274;</Text>
            </View>
            <Text style={S.title}>Reset Password</Text>
            <Text style={{ color: C.textDim, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
              For your security, identity verification is required before resetting your password.
            </Text>
          </View>

          <Text style={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, fontWeight: '800', letterSpacing: 2, marginBottom: 16 }}>RESET PROCESS</Text>

          <View style={{ gap: 10, marginBottom: 32 }}>
            {STEPS.map((s, i) => (
              <View key={i} style={[S.stepCard, { borderLeftColor: s.color }]}>
                <View style={[S.stepNum, { backgroundColor: s.color + '18', borderColor: s.color + '55' }]}>
                  <Text style={{ fontSize: 18 }}>{s.icon}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{s.label}</Text>
                  <Text style={{ color: C.textFaint, fontSize: 11, marginTop: 2 }}>{s.desc}</Text>
                </View>
                <Text style={{ color: s.color, fontSize: 11, fontWeight: '800' }}>Step {s.n}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity onPress={() => router.push('/recovery')}>
            <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.bigBtn}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>&#128737; Start Identity Verification</Text>
            </LinearGradient>
          </TouchableOpacity>

          <View style={{ backgroundColor: 'rgba(74,159,255,0.06)', borderRadius: 14, padding: 14, marginTop: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.18)' }}>
            <Text style={{ color: C.textFaint, fontSize: 11, textAlign: 'center', lineHeight: 18 }}>
              Your recovery answers are hashed and encrypted. You have 3 attempts before a 30 second cooldown.
            </Text>
          </View>

          <TouchableOpacity onPress={() => router.back()} style={{ alignItems: 'center', marginTop: 20 }}>
            <Text style={{ color: C.textFaint, fontSize: 13 }}>Back to Login</Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

export default function ForgotScreen() {
  return (
    <ErrorBoundary fallbackTitle="Reset Error" fallbackMessage="Password reset had a problem.">
      <ForgotContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  iconWrap: { width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(74,159,255,0.1)', borderWidth: 2, borderColor: 'rgba(74,159,255,0.35)', justifyContent: 'center', alignItems: 'center' },
  title: { color: '#fff', fontSize: 26, fontWeight: '900' },
  stepCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 14, padding: 14, gap: 12, borderLeftWidth: 3 },
  stepNum: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  bigBtn: { borderRadius: 18, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
});
