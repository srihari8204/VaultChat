// app/blocked.tsx
// Shown when runSecurityCheck() returns a `restrict` or `wipe` verdict.
// User CANNOT dismiss this — the app is locked.
//
// THE COPY MUST MATCH WHAT ACTUALLY HAPPENED. This screen used to say "all
// encryption keys have been permanently wiped" unconditionally, but
// securityService only calls wipeAllKeys() on the `wipe` level. A `restrict`
// user — blocked, keys intact — was told their data had been destroyed, which
// is both false and the sort of thing someone acts on irreversibly. Every claim
// below is branched on the verdict's level.
//
// THE VERDICT IS NOT A ROUTE PARAM. It used to be, so `vaultchat://blocked?
// level=wipe` showed a fake "keys wiped" trap with Back disabled. The in-app
// scan callers hold the report in lib/securityVerdict; a link opens the screen
// but cannot set that, and gets the neutral "Nothing is blocked" view.

import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  StyleSheet,
  BackHandler,
  ScrollView,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { clearRestrictVerdict, holdSecurityVerdict, securityVerdict } from '../lib/securityVerdict';
import { runSecurityCheck } from '../services/securityService';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { tint } from '../lib/tintColor';
import { HEADER_TOP } from '../constants/layout';
import { AppText as Text, AuroraBackground } from '../components/ui';

// Threat type to human-readable label mapping
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const THREAT_LABELS: Record<string, { label: string; icon: IoniconName; desc: string }> = {
  ROOT_DETECTED: {
    label: 'Device Rooted',
    icon: 'warning-outline',
    desc: 'Root access was detected on this device.',
  },
  JAILBREAK_DETECTED: {
    label: 'Device Jailbroken',
    icon: 'warning-outline',
    desc: 'Jailbreak indicators were found on this device.',
  },
  MAGISK_DETECTED: {
    label: 'Magisk Detected',
    icon: 'warning-outline',
    desc: 'Magisk root manager found on this device.',
  },
  SU_BINARY_FOUND: {
    label: 'su Binary Found',
    icon: 'warning-outline',
    desc: 'Superuser binary found in system paths.',
  },
  TEST_KEYS_BUILD: {
    label: 'Modified ROM',
    icon: 'warning-outline',
    desc: 'This device is running a custom ROM compiled with test keys.',
  },
  FRIDA_PORT_27042: {
    label: 'Frida Detected',
    icon: 'search-outline',
    desc: 'A Frida instrumentation server was detected on port 27042.',
  },
  FRIDA_DETECTED: {
    label: 'Instrumentation Detected',
    icon: 'search-outline',
    desc: 'Runtime instrumentation tooling (Frida) is active against this app.',
  },
  HOOK_FRAMEWORK: {
    label: 'Hooking Framework',
    icon: 'git-branch-outline',
    desc: 'A code-hooking framework (Xposed / LSPosed / Zygisk) is present.',
  },
  DEBUGGER_ATTACHED: {
    label: 'Debugger Attached',
    icon: 'bug-outline',
    desc: 'A debugger is attached to crazzychat and can read app memory.',
  },
  APK_RESIGNED: {
    label: 'Unofficial Build',
    icon: 'cube-outline',
    desc: 'This build’s signing certificate is not the one crazzychat ships.',
  },
  ACCESSIBILITY_RISK: {
    label: 'Accessibility Service',
    icon: 'eye-outline',
    desc: 'An accessibility service we do not recognise is enabled. These can read screen content.',
  },
  DEV_OPTIONS_ON: {
    label: 'Developer Options',
    icon: 'construct-outline',
    desc: 'Developer options are enabled on this device.',
  },
  USB_DEBUGGING_ON: {
    label: 'USB Debugging',
    icon: 'hardware-chip-outline',
    desc: 'USB debugging is enabled. This allows external access to your device.',
  },
  PIN_BRUTEFORCE: {
    label: 'Repeated PIN Failures',
    icon: 'keypad-outline',
    desc: 'Many consecutive wrong PIN entries were recorded on this device.',
  },
  FRIDA_SERVER_RESPONSE: {
    label: 'Frida Active',
    icon: 'search-outline',
    desc: 'Frida server is actively responding to instrumentation requests.',
  },
  EMULATOR_DETECTED: {
    label: 'Emulator',
    icon: 'phone-portrait-outline',
    desc: 'crazzychat is not permitted to run on emulators.',
  },
  ADB_ENABLED: {
    label: 'ADB Enabled',
    icon: 'hardware-chip-outline',
    desc: 'Android Debug Bridge is active. This allows external access to your device.',
  },
};

