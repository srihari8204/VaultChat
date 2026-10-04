// app/vault-features.tsx
// crazzychat advanced security
//
// 1. Temp Chat Codes — single-use invite code, 5-minute expiry (real backend)
// 2. Auto Screen Lock — how long the app may be in the background before it
//    asks for biometrics / MPIN again (components/ResumeLock reads it; applies
//    when Device MFA is on or a Device PIN is set — lib/resumeLockPolicy)
// 3. Links to the real notification-privacy controls and the Vault, with a
//    "Test encryption speed" readout (components/vault/CipherSpeedTest)
//
// REMOVED 2026-10-04, because nothing read them: a "default disappearing timer"
// saved only here (the real one is Settings → Default message timer, which the
// server applies), and the Screenshot Alerts / Incognito Keyboard switches.
// Also removed: "Email Encrypted Transcript" (an alert, then the chat list) and
// "Backup vault files to email" (the vault has no backup).


import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
  Modal, Share, type StyleProp, type TextStyle,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { createSyncCode } from '../lib/chatService';
import type { Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { HEADER_TOP } from '../constants/layout';
import { isMfaEnabled } from '../lib/mfa';
import { hasPIN } from './(constants)/authService';
import { DEFAULT_LOCK_TIMER, LOCK_SETTINGS_KEY, lockAppliesTo, parseLockTimer, type LockTimer } from '../lib/resumeLockPolicy';
import { userErrorText } from '../lib/userErrorText';
import { CipherSpeedTest } from '../components/vault/CipherSpeedTest';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface VaultSettings {
  lockTimer:          LockTimer;
}
// REMOVED: hidePreviewInApp / hideChatPreview. Both were written to SecureStore
// and read by nothing — and "Hide message text in notification tray" described
// hiding text that is never sent: the server pushes data-only FCM with no body
// and the client hardcodes 'New message'. A switch that claims to protect you
// and does nothing is worse than no switch. The real notification control now
// lives in app/notifications.tsx → PRIVACY (lib/privacyPrefs.ts).

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const LOCK_OPTIONS: { label: string; value: LockTimer }[] = [
  { label: '1 minute',  value: '1m'    },
  { label: '5 minutes', value: '5m'    },
  { label: '15 minutes',value: '15m'   },
  { label: '30 minutes',value: '30m'   },
  { label: 'Never',     value: 'never' },
];

const DEFAULT_SETTINGS: VaultSettings = {
  lockTimer:         DEFAULT_LOCK_TIMER,
};

const CODE_KEY = 'vault_chat_code';
const CODE_EXPIRY_KEY = 'vault_chat_code_expiry';

/** Whole minutes left before `expiry`, at least 1 (for spoken and shared copy). */
function minutesLeft(expiry: string, now: number): number {
  return Math.max(1, Math.ceil((new Date(expiry).getTime() - now) / 60000));
}

/** The code's countdown line. It ticks each second on its own, so the rest
 *  of the screen does not re-render, and calls `onExpired` at zero. */
function CodeCountdown({ expiry, onExpired, style }: { expiry: string; onExpired: () => void; style: StyleProp<TextStyle> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiry]);
  const left = remaining(expiry, now);
  useEffect(() => { if (!left) onExpired(); }, [left, onExpired]);
  if (!left) return null;
  const mins = minutesLeft(expiry, now);
  // The visible text is the clock; the spoken label is the minute, so a
  // screen reader is not read a new number every second.
  return (
    <Text style={style} accessibilityLabel={`Expires in about ${mins} minute${mins === 1 ? '' : 's'}`}>
      Expires in {left}
    </Text>
  );
}

