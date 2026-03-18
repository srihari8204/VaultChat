/**
 * app/otp.tsx
 * Firebase Phone Authentication — uses authService (test mode: 123456)
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert, Vibration,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { sendOTP, verifyOTP } from './(constants)/authService';

export default function OTPScreen() {
  const { phone } = useLocalSearchParams();
  const router    = useRouter();

  const [otp,       setOtp]       = useState(['','','','','','']);
  const [loading,   setLoading]   = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(30);
  const [canResend, setCanResend] = useState(false);
  const [error,     setError]     = useState('');

  const inputs = useRef<any[]>([]);

  useEffect(() => {
    doSendOTP();
  }, []);

  useEffect(() => {
    if (countdown <= 0) { setCanResend(true); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ── Send OTP ─────────────────────────────────────────────────
  const doSendOTP = async () => {
    try {
      setLoading(true);
      setError('');
      await sendOTP(phone as string);
      console.log('[Auth] OTP sent to', phone);
    } catch (e: any) {
      console.error('[Auth] Send OTP failed:', e);
      setError(e?.message || 'Failed to send OTP. Check phone number.');
    } finally {
      setLoading(false);
    }
  };

  // ── Resend ───────────────────────────────────────────────────
  const handleResend = async () => {
    if (!canResend) return;
    setResending(true);
    setCanResend(false);
    setCountdown(30);
    setOtp(['','','','','','']);
    await doSendOTP();
    setResending(false);
  };

  // ── Handle digit input ───────────────────────────────────────
  const handleChange = (val: string, idx: number) => {
    if (!/^\d*$/.test(val)) return;
    const next = [...otp];
    next[idx] = val;
    setOtp(next);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
    if (!val && idx > 0) inputs.current[idx - 1]?.focus();
    if (next.every(d => d !== '') && val) {
      doVerifyOTP(next.join(''));
    }
  };

  // ── Verify OTP ───────────────────────────────────────────────
  const doVerifyOTP = async (code: string) => {
    try {
      setLoading(true);
      setError('');
      const ok = await verifyOTP(code);
     if (ok) {
  Vibration.vibrate(100);
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  await AsyncStorage.setItem('test_auth_done', 'true');
  await AsyncStorage.setItem('vaultchat_setup_complete', 'true');
  router.replace('/chats' as any);
} else {
        setError('Invalid OTP. Please try again.');
        setOtp(['','','','','','']);
        inputs.current[0]?.focus();
        Vibration.vibrate([0, 100, 50, 100]);
      }
    } catch (e: any) {
      console.error('[Auth] Verify failed:', e);
      setError(e?.message || 'Invalid OTP. Please try again.');
      setOtp(['','','','','','']);
      inputs.current[0]?.focus();
      Vibration.vibrate([0, 100, 50, 100]);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = () => {
    const code = otp.join('');
    if (code.length < 6) { setError('Enter all 6 digits.'); return; }
    doVerifyOTP(code);
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Verify Phone</Text>
        <Text style={styles.subtitle}>
          OTP sent to{'\n'}
          <Text style={styles.phone}>{phone}</Text>
        </Text>

        {/* Test mode hint */}
        <View style={styles.testBanner}>
          <Text style={styles.testText}>🔧 Test Mode — Enter: 123456</Text>
        </View>

        {/* OTP inputs */}
        <View style={styles.otpRow}>
          {otp.map((digit, i) => (
            <TextInput
              key={i}
              ref={r => { inputs.current[i] = r; }}
              style={[styles.otpBox, digit ? styles.otpBoxFilled : null]}
              value={digit}
              onChangeText={v => handleChange(v, i)}
              keyboardType="number-pad"
              maxLength={1}
              selectTextOnFocus
              textContentType="oneTimeCode"
            />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Verify button */}
        <TouchableOpacity
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleVerify}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#0A0E1A" />
            : <Text style={styles.btnText}>Verify & Continue</Text>
          }
        </TouchableOpacity>

        {/* Resend */}
        <TouchableOpacity onPress={handleResend} disabled={!canResend || resending}>
          <Text style={[styles.resend, canResend ? styles.resendActive : null]}>
            {canResend ? '🔄 Resend OTP' : `Resend in ${countdown}s`}
          </Text>
        </TouchableOpacity>

        {/* Change number */}
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 12 }}>
          <Text style={styles.changeNum}>← Change number</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0A0E1A', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card:         { backgroundColor: '#111827', borderRadius: 20, padding: 28, width: '100%', borderWidth: 1, borderColor: '#1E293B' },
  title:        { color: '#FFFFFF', fontSize: 26, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
  subtitle:     { color: '#94A3B8', fontSize: 14, textAlign: 'center', marginBottom: 16, lineHeight: 22 },
  phone:        { color: '#00D4AA', fontWeight: 'bold' },
  testBanner:   { backgroundColor: 'rgba(245,158,11,0.1)', borderRadius: 8, padding: 8, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)' },
  testText:     { color: '#F59E0B', fontSize: 12, textAlign: 'center', fontWeight: '700' },
  otpRow:       { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  otpBox:       { width: 46, height: 56, borderRadius: 12, borderWidth: 1.5, borderColor: '#1E293B', backgroundColor: '#1A2235', color: '#FFFFFF', fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
  otpBoxFilled: { borderColor: '#00D4AA', backgroundColor: '#001810' },
  error:        { color: '#FF4D6D', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  btn:          { backgroundColor: '#00D4AA', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginBottom: 16 },
  btnDisabled:  { opacity: 0.6 },
  btnText:      { color: '#0A0E1A', fontWeight: 'bold', fontSize: 16 },
  resend:       { color: '#4A5568', fontSize: 13, textAlign: 'center' },
  resendActive: { color: '#00D4AA' },
  changeNum:    { color: '#4A5568', fontSize: 13, textAlign: 'center' },
});




