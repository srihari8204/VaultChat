import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, Easing, KeyboardAvoidingView,
  Platform, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { sendOTP } from './(constants)/authService';

const CODES = [
  { code: '+91',  name: 'India',     flag: '\u{1F1EE}\u{1F1F3}' },
  { code: '+1',   name: 'USA',       flag: '\u{1F1FA}\u{1F1F8}' },
  { code: '+44',  name: 'UK',        flag: '\u{1F1EC}\u{1F1E7}' },
];

export default function LoginScreen() {
  const router = useRouter();
  const [cc, setCc] = useState('+91');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCC, setShowCC] = useState(false);

  const selected = CODES.find(c => c.code === cc) ?? CODES[0];
  const isValid = phone.replace(/\D/g, '').length >= 8;

  // Entrance animations
  const headerFade = useRef(new Animated.Value(0)).current;
  const headerSlide = useRef(new Animated.Value(24)).current;
  const formFade = useRef(new Animated.Value(0)).current;
  const formSlide = useRef(new Animated.Value(24)).current;
  const btnFade = useRef(new Animated.Value(0)).current;
  const btnSlide = useRef(new Animated.Value(24)).current;

  // Loading dot animation
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const springConfig = { tension: 50, friction: 9, useNativeDriver: true };

    Animated.parallel([
      Animated.spring(headerSlide, { ...springConfig, toValue: 0 }),
      Animated.timing(headerFade, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();

    setTimeout(() => {
      Animated.parallel([
        Animated.spring(formSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(formFade, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]).start();
    }, 200);

    setTimeout(() => {
      Animated.parallel([
        Animated.spring(btnSlide, { ...springConfig, toValue: 0 }),
        Animated.timing(btnFade, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]).start();
    }, 400);
  }, [btnFade, btnSlide, formFade, formSlide, headerFade, headerSlide]);

  // Pulsing dots for loading state
  useEffect(() => {
    if (!loading) return;
    const pulseDot = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
    const a1 = pulseDot(dot1, 0);
    const a2 = pulseDot(dot2, 150);
    const a3 = pulseDot(dot3, 300);
    a1.start();
    a2.start();
    a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); dot1.setValue(0.3); dot2.setValue(0.3); dot3.setValue(0.3); };
  }, [loading, dot1, dot2, dot3]);

  const handleSend = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8) {
      Alert.alert('Error', 'Enter a valid mobile number.');
      return;
    }
    setLoading(true);
    try {
      const fullPhone = cc + digits;
      await sendOTP(fullPhone);
      router.push({ pathname: '/otp', params: { phone: fullPhone, flow: 'login' } });
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to send OTP. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={S.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={S.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Back button */}
          <TouchableOpacity
            onPress={() => router.back()}
            style={S.backBtn}
            activeOpacity={0.6}
          >
            <Text style={S.backArrow}>{'\u2190'}</Text>
          </TouchableOpacity>

          {/* Header */}
          <Animated.View style={[S.headerSection, { opacity: headerFade, transform: [{ translateY: headerSlide }] }]}>
            <Text style={S.title}>Welcome{'\n'}back</Text>
            <Text style={S.subtitle}>Enter your number to continue</Text>
          </Animated.View>

          {/* Phone input section */}
          <Animated.View style={[S.formSection, { opacity: formFade, transform: [{ translateY: formSlide }] }]}>
            {/* Country code selector */}
            <TouchableOpacity
              style={S.ccSelector}
              onPress={() => setShowCC(v => !v)}
              activeOpacity={0.7}
            >
              <Text style={S.ccFlag}>{selected.flag}</Text>
              <Text style={S.ccCode}>{cc}</Text>
              <Text style={S.ccChevron}>{showCC ? '\u2303' : '\u2304'}</Text>
            </TouchableOpacity>

            {/* Dropdown */}
            {showCC && (
              <View style={S.dropdown}>
                {CODES.map((c, index) => (
                  <TouchableOpacity
                    key={c.code}
                    style={[S.ddItem, index === CODES.length - 1 && { borderBottomWidth: 0 }]}
                    onPress={() => { setCc(c.code); setShowCC(false); }}
                    activeOpacity={0.6}
                  >
                    <Text style={S.ddFlag}>{c.flag}</Text>
                    <Text style={S.ddName}>{c.name}</Text>
                    <Text style={S.ddCode}>{c.code}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Phone number input */}
            <View style={S.inputWrap}>
              <TextInput
                style={S.phoneInput}
                placeholder="Phone number"
                placeholderTextColor="rgba(3, 3, 3, 0.2)"
                value={phone}
                onChangeText={t => setPhone(t.replace(/\D/g, '').slice(0, 13))}
                keyboardType="phone-pad"
                maxLength={13}
                selectionColor="rgba(255,255,255,0.5)"
              />
              <View style={S.inputLine} />
            </View>
          </Animated.View>

          {/* Continue button */}
          <Animated.View style={[S.btnSection, { opacity: btnFade, transform: [{ translateY: btnSlide }] }]}>
            <TouchableOpacity
              style={[S.btnContinue, !isValid && !loading && S.btnDisabled]}
              onPress={handleSend}
              disabled={loading || !isValid}
              activeOpacity={0.85}
            >
              {loading ? (
                <View style={S.dotsRow}>
                  <Animated.View style={[S.loadingDot, { opacity: dot1 }]} />
                  <Animated.View style={[S.loadingDot, { opacity: dot2 }]} />
                  <Animated.View style={[S.loadingDot, { opacity: dot3 }]} />
                </View>
              ) : (
                <Text style={S.btnText}>Continue</Text>
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Bottom link */}
          <View style={S.bottomLink}>
            <TouchableOpacity onPress={() => router.replace('/signup')} activeOpacity={0.6}>
              <Text style={S.bottomText}>
                New to VaultChat?{'  '}
                <Text style={S.bottomAccent}>Create Account</Text>
              </Text>
            </TouchableOpacity>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const S = StyleSheet.create({
  container: {
    flex: 1,
    backgroundcolor: '#000000',
  },
  scroll: {
    // flexGrow: 1,
    padding:12
    // paddingHorizontal: 28,
    // paddingTop: 60,
    // paddingBottom: 48,
  },

  // Back button
  backBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -8,
    marginBottom: 32,
  },
  backArrow: {
    color: '#000000',
    fontSize: 28,
    fontWeight: '300',
  },

  // Header
  headerSection: {
    marginBottom: 36,
  },
  title: {
    color: '#000000',
    fontSize: 36,
    fontWeight: '800',
    lineHeight: 42,
    letterSpacing: -0.5,
  },
  subtitle: {
    color: 'rgba(0, 0, 0, 0.6)',
    fontSize: 14,
    fontWeight: '400',
    marginTop: 12,
    letterSpacing: 0.3,
  },

  // Form
  formSection: {
    marginBottom: 48,
  },

  // Country code selector
  ccSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 32,
  },
  ccFlag: {
    fontSize: 18,
  },
  ccCode: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '600',
  },
  ccChevron: {
    color: 'rgba(0, 0, 0, 0.6)',
    fontSize: 14,
    marginTop: -2,
  },

  // Dropdown
  dropdown: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.1)',
    marginBottom: 32,
    overflow: 'hidden',
  },
  ddItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.05)',
    gap: 12,
  },
  ddFlag: {
    fontSize: 20,
  },
  ddName: {
    flex: 1,
    color: 'rgba(0, 0, 0, 0.7)',
    fontSize: 15,
    fontWeight: '400',
  },
  ddCode: {
    color: 'rgba(0, 0, 0, 0.4)',
    fontSize: 14,
    fontWeight: '600',
  },

  // Phone input
  inputWrap: {
    marginBottom: 8,
  },
  phoneInput: {
    color: '#000000',
    fontSize: 24,
    fontWeight: '500',
    paddingVertical: 12,
    letterSpacing: 1,
  },
  inputLine: {
    height: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },

  // Continue button
  btnSection: {
    marginBottom: 'auto' as any,
  },
  btnContinue: {
    backgroundcolor: '#000000',
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  btnText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  // Loading dots
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  loadingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundcolor: '#000000',
  },

  // Bottom link
  bottomLink: {
    alignItems: 'center',
    marginTop: 32,
    paddingBottom: 16,
  },
  bottomText: {
    color: 'rgba(0, 0, 0, 0.5)',
    fontSize: 14,
  },
  bottomAccent: {
    color: 'rgba(0, 0, 0, 0.8)',
    fontWeight: '700',
  },
});
