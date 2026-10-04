import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
import { Ionicons } from '@expo/vector-icons';
// app/vault-features.tsx
// crazzychat advanced security
//
// 1. Temp Chat Codes — single-use invite code, 5-minute expiry (real backend)
// 2. Auto Screen Lock — how long the app may be in the background before it
//    asks for biometrics / MPIN again (components/ResumeLock reads it; applies
//    when Device MFA is on)
// 3. Links to the real notification-privacy controls and the Vault
//
// REMOVED 2026-10-04, because nothing read them: a "default disappearing timer"
// saved only here (the real one is Settings → Default message timer, which the
// server applies), and the Screenshot Alerts / Incognito Keyboard switches.
// Also removed: "Email Encrypted Transcript" (an alert, then the chat list) and
// "Backup vault files to email" (the vault has no backup).


import React, { useState, useEffect, useMemo } from 'react';
import {
  View, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
  Modal, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { createSyncCode } from '../lib/chatService';
import type { Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { HEADER_TOP } from '../constants/layout';
import { isMfaEnabled } from '../lib/mfa';
import { DEFAULT_LOCK_TIMER, LOCK_SETTINGS_KEY, parseLockTimer, type LockTimer } from '../lib/resumeLockPolicy';

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

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function VaultFeaturesScreen() {
  const { colors: c, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(c, scheme === 'light'), [c, scheme]);
  const modalStyles = useMemo(() => makeModalStyles(c), [c]);
  const router = useRouter();

  const [settings,      setSettings]      = useState<VaultSettings>(DEFAULT_SETTINGS);

  // Temp chat code
  const [chatCode,      setChatCode]      = useState<string | null>(null);
  const [codeExpiry,    setCodeExpiry]    = useState<string | null>(null);
  const [generatingCode,setGeneratingCode]= useState(false);
  const [codeCopied,    setCodeCopied]    = useState(false);

  // Lock timer picker modal
  const [showLock,      setShowLock]      = useState(false);
  // The relock only applies to a user with Device MFA on (the same condition
  // as the cold-launch lock); say so rather than offer a timer that does nothing.
  const [mfaOn,         setMfaOn]         = useState<boolean | null>(null);
  useEffect(() => { isMfaEnabled().then(setMfaOn).catch(() => setMfaOn(false)); }, []);

  // ── Load settings ─────────────────────────────────────────────
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const raw = await SecureStore.getItemAsync(LOCK_SETTINGS_KEY);
      setSettings({ lockTimer: parseLockTimer(raw) });

      const code   = await SecureStore.getItemAsync('vault_chat_code');
      const expiry = await SecureStore.getItemAsync('vault_chat_code_expiry');
      if (code && expiry) {
        // Check if still valid
        if (new Date(expiry) > new Date()) {
          setChatCode(code);
          setCodeExpiry(expiry);
        } else {
          // Expired — clean up
          await SecureStore.deleteItemAsync('vault_chat_code');
          await SecureStore.deleteItemAsync('vault_chat_code_expiry');
        }
      }
    } catch {}
  };

  const saveSetting = async (key: keyof VaultSettings, value: any) => {
    const prev = settings;
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    // Device-local; read by components/ResumeLock via services/lockService.
    try {
      await SecureStore.setItemAsync(LOCK_SETTINGS_KEY, JSON.stringify(updated));
    } catch {
      setSettings(prev);
      Alert.alert('Not saved', 'The setting could not be saved. Try again.');
    }
  };

  // ── Generate temp chat code ───────────────────────────────────
  const handleGenerateCode = async () => {
    setGeneratingCode(true);
    try {
      // Use the real mutual-consent sync-code backend (5-min, single-use).
      // The recipient enters it under "Add Contact → Enter Their Code".
      const { code } = await createSyncCode();
      const expiryStr = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await SecureStore.setItemAsync('vault_chat_code', code);
      await SecureStore.setItemAsync('vault_chat_code_expiry', expiryStr);

      setChatCode(code);
      setCodeExpiry(expiryStr);
      setCodeCopied(false);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleCopyCode = async () => {
    if (!chatCode) return;
    await copyAndAutoClear(chatCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const handleShareCode = async () => {
    if (!chatCode) return;
    try {
      await Share.share({
        message: `Join me on crazzychat — use this secure invite code:\n\n${chatCode}\n\nExpires in 5 minutes. Enter it under Add Contact → Enter Their Code.`,
        title:   'crazzychat Secure Invite',
      });
    } catch {}
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
  const handleRevokeCode = async () => {
    Alert.alert('Revoke Code', 'This will invalidate the current invite code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: async () => {
          try {
            await createSyncCode();
          } catch (e: any) {
            Alert.alert('Not revoked', `The code is still valid. ${e?.message ?? 'Try again.'}`);
            return;
          }
          await SecureStore.deleteItemAsync('vault_chat_code');
          await SecureStore.deleteItemAsync('vault_chat_code_expiry');
          setChatCode(null);
          setCodeExpiry(null);
        },
      },
    ]);
  };

  // ── Format expiry time ────────────────────────────────────────
  const formatExpiry = (expiryStr: string): string => {
    const expiry = new Date(expiryStr);
    const diff   = expiry.getTime() - Date.now();
    const h      = Math.floor(diff / 3600000);
    const m      = Math.floor((diff % 3600000) / 60000);
    if (h <= 0 && m <= 0) return 'Expired';
    if (h === 0) return `Expires in ${m}m`;
    return `Expires in ${h}h ${m}m`;
  };

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <AuroraBackground />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={26} color={c.primary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Vault Features</Text>
          <Text style={styles.headerSub}>ADVANCED SECURITY</Text>
        </View>
        <Text style={styles.headerBadge}>⚡</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >

        {/* ── 1. Temp Chat Codes ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>🔗</Text>
            <View>
              <Text style={styles.sectionTitle}>Temp Chat Code</Text>
              {/* "24 hours" was wrong by 288x: the server mints these with
                  INTERVAL '5 minutes' (contacts.go) and both read paths enforce
                  it with a 410. */}
              <Text style={styles.sectionDesc}>
                Single-use invite code — expires in 5 minutes
              </Text>
            </View>
          </View>

          {chatCode ? (
            <View style={styles.codeCard}>
              <Text style={styles.codeValue}>{chatCode}</Text>
              {codeExpiry && (
                <Text style={styles.codeExpiry}>{formatExpiry(codeExpiry)}</Text>
              )}
              <View style={styles.codeActions}>
                <TouchableOpacity
                  style={[styles.codeBtn, codeCopied && styles.codeBtnCopied]}
                  onPress={handleCopyCode}
                >
                  <Text style={styles.codeBtnText}>
                    {codeCopied ? '✓ Copied' : '📋 Copy'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.codeBtn}
                  onPress={handleShareCode}
                >
                  <Text style={styles.codeBtnText}>📤 Share</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.codeBtn, styles.codeBtnRevoke]}
                  onPress={handleRevokeCode}
                >
                  <Text style={[styles.codeBtnText, styles.codeBtnTextRevoke]}>
                    🗑️ Revoke
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.actionBtn, generatingCode && styles.actionBtnDim]}
              onPress={handleGenerateCode}
              disabled={generatingCode}
            >
              {generatingCode
                ? <ActivityIndicator color="#FFFFFF" size="small" />
                : <Text style={styles.actionBtnText}>Generate Invite Code</Text>
              }
            </TouchableOpacity>
          )}
        </View>

        {/* ── 2. Auto Screen Lock ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>🔒</Text>
            <View>
              <Text style={styles.sectionTitle}>Auto Screen Lock</Text>
              <Text style={styles.sectionDesc}>
                Ask for biometrics or your MPIN when you come back to the app after this long away
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowLock(true)}
            accessibilityRole="button"
            accessibilityLabel={`Lock after: ${LOCK_OPTIONS.find(o => o.value === settings.lockTimer)?.label}`}
          >
            <Text style={styles.pickerLabel}>Lock after</Text>
            <View style={styles.pickerValue}>
              <Text style={styles.pickerValueText}>
                {LOCK_OPTIONS.find(o => o.value === settings.lockTimer)?.label}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={scheme === 'light' ? c.textDim : '#9CA3AF'} />
            </View>
          </TouchableOpacity>
          {mfaOn === false && (
            <Text style={[styles.sectionDesc, { marginTop: 10 }]}>
              Turn on Device MFA in Settings → Security for this to take effect.
            </Text>
          )}
        </View>

        {/* ── 3. Privacy ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel}>PRIVACY</Text>

          <TouchableOpacity
            style={styles.exportRow}
            accessibilityRole="button"
            accessibilityLabel="Notification and link previews"
            onPress={() => router.push('/notifications')}
          >
            <Text style={styles.exportIcon}>🔕</Text>
            <View style={styles.exportInfo}>
              <Text style={styles.exportTitle}>Notification & Link Previews</Text>
              <Text style={styles.exportDesc}>Choose what notifications say, and whether links you receive are fetched</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={scheme === 'light' ? c.textDim : '#9CA3AF'} />
          </TouchableOpacity>
        </View>

        {/* ── 4. Vault ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel}>VAULT</Text>
          <TouchableOpacity
            style={styles.exportRow}
            onPress={() => router.push('/vault')}
            accessibilityRole="button"
            accessibilityLabel="Vault: encrypted files stored on this phone"
          >
            <Text style={styles.exportIcon}>🔒</Text>
            <View style={styles.exportInfo}>
              <Text style={styles.exportTitle}>Vault</Text>
              <Text style={styles.exportDesc}>Encrypted files, stored on this phone only</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={scheme === 'light' ? c.textDim : '#9CA3AF'} />
          </TouchableOpacity>
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
        <TouchableOpacity
          style={modalStyles.overlay}
          activeOpacity={1}
          onPress={() => setShowLock(false)}
        >
          <View style={modalStyles.panel}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>Auto Screen Lock</Text>
            {LOCK_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: settings.lockTimer === opt.value }}
                style={[
                  modalStyles.option,
                  settings.lockTimer === opt.value && modalStyles.optionActive,
                ]}
                onPress={() => {
                  saveSetting('lockTimer', opt.value);
                  setShowLock(false);
                }}
              >
                <Text style={[
                  modalStyles.optionText,
                  settings.lockTimer === opt.value && modalStyles.optionTextActive,
                ]}>
                  {opt.label}
                </Text>
                {settings.lockTimer === opt.value && (
                  <Ionicons name="checkmark" size={16} color={c.primary} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const makeStyles = (c: Palette, light: boolean) => StyleSheet.create({
  container:    { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke, gap: 12,
  },
  back:          { fontSize: 28, color: c.primary, fontWeight: 'bold' },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: 'bold', color: c.text },
  headerSub:     { fontSize: 12, color: c.primary, marginTop: 1, fontWeight: 'bold' },
  headerBadge:   { fontSize: 22 },

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
  sectionIcon:   { fontSize: 26, marginTop: 2 },
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
  codeExpiry:   { fontSize: 12, color: c.textDim, marginBottom: 4 },
  codeActions:  { flexWrap: 'wrap', flexDirection: 'row', gap: 8, marginTop: 4 },
  codeBtn: {
    minHeight: 44, justifyContent: 'center', backgroundColor: c.surfaceSolid, borderRadius: 8,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  codeBtnCopied:    { backgroundColor: 'rgba(34,197,94,0.14)', borderColor: c.primary },
  codeBtnRevoke:    { borderColor: '#FF4D6D44' },
  codeBtnText:      { fontSize: 12, color: c.text },
  codeBtnTextRevoke:{ color: light ? c.danger : '#FF4D6D' },

  actionBtn: {
    backgroundColor: c.primary, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  actionBtnDim:   { opacity: 0.5 },
  actionBtnText:  { color: '#FFFFFF', fontWeight: 'bold', fontSize: 14 },

  // Picker row
  pickerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.surfaceSolid, borderRadius: 10,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  pickerLabel:      { fontSize: 14, color: c.text },
  pickerValue:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pickerValueText:  { fontSize: 14, color: c.primary, fontWeight: 'bold' },
  pickerChevron:    { fontSize: 18, color: c.textDim },

  // Info banner
  infoBanner: {
    backgroundColor: '#D1FAE520', borderRadius: 8,
    borderWidth: 0.5, borderColor: c.primary + '33',
    paddingHorizontal: 12, paddingVertical: 7, marginTop: 10,
  },
  infoBannerText: { fontSize: 12, color: c.primary, lineHeight: 17 },

  // Toggle section
  toggleSectionLabel: {
    fontSize: 12, fontWeight: 'bold', color: c.textDim,
    letterSpacing: 0.8, marginBottom: 10,
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: 12,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  toggleIcon:   { fontSize: 20 },
  toggleInfo:   { flex: 1 },
  toggleTitle:  { fontSize: 13, fontWeight: 'bold', color: c.text, marginBottom: 2 },
  toggleDesc:   { fontSize: 12, color: c.textDim, lineHeight: 15 },

  // Export rows
  exportRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, gap: 12,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  exportIcon:    { fontSize: 22 },
  exportInfo:    { flex: 1 },
  exportTitle:   { fontSize: 13, fontWeight: 'bold', color: c.text, marginBottom: 2 },
  exportDesc:    { fontSize: 12, color: c.textDim },
  exportChevron: { fontSize: 18, color: c.textDim },
});

const makeModalStyles = (c: Palette) => StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
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
  subtitle: {
    fontSize: 13, color: c.textDim, textAlign: 'center',
    lineHeight: 19, marginBottom: 16,
  },
  option: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10,
    marginBottom: 6, backgroundColor: c.surfaceSolid,
    borderWidth: 0.5, borderColor: c.glassStroke,
  },
  optionActive:     { backgroundColor: 'rgba(34,197,94,0.14)', borderColor: c.primary },
  optionText:       { fontSize: 15, color: c.text },
  optionTextActive: { color: c.primary, fontWeight: 'bold' },
  checkmark:        { fontSize: 16, color: c.primary, fontWeight: 'bold' },
  inputLabel:       { fontSize: 12, color: c.textDim, marginBottom: 6, marginTop: 4 },
  pinInput: {
    backgroundColor: c.surfaceSolid, borderRadius: 10,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingHorizontal: 14, paddingVertical: 11,
    color: c.text, fontSize: 20,
    letterSpacing: 4, textAlign: 'center', marginBottom: 12,
  },
  btnRow:       { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1, backgroundColor: c.surfaceSolid, borderRadius: 10,
    borderWidth: 0.5, borderColor: c.glassStroke,
    paddingVertical: 13, alignItems: 'center',
  },
  cancelText:   { color: c.textDim, fontWeight: 'bold' },
  confirmBtn: {
    flex: 1, backgroundColor: c.primary,
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  confirmBtnDim:  { opacity: 0.5 },
  confirmText:    { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
});
