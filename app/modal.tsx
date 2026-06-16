import { useRouter } from 'expo-router';
import { useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert, KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text, TextInput, TouchableOpacity,
  View
} from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function PhoneLoginScreen() {
  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSendOTP = () => {
    // Validate phone number
    if (phone.length < 10) {
      Alert.alert('Invalid Number', 'Please enter a valid 10-digit phone number');
      return;
    }

    setLoading(true);

    // Simulate OTP being sent (we'll connect Firebase later)
    setTimeout(() => {
      setLoading(false);
      Alert.alert(
        'OTP Sent! ✅',
        `A 6-digit code has been sent to +91 ${phone}`,
        [{ text: 'OK', onPress: () => router.push({ pathname: '/otp', params: { phone } }) }]
      );
    }, 1500);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Logo Area */}
      <View style={styles.logoArea}>
        <Text style={styles.logo}>🛡️</Text>
        <Text style={styles.appName}>VaultChat</Text>
        <Text style={styles.tagline}>The World&apos;s Most Secure Messenger</Text>
      </View>

      {/* Form Area */}
      <View style={styles.formArea}>
        <Text style={styles.title}>Enter Your Phone Number</Text>
        <Text style={styles.subtitle}>
          We&apos;ll send a verification code to confirm your number
        </Text>

        {/* Phone Input */}
        <View style={styles.inputRow}>
          <View style={styles.countryCode}>
            <Text style={styles.countryCodeText}>🇮🇳 +91</Text>
          </View>
          <TextInput
            style={styles.input}
            placeholder="Enter phone number"
            placeholderTextColor="#6B7280"
            keyboardType="phone-pad"
            maxLength={10}
            value={phone}
            onChangeText={setPhone}
          />
        </View>

        <Text style={styles.charCount}>{phone.length}/10 digits</Text>

        {/* Send OTP Button */}
        <TouchableOpacity
          style={[styles.button, phone.length < 10 && styles.buttonDisabled]}
          onPress={handleSendOTP}
          disabled={phone.length < 10 || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Send Verification Code →</Text>
          )}
        </TouchableOpacity>

        {/* Terms */}
        <Text style={styles.terms}>
          By continuing, you agree to our Terms of Service and Privacy Policy.
          Your number is protected by VaultID encryption.
        </Text>
      </View>

      {/* Security Badge */}
      <View style={styles.securityBadge}>
        <Text style={styles.securityText}>🔒 End-to-End Encrypted  ·  🛡️ VaultID Protected</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  logoArea: {
    alignItems: 'center',
    paddingTop: 40,
  },
  logo: {
    fontSize: 72,
  },
  appName: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#000000',
    marginTop: 12,
    letterSpacing: 1,
  },
  tagline: {
    fontSize: 14,
    color: c.textDim,
    marginTop: 8,
    textAlign: 'center',
  },
  formArea: {
    backgroundColor: c.bg,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: c.textDim,
    marginBottom: 24,
    lineHeight: 20,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  countryCode: {
    backgroundColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 16,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  countryCodeText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '600',
  },
  input: {
    flex: 1,
    backgroundColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#000000',
    fontSize: 18,
    letterSpacing: 2,
    borderWidth: 1,
    borderColor: c.border,
  },
  charCount: {
    color: '#475569',
    fontSize: 12,
    textAlign: 'right',
    marginBottom: 20,
  },
  button: {
    backgroundColor: c.accent,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    marginBottom: 16,
    shadowColor: c.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonDisabled: {
    backgroundColor: '#E5E7EB',
    shadowOpacity: 0,
    elevation: 0,
  },
  buttonText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  terms: {
    color: '#475569',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  securityBadge: {
    alignItems: 'center',
    paddingBottom: 10,
  },
  securityText: {
    color: '#334155',
    fontSize: 12,
  },
});
