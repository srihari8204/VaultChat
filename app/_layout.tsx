import { LinearGradient } from 'expo-linear-gradient';
import * as LocalAuthentication from 'expo-local-authentication';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { onAuthChange, logoutUser } from './(constants)/authService';

Sentry.init({
  dsn: 'https://94ec592aefab9d7fdacf954fd4a5ec94@o4511015938555904.ingest.de.sentry.io/4511015943667792',
  sendDefaultPii: true,
  enableLogs: true,
});

function SplashScreen({ onDone }: { onDone: () => void }) {
  const scale   = useRef(new Animated.Value(0.8)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale,   { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }),
    ]).start();
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#010812', justifyContent: 'center', alignItems: 'center' }}>
      <LinearGradient colors={['#010812', '#020B18']} style={StyleSheet.absoluteFillObject} />
      <Animated.View style={{ transform: [{ scale }], opacity, alignItems: 'center', gap: 16 }}>
        <View style={{
          width: 90, height: 90, borderRadius: 45,
          backgroundColor: 'rgba(74,159,255,0.15)',
          borderWidth: 2, borderColor: 'rgba(74,159,255,0.4)',
          justifyContent: 'center', alignItems: 'center',
        }}>
          <Text style={{ fontSize: 44 }}>ðŸ”’</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 30, fontWeight: '900', letterSpacing: -0.5 }}>VaultChat</Text>
        <Text style={{ color: 'rgba(74,159,255,0.6)', fontSize: 11, letterSpacing: 3, fontWeight: '600' }}>SECURE MESSENGER</Text>
      </Animated.View>
    </View>
  );
}