export default function BlockedScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const router = useRouter();
  // Only an in-app scan holds a `restrict` or `wipe` verdict. Opened any other
  // way (a crafted or stale link) there is no verdict to enforce, so the screen
  // must not hold the user hostage: Back works and an on-screen exit is shown.
  const [held, setHeld] = useState(securityVerdict);
  // Raw detector output is for technical users; behind a disclosure.
  const [showRaw, setShowRaw] = useState(false);
  const [recheck, setRecheck] = useState<'idle' | 'busy' | 'still' | 'failed'>('idle');
  const verdict = held !== null;
  const threats = held?.threats ?? [];
  // Only a `wipe` verdict ran wipeAllKeys(). A `restrict` left the keys alone,
  // and saying otherwise would be the lie this screen shipped with.
  const wiped = held?.level === 'wipe';

  useEffect(() => {
    // Block Android back button — user cannot navigate away from a verdict.
    if (!verdict) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      return true; // true = event consumed = back button disabled
    });

    return () => handler.remove();
  }, [verdict]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as any);
  };

  // A `restrict` verdict re-checked in place, instead of only "reopen the app".
  // A `wipe` is not offered this: its keys are already gone. A clean re-scan is
  // the same scan a relaunch runs, so it releases `restrict` and leaves.
  const checkAgain = async () => {
    if (recheck === 'busy') return;
    setRecheck('busy');
    try {
      const report = await runSecurityCheck();
      if (report.clean) { clearRestrictVerdict(); leave(); return; }
      holdSecurityVerdict(report);
      setHeld(securityVerdict());
      setRecheck('still');
    } catch {
      setRecheck('failed');
    }
  };

  const handleContactSupport = () => {
    Alert.alert(
      'Contact Support',
      'Email: security@vaultchat.app\n\n' + (wiped
        ? 'Your encryption keys were wiped to protect your data. To restore access, reinstall crazzychat on a clean, unrooted device.'
        : 'Your encryption keys are still on this device. Clear the indicator below and reopen crazzychat to regain access.'),
      [
        { text: 'Close', style: 'cancel' },
        { text: 'Email support', onPress: () => {
            Linking.openURL('mailto:security@vaultchat.app?subject=crazzychat%20security%20block').catch(() => {});
          } },
      ]
    );
  };

  if (!verdict) {
    return (
      <View style={styles.container}>
        <AuroraBackground />
        <View style={[styles.scroll, { flex: 1, justifyContent: 'center' }]}>
          <View style={styles.iconWrap}>
            <Ionicons name="shield-checkmark" size={42} color={c.primary} />
          </View>
          <Text style={styles.title} accessibilityRole="header">Nothing is blocked</Text>
          <Text style={styles.subtitle}>
            This screen only appears when crazzychat finds a security problem on this device. No problem was reported.
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" style={styles.supportBtn} onPress={leave}>
            <Text style={styles.supportBtnText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <AuroraBackground />
      {/* Top warning bar */}
      <View style={styles.topBar}>
        <Text style={styles.topBarText} accessibilityRole="header">SECURITY ALERT</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Shield icon */}
        <View style={styles.iconWrap}>
          <Ionicons name="shield" size={42} color={c.danger} />
        </View>

        <Text style={styles.title} accessibilityRole="header">crazzychat Blocked</Text>
        <Text style={styles.subtitle}>
          {wiped
            ? 'A serious security threat was detected on this device. All encryption keys have been permanently wiped to protect your messages.'
            : 'A security problem was detected on this device, so crazzychat has locked itself. Your encryption keys have NOT been wiped — access returns once the device is clean.'}
        </Text>

        {/* Threat list */}
        {threats.length > 0 && (
          <View style={styles.threatList}>
            <Text style={styles.threatListTitle} accessibilityRole="header">Threats Detected</Text>
            {threats.map((t, i) => {
              const info = THREAT_LABELS[t.type] || {
                label: t.type,
                icon: 'warning-outline' as IoniconName,
                desc: t.detail,
              };
              return (
                <View key={`${t.type}:${i}`} style={styles.threatCard}>
                  <View style={styles.threatHeader}>
                    <Ionicons name={info.icon} size={18} color={c.danger} />
                    <Text style={styles.threatLabel}>{info.label}</Text>
                  </View>
                  <Text style={styles.threatDesc}>{info.desc}</Text>
                  {/* Raw detail for technical users, on request */}
                  {showRaw && (
                    <Text style={styles.threatRaw} numberOfLines={2}>
                      {t.detail}
                    </Text>
                  )}
                </View>
              );
            })}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ expanded: showRaw }}
              onPress={() => setShowRaw(v => !v)}
              style={styles.linkHit}
            >
              <Text style={styles.linkTxt}>{showRaw ? 'Hide technical details' : 'Show technical details'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* What happened section */}
        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>What happened?</Text>
          <Text style={styles.infoText}>
            {wiped
              ? 'crazzychat found strong evidence that this device is compromised. On a rooted or instrumented device, end-to-end encryption provides NO protection, because an attacker can read app memory directly.'
              : 'crazzychat found an indicator it will not run alongside. This is a precaution, not proof that anything was read — but on this device the app cannot promise your messages stay private.'}
          </Text>
          <Text style={styles.infoText}>
            {wiped
              ? 'To protect you, crazzychat wiped all session keys, ratchet states and your Vault PIN from this device. Your messages remain encrypted on the server — no plaintext was exposed.'
              : 'Nothing has been deleted. Your keys, your PIN and your messages are untouched on this device, and crazzychat will open normally once the indicator below is gone.'}
          </Text>
        </View>

        {/* What to do */}
        <View style={styles.stepsBox}>
          <Text style={styles.infoTitle}>To restore access:</Text>
          {(wiped ? [
            'Unroot your device or use a clean stock ROM',
            'Remove Magisk, SuperSU, or any root manager',
            'Disable any Frida / instrumentation tools',
            'Reinstall crazzychat from the Play Store',
            'Verify your identity with OTP again',
          ] : [
            'Clear the indicator listed above',
            'Turn off USB debugging / developer options if they are on',
            'Disconnect any debugger or instrumentation tool',
            'Disable accessibility services you do not recognise',
            'Tap Check again, or reopen crazzychat — it re-checks on every launch',
          ]).map((step, i) => (
            <View key={step} style={styles.stepRow}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {!wiped && (
          <>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ busy: recheck === 'busy', disabled: recheck === 'busy' }}
              disabled={recheck === 'busy'}
              style={styles.supportBtn}
              onPress={checkAgain}
            >
              <Text style={styles.supportBtnText}>{recheck === 'busy' ? 'Checking…' : 'Check again'}</Text>
            </TouchableOpacity>
            {recheck !== 'idle' && recheck !== 'busy' && (
              <Text style={styles.recheckTxt} accessibilityLiveRegion="polite">
                {recheck === 'still'
                  ? 'Still detected — see the list above.'
                  : 'Couldn’t run the check. Try again.'}
              </Text>
            )}
          </>
        )}

        {/* Support button */}
        <TouchableOpacity accessibilityRole="button" style={styles.supportBtn} onPress={handleContactSupport}>
          <Text style={styles.supportBtnText}>Contact Support</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          crazzychat Security · AES-256-GCM · Signal Protocol
        </Text>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  topBar: {
    backgroundColor: c.danger,
    paddingTop: HEADER_TOP,
    paddingBottom: 10,
    alignItems: 'center',
  },
  topBarText: {
    fontSize: 13,
    fontWeight: 'bold',
    // On the solid danger bar.
    color: c.onDanger,
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
    backgroundColor: tint(c.danger, 0.13),
    borderWidth: 2,
    borderColor: c.danger,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 16,
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
    color: c.danger,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  threatCard: {
    backgroundColor: tint(c.danger, 0.10),
    borderWidth: 0.5,
    borderColor: c.danger,
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
  threatLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: c.danger,
  },
  threatDesc: {
    fontSize: 13,
    color: c.textDim,
    lineHeight: 20,
    marginBottom: 4,
  },
  linkHit: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkTxt: { fontSize: 13, fontWeight: '700', color: c.primary },
  recheckTxt: { fontSize: 13, color: c.textDim, textAlign: 'center', marginTop: -12, marginBottom: 20, maxWidth: 320 },
  threatRaw: {
    fontSize: 10,
    color: c.textDim,
    fontFamily: 'monospace',
  },
  infoBox: {
    width: '100%',
    backgroundColor: c.glass,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: c.glassStroke,
    padding: 16,
    marginBottom: 16,
  },
  stepsBox: {
    width: '100%',
    backgroundColor: c.glass,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: c.glassStroke,
    padding: 16,
    marginBottom: 24,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: c.success,
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
    backgroundColor: tint(c.success, 0.14),
    borderWidth: 1,
    borderColor: c.success,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 1,
  },
  stepNumText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: c.success,
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: c.textDim,
    lineHeight: 20,
  },
  supportBtn: {
    backgroundColor: c.glass,
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
