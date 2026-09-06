// app/blocked.tsx
// Shown when runSecurityCheck() detects jailbreak / Frida / root
// User CANNOT dismiss this — the app is completely locked.
// All keys have already been wiped before this screen appears.

import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  BackHandler,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ThreatDetail } from '../services/securityService';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

// Threat type to human-readable label mapping
const THREAT_LABELS: Record<string, { label: string; icon: string; desc: string }> = {
  ROOT_DETECTED: {
    label: 'Device Rooted',
    icon: '⚠️',
    desc: 'Root access detected. Encryption keys have been wiped to protect your messages.',
  },
  MAGISK_DETECTED: {
    label: 'Magisk Detected',
    icon: '⚠️',
    desc: 'Magisk root manager found on this device.',
  },
  SU_BINARY_FOUND: {
    label: 'su Binary Found',
    icon: '⚠️',
    desc: 'Superuser binary found in system paths.',
  },
  TEST_KEYS_BUILD: {
    label: 'Modified ROM',
    icon: '⚠️',
    desc: 'This device is running a custom ROM compiled with test keys.',
  },
  FRIDA_PORT_27042: {
    label: 'Frida Detected',
    icon: '🔍',
    desc: 'Frida instrumentation server detected on port 27042. Keys wiped.',
  },
  FRIDA_SERVER_RESPONSE: {
    label: 'Frida Active',
    icon: '🔍',
    desc: 'Frida server is actively responding to instrumentation requests.',
  },
  EMULATOR_DETECTED: {
    label: 'Emulator',
    icon: '📱',
    desc: 'VaultChat is not permitted to run on emulators.',
  },
  ADB_ENABLED: {
    label: 'ADB Enabled',
    icon: '🔌',
    desc: 'Android Debug Bridge is active. This allows external access to your device.',
  },
};

export default function BlockedScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const params = useLocalSearchParams<{ threats: string }>();
  const [threats, setThreats] = useState<ThreatDetail[]>([]);

  useEffect(() => {
    // Parse threats passed from _layout.tsx
    if (params.threats) {
      try {
        setThreats(JSON.parse(params.threats));
      } catch {
        setThreats([]);
      }
    }

    // Block Android back button — user cannot navigate away
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      return true; // true = event consumed = back button disabled
    });

    return () => handler.remove();
  }, [params.threats]);

  const handleContactSupport = () => {
    Alert.alert(
      'Contact Support',
      'Email: security@vaultchat.app\n\nAll your encryption keys have been wiped to protect your data. To restore access, you will need to reinstall VaultChat on a clean, unrooted device.',
      [{ text: 'OK' }]
    );
  };

  return (
    <View style={styles.container}>
      {/* Top warning bar */}
      <View style={styles.topBar}>
        <Text style={styles.topBarText}>SECURITY ALERT</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Shield icon */}
        <View style={styles.iconWrap}>
          <Text style={styles.shieldIcon}>🛡️</Text>
        </View>

        <Text style={styles.title}>VaultChat Blocked</Text>
        <Text style={styles.subtitle}>
          A security threat was detected on this device.
          All encryption keys have been permanently wiped
          to protect your messages.
        </Text>

        {/* Threat list */}
        {threats.length > 0 && (
          <View style={styles.threatList}>
            <Text style={styles.threatListTitle}>Threats Detected</Text>
            {threats.map((t, i) => {
              const info = THREAT_LABELS[t.type] || {
                label: t.type,
                icon: '⚠️',
                desc: t.detail,
              };
              return (
                <View key={i} style={styles.threatCard}>
                  <View style={styles.threatHeader}>
                    <Text style={styles.threatIcon}>{info.icon}</Text>
                    <Text style={styles.threatLabel}>{info.label}</Text>
                  </View>
                  <Text style={styles.threatDesc}>{info.desc}</Text>
                  {/* Raw detail for technical users */}
                  <Text style={styles.threatRaw} numberOfLines={2}>
                    {t.detail}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* What happened section */}
        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>What happened?</Text>
          <Text style={styles.infoText}>
            VaultChat detected that this device is compromised. On a rooted or
            instrumented device, end-to-end encryption provides NO protection
            because an attacker can read app memory directly.
          </Text>
          <Text style={styles.infoText}>
            To protect you, VaultChat has immediately wiped all session keys,
            ratchet states, and your Vault PIN from this device. Your messages
            remain encrypted on the server — no plaintext was exposed.
          </Text>
        </View>

        {/* What to do */}
        <View style={styles.stepsBox}>
          <Text style={styles.infoTitle}>To restore access:</Text>
          {[
            'Unroot your device or use a clean stock ROM',
            'Remove Magisk, SuperSU, or any root manager',
            'Disable any Frida / instrumentation tools',
            'Reinstall VaultChat from the Play Store',
            'Verify your identity with OTP again',
          ].map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {/* Support button */}
        <TouchableOpacity style={styles.supportBtn} onPress={handleContactSupport}>
          <Text style={styles.supportBtnText}>Contact Support</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          VaultChat Security · AES-256-GCM · Signal Protocol
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.glassSoft,
  },
  topBar: {
    backgroundColor: '#FF4D6D',
    paddingTop: 52,
    paddingBottom: 10,
    alignItems: 'center',
  },
  topBarText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: c.text,
    letterSpacing: 2,
  },
  scroll: {
    padding: 20,
    paddingBottom: 48,
    alignItems: 'center',
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(239,68,68,0.13)',
    borderWidth: 2,
    borderColor: '#FF4D6D',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 16,
  },
  shieldIcon: {
    fontSize: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: c.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: c.textDim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
    maxWidth: 320,
  },
  threatList: {
    width: '100%',
    marginBottom: 20,
  },
  threatListTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#FF4D6D',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  threatCard: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderWidth: 0.5,
    borderColor: '#FF4D6D44',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  threatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  threatIcon: {
    fontSize: 18,
  },
  threatLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#FF4D6D',
  },
  threatDesc: {
    fontSize: 13,
    color: c.textFaint,
    lineHeight: 20,
    marginBottom: 4,
  },
  threatRaw: {
    fontSize: 10,
    color: c.textDim,
    fontFamily: 'monospace',
  },
  infoBox: {
    width: '100%',
    backgroundColor: c.bg,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: c.glassStroke,
    padding: 16,
    marginBottom: 16,
  },
  stepsBox: {
    width: '100%',
    backgroundColor: c.bg,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: c.glassStroke,
    padding: 16,
    marginBottom: 24,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#00D4AA',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoText: {
    fontSize: 13,
    color: c.textDim,
    lineHeight: 21,
    marginBottom: 10,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(34,197,94,0.14)',
    borderWidth: 1,
    borderColor: '#00D4AA',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 1,
  },
  stepNumText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#00D4AA',
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: c.textFaint,
    lineHeight: 20,
  },
  supportBtn: {
    backgroundColor: c.surfaceSolid,
    borderWidth: 1,
    borderColor: c.glassStroke,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  supportBtnText: {
    color: c.textDim,
    fontSize: 14,
    fontWeight: 'bold',
  },
  footer: {
    fontSize: 11,
    color: c.textFaint,
    textAlign: 'center',
  },
});
