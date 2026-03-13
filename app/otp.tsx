// app/otp.tsx
// Firebase Phone OTP verification
// Registers push notification token immediately after success
// Then routes to pinsetup (new user) or pinentry (returning user)

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import auth from '@react-native-firebase/auth';
import * as SecureStore from 'expo-secure-store';
import { registerForPushNotifications } from '../services/notificationService';

export default function OtpScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();

  const [confirm,   setConfirm]   = useState<any>(null);
  const [otp,       setOtp]       = useState<string[]>(Array(6).fill(''));
  const [loading,   setLoading]   = useState(false);
  const [sending,   setSending]   = useState(false);
  const [countdown, setCountdown] = useState(30);
  const refs = useRef<TextInput[]>([]);

  // Send OTP on mount
  useEffect(() => { sendOtp(); }, []);

  // Countdown timer for resend
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const sendOtp = async () => {
    try {
      setSending(true);
      const result = await auth().signInWithPhoneNumber(phone || '');
      setConfirm(result);
      setCountdown(30);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to send OTP');
    } finally {
      setSending(false);
    }
  };

  const handleDigit = (val: string, idx: number) => {
    const next = [...otp];
    next[idx] = val.replace(/[^0-9]/g, ''); // digits only
    setOtp(next);

    // Move to next box
    if (val && idx < 5) {
      refs.current[idx + 1]?.focus();
    }
    // Auto-verify when all 6 filled
    if (next.filter(Boolean).length === 6) {
      verifyOtp(next.join(''));
    }
  };

  const handleBackspace = (key: string, idx: number) => {
    if (key === 'Backspace' && !otp[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    }
  };

  const verifyOtp = async (code?: string) => {
    const finalCode = code || otp.join('');
    if (finalCode.length !== 6) {
      Alert.alert('Error', 'Enter the 6-digit OTP');
      return;
    }
    if (!confirm) {
      Alert.alert('Error', 'OTP session expired. Resend and try again.');
      return;
    }

    try {
      setLoading(true);

      // Verify with Firebase
      await confirm.confirm(finalCode);

      // ── Register push notifications immediately after login ──
      // Do this before navigating so token is ready for first message
      await registerForPushNotifications();

      // Check if this is a new user (no PIN set) or returning user
      const hasPin = await SecureStore.getItemAsync('vault_pin');

      if (hasPin) {
        // Returning user — go to PIN/face lock
        router.replace('/pinentry');
      } else {
        // New user — go through PIN setup flow
        router.replace('/pinentry');
      }
    } catch (e: any) {
      // Wrong OTP
      Alert.alert('Invalid OTP', 'The code is incorrect. Please try again.');
      setOtp(Array(6).fill(''));
      refs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>📱</Text>
      <Text style={styles.title}>Verify Phone</Text>
      <Text style={styles.sub}>
        Enter the 6-digit OTP sent to{'\n'}
        <Text style={styles.phone}>{phone}</Text>
      </Text>

      {/* OTP boxes */}
      <View style={styles.otpRow}>
        {otp.map((d, i) => (
          <TextInput
            key={i}
            ref={r => { if (r) refs.current[i] = r; }}
            style={[styles.box, d ? styles.boxFilled : {}]}
            value={d}
            maxLength={1}
            keyboardType="number-pad"
            onChangeText={v => handleDigit(v, i)}
            onKeyPress={({ nativeEvent }) => handleBackspace(nativeEvent.key, i)}
            selectTextOnFocus
          />
        ))}
      </View>

      {/* Verify button */}
      <TouchableOpacity
        style={[styles.btn, (loading || !otp.every(Boolean)) && styles.btnDisabled]}
        onPress={() => verifyOtp()}
        disabled={loading || !otp.every(Boolean)}
      >
        {loading
          ? <ActivityIndicator color="#0A0E1A" />
          : <Text style={styles.btnText}>Verify OTP</Text>
        }
      </TouchableOpacity>

      {/* Resend */}
      <TouchableOpacity
        onPress={sendOtp}
        disabled={countdown > 0 || sending}
        style={styles.resendBtn}
      >
        {sending
          ? <ActivityIndicator size="small" color="#00D4AA" />
          : (
            <Text style={[styles.resend, countdown > 0 && styles.resendDim]}>
              {countdown > 0 ? `Resend OTP in ${countdown}s` : 'Resend OTP'}
            </Text>
          )
        }
      </TouchableOpacity>

      <Text style={styles.note}>🔐 Firebase Auth · Encrypted OTP</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0E1A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  icon: {
    fontSize: 52,
    marginBottom: 14,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  sub: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  phone: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  otpRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 32,
  },
  box: {
    width: 46,
    height: 54,
    backgroundColor: '#1A2235',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#1E293B',
    color: '#FFFFFF',
    fontSize: 24,
    textAlign: 'center',
    fontWeight: 'bold',
  },
  boxFilled: {
    borderColor: '#00D4AA',
    backgroundColor: '#003328',
  },
  btn: {
    backgroundColor: '#00D4AA',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 52,
    marginBottom: 16,
    minWidth: 200,
    alignItems: 'center',
  },
  btnDisabled: {
    backgroundColor: '#003328',
  },
  btnText: {
    color: '#0A0E1A',
    fontWeight: 'bold',
    fontSize: 16,
  },
  resendBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 36,
    justifyContent: 'center',
  },
  resend: {
    color: '#00D4AA',
    fontSize: 14,
  },
  resendDim: {
    color: '#374151',
  },
  note: {
    marginTop: 32,
    color: '#374151',
    fontSize: 11,
  },
});