function FaceLockOverlay({ onUnlock, onSignOut }: { onUnlock: () => void; onSignOut: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [message,  setMessage]  = useState('Tap the icon to verify your face');
  const [failed,   setFailed]   = useState(false);
  const [success,  setSuccess]  = useState(false);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const pulseRef  = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
    pulseRef.current = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.07, duration: 1100, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 1100, useNativeDriver: true }),
    ]));
    pulseRef.current.start();
    const t = setTimeout(() => triggerScan(), 700);
    return () => { clearTimeout(t); pulseRef.current?.stop(); };
  }, []);

  const triggerScan = async () => {
    if (scanning || success) return;
    setScanning(true);
    setFailed(false);
    setMessage('Scanning...');
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled  = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !isEnrolled) {
        setMessage('Biometrics unavailable - unlocking...');
        setTimeout(onUnlock, 800);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify your identity to open VaultChat',
        fallbackLabel: 'Use Passcode',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (result.success) {
        setSuccess(true);
        setFailed(false);
        setMessage('Identity confirmed');
        pulseRef.current?.stop();
        setTimeout(onUnlock, 450);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setFailed(true);
        if (newAttempts >= 3) {
          setMessage('3 failed attempts - signing out...');
          setTimeout(onSignOut, 1500);
        } else {
          setMessage('Failed (' + newAttempts + '/3) - tap to try again');
        }
      }
    } catch {
      setFailed(true);
      setMessage('Error - tap to try again');
    } finally {
      setScanning(false);
    }
  };

  const ringColor = success ? '#10B981' : failed ? '#EF4444' : '#4A9FFF';

  return (
    <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: fadeAnim, zIndex: 9999 }]}>
      <LinearGradient colors={['#010812', '#020E1A', '#010812']} style={StyleSheet.absoluteFillObject} />
      <View style={{ position: 'absolute', alignSelf: 'center', top: '15%', width: 300, height: 300, borderRadius: 150, backgroundColor: 'rgba(74,159,255,0.05)' }} />
      <View style={FL.container}>
        <View style={FL.header}>
          <View style={FL.lockBadge}>
            <Text style={{ fontSize: 28 }}>ðŸ”’</Text>
          </View>
          <Text style={FL.title}>VaultChat Locked</Text>
          <Text style={FL.subtitle}>Verify your identity to open your chats</Text>
        </View>
        <TouchableOpacity onPress={triggerScan} disabled={scanning || success} activeOpacity={0.75}>
          <Animated.View style={[FL.scanRingOuter, { borderColor: ringColor, transform: [{ scale: pulseAnim }] }]}>
            <View style={[FL.scanRingInner, { borderColor: ringColor + '55' }]}>
              <Text style={{ fontSize: 62 }}>
                {success ? 'âœ…' : failed ? 'âŒ' : scanning ? 'âŒ›' : 'ðŸ‘¤'}
              </Text>
            </View>
          </Animated.View>
        </TouchableOpacity>
        <View style={FL.statusRow}>
          <View style={[FL.statusDot, { backgroundColor: success ? '#10B981' : failed ? '#EF4444' : scanning ? '#F59E0B' : '#4A9FFF' }]} />
          <Text style={[FL.statusText, success ? { color: '#10B981' } : failed ? { color: '#EF4444' } : {}]}>{message}</Text>
        </View>
        <View style={FL.attemptsRow}>
          {[0, 1, 2].map(i => (
            <View key={i} style={[FL.attemptDot, { backgroundColor: i < attempts ? '#EF4444' : 'rgba(255,255,255,0.12)' }]} />
          ))}
        </View>
        {failed && attempts < 3 && !scanning && (
          <TouchableOpacity style={FL.retryBtn} onPress={triggerScan} activeOpacity={0.8}>
            <Text style={FL.retryText}>Try Again</Text>
          </TouchableOpacity>
        )}
      </View>
      <TouchableOpacity style={FL.signOutBtn} onPress={onSignOut}>
        <Text style={FL.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const FL = StyleSheet.create({
  container:     { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 28 },
  header:        { alignItems: 'center', gap: 10 },
  lockBadge:     { width: 68, height: 68, borderRadius: 34, backgroundColor: 'rgba(74,159,255,0.12)', borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.35)', justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  title:         { color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: 0.2 },
  subtitle:      { color: 'rgba(255,255,255,0.38)', fontSize: 13, textAlign: 'center' },
  scanRingOuter: { width: 190, height: 190, borderRadius: 95, borderWidth: 2, backgroundColor: 'rgba(74,159,255,0.07)', justifyContent: 'center', alignItems: 'center' },
  scanRingInner: { width: 154, height: 154, borderRadius: 77, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  statusRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot:     { width: 8, height: 8, borderRadius: 4 },
  statusText:    { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
  attemptsRow:   { flexDirection: 'row', gap: 12 },
  attemptDot:    { width: 11, height: 11, borderRadius: 5.5 },
  retryBtn:      { backgroundColor: 'rgba(74,159,255,0.13)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(74,159,255,0.3)', paddingHorizontal: 36, paddingVertical: 14 },
  retryText:     { color: '#4A9FFF', fontSize: 15, fontWeight: '800' },
  signOutBtn:    { position: 'absolute', bottom: 52, alignSelf: 'center', padding: 12 },
  signOutText:   { color: 'rgba(255,255,255,0.22)', fontSize: 13, fontWeight: '600' },
});

export default Sentry.wrap(function RootLayout() {
  const [showSplash, setShowSplash] = useState(true);
  const [isLocked,   setIsLocked]   = useState(false);
  const [user,       setUser]       = useState<any>(null);

  const appStateRef = useRef(AppState.currentState);
  const isReadyRef  = useRef(false);

  useEffect(() => {
    const unsub = onAuthChange(u => setUser(u));
    return unsub;
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      const prevState = appStateRef.current;
      if (prevState.match(/background|inactive/) && nextState === 'active' && isReadyRef.current && user) {
        setIsLocked(true);
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [user]);

  const handleSplashDone = () => {
    setShowSplash(false);
    setTimeout(() => { isReadyRef.current = true; }, 300);
  };

  const handleUnlock  = () => setIsLocked(false);
  const handleSignOut = async () => {
    setIsLocked(false);
    try { await logoutUser(); } catch { }
  };

  if (showSplash) return <SplashScreen onDone={handleSplashDone} />;

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: '#020B18' } }} initialRouteName="phone">
        <Stack.Screen name="welcome" />
        <Stack.Screen name="login" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="forgot" />
        <Stack.Screen name="recovery" />
        <Stack.Screen name="facescan" />
        <Stack.Screen name="chats" />
        <Stack.Screen name="chat" />
        <Stack.Screen name="dashboard" />
        <Stack.Screen name="communities" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="trustscore" />
        <Stack.Screen name="filevault" />
        <Stack.Screen name="breachguard" />
        <Stack.Screen name="vaultdrop" />
        <Stack.Screen name="profile" />
        <Stack.Screen name="status" />
        <Stack.Screen name="docscanner" />
        <Stack.Screen name="phone" />
        <Stack.Screen name="otp" />
        <Stack.Screen name="vault-id" />
        <Stack.Screen name="profile-setup" />
        <Stack.Screen name="security-questions" />
        <Stack.Screen name="backup-pin" />
        <Stack.Screen name="biometric-setup" />
        <Stack.Screen name="permissions" />
        <Stack.Screen name="setup-complete" />
        <Stack.Screen name="face-verify-new-device" />
      </Stack>
      {isLocked && <FaceLockOverlay onUnlock={handleUnlock} onSignOut={handleSignOut} />}
    </View>
  );
});