/** "4:59" for the time left before `expiry`, or null once it has passed. */
function remaining(expiry: string, now: number): string | null {
  const ms = new Date(expiry).getTime() - now;
  if (!(ms > 0)) return null;
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

type IconName = React.ComponentProps<typeof Ionicons>['name'];

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function VaultFeaturesScreen() {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const modalStyles = useMemo(() => makeModalStyles(c), [c]);
  const router = useRouter();

  const [settings,      setSettings]      = useState<VaultSettings>(DEFAULT_SETTINGS);
  // A failed read is said out loud: the picker would otherwise show the
  // default as if it were the saved choice.
  const [loadFailed,    setLoadFailed]    = useState(false);

  // Temp chat code
  const [chatCode,      setChatCode]      = useState<string | null>(null);
  const [codeExpiry,    setCodeExpiry]    = useState<string | null>(null);
  const [generatingCode,setGeneratingCode]= useState(false);
  const [revoking,      setRevoking]      = useState(false);
  const [codeCopied,    setCodeCopied]    = useState(false);

  // Lock timer picker modal
  const [showLock,      setShowLock]      = useState(false);
  // The relock applies to a user with Device MFA on or a Device PIN set (the
  // same condition as ResumeLock); say so rather than offer a timer that does nothing.
  const [lockApplies,   setLockApplies]   = useState<boolean | null>(null);
  // Re-read on focus: turning on Device MFA or setting a PIN happens on other
  // screens, and the note must not stay stale when the user comes back.
  useFocusEffect(useCallback(() => {
    let live = true;
    Promise.all([isMfaEnabled().catch(() => false), hasPIN().catch(() => false)])
      .then(([mfaOn, hasDevicePin]) => { if (live) setLockApplies(lockAppliesTo({ signedIn: true, mfaOn, hasDevicePin })); });
    return () => { live = false; };
  }, []));
  // The "Copied" reset timer, cleared if the screen goes first.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const clearLocalCode = useCallback(async () => {
    setChatCode(null);
    setCodeExpiry(null);
    await SecureStore.deleteItemAsync(CODE_KEY).catch(() => {});
    await SecureStore.deleteItemAsync(CODE_EXPIRY_KEY).catch(() => {});
  }, []);

  // ── Load settings ─────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    setLoadFailed(false);
    try {
      const raw = await SecureStore.getItemAsync(LOCK_SETTINGS_KEY);
      setSettings({ lockTimer: parseLockTimer(raw) });
    } catch {
      setLoadFailed(true);
    }
    try {
      const code   = await SecureStore.getItemAsync(CODE_KEY);
      const expiry = await SecureStore.getItemAsync(CODE_EXPIRY_KEY);
      if (code && expiry && remaining(expiry, Date.now())) {
        setChatCode(code);
        setCodeExpiry(expiry);
      } else if (code || expiry) {
        await clearLocalCode();   // expired — clean up
      }
    } catch {
      // The code is a convenience copy of a 5-minute server code; without it
      // the user just generates a new one.
    }
  }, [clearLocalCode]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  // The per-second countdown lives in <CodeCountdown>, so only that line
  // re-renders each second; it clears the code when it reaches zero.

  const saveSetting = async <K extends keyof VaultSettings>(key: K, value: VaultSettings[K]) => {
    const prev = settings;
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    // Device-local; read by components/ResumeLock via services/lockService.
    try {
      await SecureStore.setItemAsync(LOCK_SETTINGS_KEY, JSON.stringify(updated));
      setLoadFailed(false);
    } catch {
      setSettings(prev);
      Alert.alert('Not saved', 'The setting could not be saved. Try again.');
    }
  };

  // ── Generate temp chat code ───────────────────────────────────
  const handleGenerateCode = async () => {
    if (generatingCode) return;
    setGeneratingCode(true);
    try {
      // Use the real mutual-consent sync-code backend (5-min, single-use).
      // The recipient enters it under "Add Contact → Enter Their Code".
      const { code } = await createSyncCode();
      const expiryStr = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      setChatCode(code);
      setCodeExpiry(expiryStr);
      setCodeCopied(false);
      // Only a convenience copy for reopening this screen; failing to keep it
      // does not make the code any less valid.
      await SecureStore.setItemAsync(CODE_KEY, code).catch(() => {});
      await SecureStore.setItemAsync(CODE_EXPIRY_KEY, expiryStr).catch(() => {});
    } catch (e: unknown) {
      Alert.alert('Could not create a code', userErrorText(e, 'Try again.'));
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleCopyCode = async () => {
    if (!chatCode) return;
    try {
      await copyAndAutoClear(chatCode);
      setCodeCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      Alert.alert('Could not copy', 'Use Share instead, or try again.');
    }
  };

  const handleShareCode = async () => {
    if (!chatCode) return;
    const mins = codeExpiry ? minutesLeft(codeExpiry, Date.now()) : 0;
    try {
      await Share.share({
        message: `Join me on crazzychat — use this secure invite code:\n\n${chatCode}\n\nExpires in ${mins} minute${mins === 1 ? '' : 's'}. Enter it under Add Contact → Enter Their Code.`,
        title:   'crazzychat Secure Invite',
      });
    } catch {
      Alert.alert('Could not share', 'Try again, or copy the code instead.');
    }
  };

  // Revoke used to delete only the LOCAL copy (2026-09-22), so the shared code
  // stayed valid on the server until its 5-minute expiry and the button's own
  // promise — "This will invalidate the current invite code" — was false.
  // There is no revoke endpoint (contacts.go registers create/status/verify and
  // nothing else), but POST /contacts/sync/create opens with
  // `DELETE FROM sync_codes WHERE initiator_id = $1`, so minting a replacement
  // and throwing it away kills the shared code server-side at once. The unshared
  // replacement nobody has seen expires on its own five minutes later.
  // On failure the local copy is KEPT: clearing it while the code is still live
  // would hide a working invite from the one person who might re-revoke it.
  const handleRevokeCode = () => {
    Alert.alert('Revoke code?', 'This will invalidate the current invite code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: async () => {
          if (revoking) return;
          setRevoking(true);
          try {
            await createSyncCode();
          } catch (e: unknown) {
            Alert.alert('Not revoked', `The code is still valid. ${userErrorText(e, 'Try again.')}`);
            return;
          } finally {
            setRevoking(false);
          }
          // Only after the server copy is dead (silentFailure.selftest #17).
          await SecureStore.deleteItemAsync(CODE_KEY).catch(() => {});
          await SecureStore.deleteItemAsync(CODE_EXPIRY_KEY).catch(() => {});
          setChatCode(null);
          setCodeExpiry(null);
        },
      },
    ]);
  };

  const lockLabel = LOCK_OPTIONS.find(o => o.value === settings.lockTimer)?.label;

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <AuroraBackground />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={26} color={c.primary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} accessibilityRole="header">Vault Features</Text>
          <Text style={styles.headerSub}>ADVANCED SECURITY</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* ── 1. Temp Chat Codes ── */}
        <View style={styles.section}>
          <SectionHeader icon="link-outline" title="Temp Chat Code" styles={styles} color={c.primary}
            /* "24 hours" was wrong by 288x: the server mints these with
               INTERVAL '5 minutes' (contacts.go) and both read paths enforce
               it with a 410. */
            desc="Single-use invite code — expires in 5 minutes" />

          {chatCode && codeExpiry ? (
            <View style={styles.codeCard}>
              <Text style={styles.codeValue} selectable accessibilityLabel={`Invite code ${chatCode.split('').join(' ')}`}>{chatCode}</Text>
              <CodeCountdown expiry={codeExpiry} onExpired={clearLocalCode} style={styles.codeExpiry} />
              <View style={styles.codeActions}>
                <CodeButton icon={codeCopied ? 'checkmark' : 'copy-outline'} label={codeCopied ? 'Copied' : 'Copy'}
                  a11yLabel={codeCopied ? 'Copied' : 'Copy invite code'} onPress={handleCopyCode}
                  style={codeCopied ? styles.codeBtnCopied : undefined} styles={styles} color={c.text} />
                <CodeButton icon="share-outline" label="Share" a11yLabel="Share invite code" onPress={handleShareCode} styles={styles} color={c.text} />
                <CodeButton icon="trash-outline" label="Revoke" a11yLabel="Revoke invite code" onPress={handleRevokeCode}
                  busy={revoking} style={styles.codeBtnRevoke} textStyle={styles.codeBtnTextRevoke} styles={styles} color={c.danger} />
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.actionBtn, generatingCode && styles.actionBtnDim]}
              onPress={handleGenerateCode}
              disabled={generatingCode}
              accessibilityRole="button"
              accessibilityLabel="Generate invite code"
              accessibilityState={{ disabled: generatingCode, busy: generatingCode }}
            >
              {generatingCode
                ? <ActivityIndicator color={c.onPrimary} size="small" />
                : <Text style={styles.actionBtnText}>Generate Invite Code</Text>
              }
            </TouchableOpacity>
          )}
        </View>

        {/* ── 2. Auto Screen Lock ── */}
        <View style={styles.section}>
          <SectionHeader icon="lock-closed-outline" title="Auto Screen Lock" styles={styles} color={c.primary}
            desc="Ask for biometrics or your MPIN when you come back to the app after this long away" />

          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowLock(true)}
            accessibilityRole="button"
            accessibilityLabel={`Lock after: ${lockLabel}`}
          >
            <Text style={styles.pickerLabel}>Lock after</Text>
            <View style={styles.pickerValue}>
              <Text style={styles.pickerValueText}>{lockLabel}</Text>
              <Ionicons name="chevron-forward" size={18} color={c.textDim} />
            </View>
          </TouchableOpacity>
          {loadFailed && (
            <View style={styles.inlineError} accessibilityRole="alert">
              <Text style={[styles.sectionDesc, { flex: 1 }]}>Your saved choice could not be read, so the default is shown.</Text>
              <TouchableOpacity onPress={loadSettings} style={styles.retryBtn} accessibilityRole="button" accessibilityLabel="Try reading the saved choice again">
                <Text style={styles.retryTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          )}
          {lockApplies === false && (
            <Text style={[styles.sectionDesc, { marginTop: 10 }]}>
              Turn on Device MFA in Settings → Security, or set a Device PIN, for this to take effect.
            </Text>
          )}
        </View>

        {/* ── 3. Privacy ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel} accessibilityRole="header">PRIVACY</Text>
          <LinkRow icon="notifications-off-outline" title="Notification & Link Previews"
            desc="Choose what notifications say, and whether links you receive are fetched"
            onPress={() => router.push('/notifications')} styles={styles} c={c} />
        </View>

        {/* ── 4. Vault ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel} accessibilityRole="header">VAULT</Text>
          <LinkRow icon="lock-closed-outline" title="Vault" desc="Encrypted files, stored on this phone only"
            onPress={() => router.push('/vault')} styles={styles} c={c} />
          <Text style={[styles.sectionDesc, { marginTop: 6, marginBottom: 10 }]}>
            Shows how fast this phone encrypts files as it adds them to the Vault, so you know roughly how long a large video will take. It runs in memory: no file is read or saved.
          </Text>
          <CipherSpeedTest />
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Lock timer picker ── */}
      <Modal
        visible={showLock}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLock(false)}
      >
        <View style={modalStyles.overlay}>
          {/* The backdrop is a sibling of the panel, not its parent: a
              labelled button wrapping the options hid them from VoiceOver. */}
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowLock(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={modalStyles.panel} accessibilityRole="radiogroup">
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title} accessibilityRole="header">Auto Screen Lock</Text>
            {LOCK_OPTIONS.map(opt => {
              const on = settings.lockTimer === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  accessibilityRole="radio"
                  accessibilityLabel={opt.label}
                  accessibilityState={{ checked: on, selected: on }}
                  style={[modalStyles.option, on && modalStyles.optionActive]}
                  onPress={() => {
                    saveSetting('lockTimer', opt.value);
                    setShowLock(false);
                  }}
                >
                  <Text style={[modalStyles.optionText, on && modalStyles.optionTextActive]}>
                    {opt.label}
                  </Text>
                  {on && <Ionicons name="checkmark" size={16} color={c.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Modal>

    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function SectionHeader({ icon, title, desc, styles, color }: { icon: IconName; title: string; desc: string; styles: Styles; color: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon} size={24} color={color} style={{ marginTop: 2 }} importantForAccessibility="no" accessibilityElementsHidden />
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
        <Text style={styles.sectionDesc}>{desc}</Text>
      </View>
    </View>
  );
}

function CodeButton({ icon, label, a11yLabel, onPress, busy, style, textStyle, styles, color }: {
  icon: IconName; label: string; a11yLabel: string; onPress: () => void; busy?: boolean;
  style?: object; textStyle?: object; styles: Styles; color: string;
}) {
  return (
    <TouchableOpacity style={[styles.codeBtn, style]} onPress={onPress} disabled={busy}
      accessibilityRole="button" accessibilityLabel={a11yLabel} accessibilityState={{ disabled: !!busy, busy: !!busy }}>
      {busy ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={16} color={color} />}
      <Text style={[styles.codeBtnText, textStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

function LinkRow({ icon, title, desc, onPress, styles, c }: { icon: IconName; title: string; desc: string; onPress: () => void; styles: Styles; c: Palette }) {
  return (
    <TouchableOpacity style={styles.linkRow} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${desc}`}>
      <Ionicons name={icon} size={22} color={c.primary} />
      <View style={styles.linkInfo}>
        <Text style={styles.linkTitle}>{title}</Text>
        <Text style={styles.linkDesc}>{desc}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.textDim} />
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const makeStyles = (c: Palette) => StyleSheet.create({
  container:    { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 12,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke, gap: 8,
  },
  backBtn:       { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: 'bold', color: c.text },
  headerSub:     { fontSize: 12, color: c.primary, marginTop: 1, fontWeight: 'bold' },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 60 },

  // Section
  section: {
    backgroundColor: c.glassSoft,
    borderRadius: 14, borderWidth: 0.5, borderColor: c.glassStroke,
    padding: 16, marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14,
  },
  sectionTitle:  { fontSize: 15, fontWeight: 'bold', color: c.text, marginBottom: 3 },
  sectionDesc:   { fontSize: 12, color: c.textDim, lineHeight: 17 },

  // Temp chat code
  codeCard: {
    backgroundColor: c.glassSoft, borderRadius: 12,
    borderWidth: 0.5, borderColor: c.glassStroke,
    padding: 14, alignItems: 'center', gap: 6,
  },
  codeValue: {
    fontSize: 28, fontWeight: 'bold', color: c.primary,
    letterSpacing: 3, fontFamily: 'monospace',
  },
  codeExpiry:   { fontSize: 12, color: c.textDim, marginBottom: 4, fontVariant: ['tabular-nums'] },
  codeActions:  { flexWrap: 'wrap', flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4 },
  codeBtn: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: c.surfaceSolid, borderRadius: 8,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  codeBtnCopied:    { borderColor: c.success },
  codeBtnRevoke:    { borderColor: c.danger },
  codeBtnText:      { fontSize: 12, color: c.text },
  codeBtnTextRevoke:{ color: c.danger },

  actionBtn: {
    backgroundColor: c.primary, borderRadius: 10, minHeight: 44,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
  },
  actionBtnDim:   { opacity: 0.5 },
  actionBtnText:  { color: c.onPrimary, fontWeight: 'bold', fontSize: 14 },

  // Picker row
  pickerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.surfaceSolid, borderRadius: 10, minHeight: 44,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  pickerLabel:      { fontSize: 14, color: c.text },
  pickerValue:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pickerValueText:  { fontSize: 14, color: c.primary, fontWeight: 'bold' },

  inlineError:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  retryBtn:     { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glass },
  retryTxt:     { color: c.primary, fontWeight: '700' },

  toggleSectionLabel: {
    fontSize: 12, fontWeight: 'bold', color: c.textDim,
    letterSpacing: 0.8, marginBottom: 10,
  },

  // Link rows
  linkRow: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44,
    paddingVertical: 12, gap: 12,
  },
  linkInfo:    { flex: 1 },
  linkTitle:   { fontSize: 13, fontWeight: 'bold', color: c.text, marginBottom: 2 },
  linkDesc:    { fontSize: 12, color: c.textDim },
});

const makeModalStyles = (c: Palette) => StyleSheet.create({
  // Modal scrim: a translucent black dims whatever is behind in either theme.
  overlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.53)', justifyContent: 'flex-end' },
  panel: {
    backgroundColor: c.bg,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  handle: {
    width: 40, height: 4, backgroundColor: c.surfaceSolid,
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  title: {
    fontSize: 17, fontWeight: 'bold', color: c.text,
    textAlign: 'center', marginBottom: 8,
  },
  option: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    minHeight: 44, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10,
    marginBottom: 6, backgroundColor: c.surfaceSolid,
    borderWidth: 0.5, borderColor: c.glassStroke,
  },
  optionActive:     { backgroundColor: c.glass, borderColor: c.primary },
  optionText:       { fontSize: 15, color: c.text },
  optionTextActive: { color: c.primary, fontWeight: 'bold' },
});
