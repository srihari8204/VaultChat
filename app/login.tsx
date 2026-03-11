import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView,
  Platform, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { auth, db } from './(constants)/firebase';

const C = { bg: '#020B18', primary: '#4A9FFF', dim: 'rgba(255,255,255,0.45)' };

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<'email' | 'phone'>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (mode === 'email') {
      if (!email.trim()) return Alert.alert('Error', 'Please enter your email.');
      if (!password) return Alert.alert('Error', 'Please enter your password.');
    } else {
      if (phone.replace(/\D/g, '').length < 10) return Alert.alert('Error', 'Enter a valid 10-digit number.');
      if (!password) return Alert.alert('Error', 'Please enter your password.');
    }

    setLoading(true);
    try {
      let loginEmail = email.trim().toLowerCase();

      // Phone login: look up email from Firestore
      if (mode === 'phone') {
        const fullPhone = '+91' + phone.replace(/\D/g, '').slice(-10);
        const q = query(collection(db, 'users'), where('mobile', '==', fullPhone));
        const snap = await getDocs(q);
        if (snap.empty) {
          Alert.alert('Not Found', 'No account found with this phone number.');
          setLoading(false);
          return;
        }
        loginEmail = snap.docs[0].data().email;
      }

      await signInWithEmailAndPassword(auth, loginEmail, password);
      router.replace('/facescan' as any);
    } catch (e: any) {
      const msg =
        e.message === 'EMAIL_NOT_VERIFIED' ? 'Please verify your email before logging in.' :
        e.code === 'auth/user-not-found'   ? 'No account found with this email.' :
        e.code === 'auth/wrong-password'   ? 'Incorrect password. Try again.' :
        e.code === 'auth/invalid-email'    ? 'Invalid email address.' :
        e.code === 'auth/too-many-requests'? 'Too many attempts. Try again later.' :
        'Login failed. Please try again.';
      Alert.alert('Login Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient colors={['#010812', '#020B18', '#071020']} style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

          {/* Logo */}
          <View style={s.logoWrap}>
            <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={s.logoCircle}>
              <Text style={{ fontSize: 34 }}>??</Text>
            </LinearGradient>
            <Text style={s.logoText}>VaultChat</Text>
            <Text style={s.logoSub}>Secure. Private. Encrypted.</Text>
          </View>

          {/* Mode Toggle */}
          <View style={s.toggle}>
            <TouchableOpacity
              style={[s.toggleBtn, mode === 'email' && s.toggleActive]}
              onPress={() => setMode('email')}>
              <Text style={[s.toggleTxt, mode === 'email' && s.toggleTxtActive]}>?? Email</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.toggleBtn, mode === 'phone' && s.toggleActive]}
              onPress={() => setMode('phone')}>
              <Text style={[s.toggleTxt, mode === 'phone' && s.toggleTxtActive]}>?? Phone</Text>
            </TouchableOpacity>
          </View>

          {/* Card */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Welcome Back</Text>
            <Text style={s.cardSub}>Sign in to your VaultChat account</Text>

            {/* Email or Phone field */}
            {mode === 'email' ? (
              <View style={s.fieldWrap}>
                <Text style={s.label}>EMAIL ADDRESS</Text>
                <View style={s.inputRow}>
                  <Text style={s.icon}>??</Text>
                  <TextInput
                    style={s.input}
                    placeholder="your@email.com"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
            ) : (
              <View style={s.fieldWrap}>
                <Text style={s.label}>MOBILE NUMBER</Text>
                <View style={s.inputRow}>
                  <View style={s.flagBox}>
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>???? +91</Text>
                  </View>
                  <TextInput
                    style={[s.input, { marginLeft: 8 }]}
                    placeholder="10 digit number"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={phone}
                    onChangeText={t => setPhone(t.replace(/\D/g, '').slice(0, 10))}
                    keyboardType="phone-pad"
                    maxLength={10}
                  />
                </View>
              </View>
            )}

            {/* Password field */}
            <View style={s.fieldWrap}>
              <Text style={s.label}>PASSWORD</Text>
              <View style={s.inputRow}>
                <Text style={s.icon}>??</Text>
                <TextInput
                  style={s.input}
                  placeholder="Your password"
                  placeholderTextColor="rgba(255,255,255,0.25)"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPass}
                  autoCapitalize="none"
                />
                <TouchableOpacity onPress={() => setShowPass(v => !v)} style={{ padding: 8 }}>
                  <Text style={{ fontSize: 16 }}>{showPass ? '??' : '???'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Forgot password */}
            <TouchableOpacity onPress={() => router.push('/forgot' as any)} style={{ alignItems: 'flex-end', marginBottom: 20 }}>
              <Text style={{ color: C.primary, fontSize: 13 }}>Forgot password?</Text>
            </TouchableOpacity>

            {/* Login Button */}
            <TouchableOpacity onPress={handleLogin} disabled={loading} style={s.btnWrap}>
              <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={s.btn}>
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={s.btnText}>Sign In ?</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* Register link */}
          <TouchableOpacity style={{ alignItems: 'center', marginTop: 20 }} onPress={() => router.replace('/signup')}>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>
              New to VaultChat?{' '}
              <Text style={{ color: C.primary, fontWeight: '900' }}>Create Account</Text>
            </Text>
          </TouchableOpacity>

          <View style={{ alignItems: 'center', marginTop: 16, marginBottom: 40 }}>
            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>
              ?? Your data is end-to-end encrypted
            </Text>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  scroll:       { flexGrow: 1, padding: 24, paddingTop: 60 },
  logoWrap:     { alignItems: 'center', marginBottom: 28 },
  logoCircle:   { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  logoText:     { color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 1 },
  logoSub:      { color: 'rgba(255,255,255,0.35)', fontSize: 13, marginTop: 4 },
  toggle:       { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 14,
                  padding: 4, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  toggleBtn:    { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 11 },
  toggleActive: { backgroundColor: '#1D4ED8' },
  toggleTxt:    { color: 'rgba(255,255,255,0.45)', fontSize: 14, fontWeight: '700' },
  toggleTxtActive: { color: '#fff' },
  card:         { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 24, padding: 22,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 16 },
  cardTitle:    { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4 },
  cardSub:      { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginBottom: 20 },
  fieldWrap:    { marginBottom: 16 },
  label:        { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '800',
                  letterSpacing: 1.5, marginBottom: 8 },
  inputRow:     { flexDirection: 'row', alignItems: 'center',
                  backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 14 },
  icon:         { fontSize: 16, marginRight: 10 },
  input:        { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 14 },
  flagBox:      { paddingVertical: 14, paddingRight: 8,
                  borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.1)' },
  btnWrap:      { borderRadius: 14, overflow: 'hidden' },
  btn:          { paddingVertical: 16, alignItems: 'center', borderRadius: 14 },
  btnText:      { color: '#fff', fontSize: 16, fontWeight: '900' },
});

