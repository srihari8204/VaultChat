
// app/register.tsx
// Registration: Name + Phone Number + VaultID generation
// Stores unique identity per device

import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SERVER_URL as SERVER } from '../constants/server';

const C = {
  bg:'#FFFFFF', card:'rgba(10,22,40,0.92)',
  primary:'#4A9FFF', accent:'#10B981',
  border:'rgba(74,159,255,0.2)', dim:'rgba(255,255,255,0.45)',
  faint:'rgba(255,255,255,0.1)', red:'#EF4444',
};

function Input({ label, value, onChange, placeholder, keyboardType, maxLength }: any) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: C.dim, fontSize: 11, fontWeight: '800',
        letterSpacing: 1.2, marginBottom: 8 }}>{label}</Text>
      <TextInput
        style={[Ss.input, focused && { borderColor: C.primary }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.2)"
        keyboardType={keyboardType || 'default'}
        maxLength={maxLength}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCapitalize="none"
      />
    </View>
  );
}

export default function Register() {
  const router = useRouter();
  const [step,     setStep]     = useState<'form'|'otp'|'done'>('form');
  const [name,     setName]     = useState('');
  const [phone,    setPhone]    = useState('');
  const [otp,      setOtp]      = useState('');
  const [loading,  setLoading]  = useState(false);
  const [sentOtp,  setSentOtp]  = useState('');   // in prod: server sends real OTP
  const [vaultId,  setVaultId]  = useState('');

  // Generate unique VaultID from name + phone
  const generateVaultId = (n: string, p: string): string => {
    const clean  = n.trim().toUpperCase().replace(/\s+/g, '').slice(0, 4).padEnd(4, 'X');
    const digits = p.replace(/\D/g, '').slice(-4).padStart(4, '0');
    const rand   = Math.floor(1000 + Math.random() * 9000);
    return `VC-${clean}-${digits}-${rand}`;
  };

  const handleSendOtp = async () => {
    if (!name.trim())          return Alert.alert('', 'Please enter your name');
    if (phone.replace(/\D/g,'').length < 10)
                               return Alert.alert('', 'Enter a valid 10-digit number');
    setLoading(true);
    try {
      // In production: call POST /api/auth/send-otp
      // For testing: generate a fake OTP shown on screen
      const fakeOtp = String(Math.floor(100000 + Math.random() * 900000));
      setSentOtp(fakeOtp);
      setStep('otp');
      // Show OTP in alert for testing (remove in production)
      Alert.alert('OTP (Testing Mode)', `Your OTP is: ${fakeOtp}\n\nIn production this would be sent via SMS.`);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp !== sentOtp) {
      return Alert.alert('Wrong OTP', 'Please check and try again.');
    }
    setLoading(true);
    try {
      const normalPhone = '+91' + phone.replace(/\D/g, '').slice(-10);
      const newVaultId  = generateVaultId(name, normalPhone);
      setVaultId(newVaultId);

      // Register on server
      const res = await fetch(`${SERVER}/api/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          vaultId:     newVaultId,
          displayName: name.trim(),
          phone:       normalPhone,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Registration failed');
      }

      // Save locally
      await AsyncStorage.setItem('vaultId',      newVaultId);
      await AsyncStorage.setItem('displayName',   name.trim());
      await AsyncStorage.setItem('phone',         normalPhone);
      await AsyncStorage.setItem('registered',   'true');

      setStep('done');
      setTimeout(() => router.replace('/chats'), 1500);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── FORM STEP ─────────────────────────────────────────────────
  if (step === 'form') return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#FFFFFF', '#FFFFFF', '#030E1E']}
        style={StyleSheet.absoluteFillObject} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={Ss.container}>
          <Text style={Ss.logo}>🔐</Text>
          <Text style={Ss.title}>Create Account</Text>
          <Text style={Ss.sub}>Join VaultChat — private &amp; encrypted</Text>

          <View style={Ss.card}>
            <Input label="FULL NAME" value={name} onChange={setName}
              placeholder="e.g. Rahul Kumar" />
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: C.dim, fontSize: 11, fontWeight: '800',
                letterSpacing: 1.2, marginBottom: 8 }}>MOBILE NUMBER</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={[Ss.input, { width: 60, justifyContent: 'center',
                  alignItems: 'center' }]}>
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>🇮🇳 +91</Text>
                </View>
                <TextInput
                  style={[Ss.input, { flex: 1 }]}
                  value={phone}
                  onChangeText={t => setPhone(t.replace(/\D/g, '').slice(0, 10))}
                  placeholder="10 digit number"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  keyboardType="phone-pad"
                  maxLength={10}
                />
              </View>
            </View>

            <TouchableOpacity onPress={handleSendOtp}
              style={Ss.primaryBtn} disabled={loading}>
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={Ss.primaryBtnTxt}>Send OTP →</Text>}
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={() => router.replace('/login')}
            style={{ marginTop: 20 }}>
            <Text style={{ color: C.dim, fontSize: 13, textAlign: 'center' }}>
              Already registered?{' '}
              <Text style={{ color: C.primary, fontWeight: '800' }}>Login</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );

  // ── OTP STEP ──────────────────────────────────────────────────
  if (step === 'otp') return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#FFFFFF', '#FFFFFF']}
        style={StyleSheet.absoluteFillObject} />
      <View style={Ss.container}>
        <Text style={Ss.logo}>📱</Text>
        <Text style={Ss.title}>Verify Number</Text>
        <Text style={[Ss.sub, { marginBottom: 8 }]}>
          OTP sent to +91 {phone}
        </Text>

        <View style={Ss.card}>
          <Input label="ENTER 6-DIGIT OTP" value={otp}
            onChange={(t: string) => setOtp(t.replace(/\D/g,'').slice(0,6))}
            placeholder="______" keyboardType="number-pad" maxLength={6} />

          <TouchableOpacity onPress={handleVerifyOtp}
            style={Ss.primaryBtn} disabled={loading || otp.length < 6}>
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={Ss.primaryBtnTxt}>Verify &amp; Register</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setStep('form')}
            style={{ marginTop: 12, alignItems: 'center' }}>
            <Text style={{ color: C.dim, fontSize: 12 }}>← Change number</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // ── DONE STEP ─────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: C.bg,
      justifyContent: 'center', alignItems: 'center', gap: 16 }}>
      <LinearGradient colors={['#FFFFFF', '#FFFFFF']}
        style={StyleSheet.absoluteFillObject} />
      <Text style={{ fontSize: 60 }}>✅</Text>
      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>
        Welcome, {name}!
      </Text>
      <Text style={{ color: C.dim, fontSize: 13 }}>Your VaultID:</Text>
      <View style={{ backgroundColor: 'rgba(74,159,255,0.1)', borderRadius: 12,
        paddingHorizontal: 20, paddingVertical: 10,
        borderWidth: 1, borderColor: 'rgba(74,159,255,0.3)' }}>
        <Text style={{ color: C.primary, fontSize: 16,
          fontWeight: '900', letterSpacing: 1 }}>{vaultId}</Text>
      </View>
      <ActivityIndicator color={C.primary} style={{ marginTop: 8 }} />
    </View>
  );
}

const Ss = StyleSheet.create({
  container:    { flexGrow: 1, justifyContent: 'center',
                  alignItems: 'center', padding: 24 },
  logo:         { fontSize: 56, marginBottom: 12 },
  title:        { color: '#fff', fontSize: 26, fontWeight: '900', marginBottom: 6 },
  sub:          { color: 'rgba(255,255,255,0.5)', fontSize: 13,
                  textAlign: 'center', marginBottom: 28 },
  card:         { width: '100%', backgroundColor: 'rgba(10,22,40,0.92)',
                  borderRadius: 20, padding: 20,
                  borderWidth: 1.5, borderColor: 'rgba(74,159,255,0.15)' },
  input:        { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12,
                  paddingHorizontal: 16, paddingVertical: 14,
                  color: '#fff', fontSize: 15, borderWidth: 1.5,
                  borderColor: 'rgba(255,255,255,0.1)' },
  primaryBtn:   { backgroundColor: '#4A9FFF', borderRadius: 14,
                  paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  primaryBtnTxt:{ color: '#fff', fontSize: 15, fontWeight: '900' },
});
