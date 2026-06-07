// app/vault-features.tsx
// VaultChat premium security features
//
// 1. Temp Chat Codes — generate a time-limited invite code
//    that auto-expires and can only be used once
// 2. Disappearing Messages — set default timer for all chats
// 3. Fake PIN (Decoy Mode) — secondary PIN that opens a clean
//    decoy account with no messages
// 4. Screen Lock Timer — auto-lock after X minutes of inactivity
// 5. Email Share — share encrypted chat transcript via email
// 6. Chat Backup — export encrypted backup to email

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Switch, Alert, ActivityIndicator,
  Modal, TextInput, Share,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { createSyncCode } from '../lib/chatService';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

type DisappearTimer = 'off' | '5m' | '1h' | '24h' | '7d' | '30d' | '90d';
type LockTimer      = '1m' | '5m' | '15m' | '30m' | 'never';

interface VaultSettings {
  disappearTimer:     DisappearTimer;
  lockTimer:          LockTimer;
  fakePinEnabled:     boolean;
  screenshotAlert:    boolean;
  incognitoKeyboard:  boolean;
  hidePreviewInApp:   boolean;
  hideChatPreview:    boolean;
}

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const DISAPPEAR_OPTIONS: { label: string; value: DisappearTimer }[] = [
  { label: 'Off',      value: 'off' },
  { label: '5 min',   value: '5m'  },
  { label: '1 hour',  value: '1h'  },
  { label: '24 hours',value: '24h' },
  { label: '7 days',  value: '7d'  },
  { label: '30 days', value: '30d' },
  { label: '90 days', value: '90d' },
];

const LOCK_OPTIONS: { label: string; value: LockTimer }[] = [
  { label: '1 minute',  value: '1m'    },
  { label: '5 minutes', value: '5m'    },
  { label: '15 minutes',value: '15m'   },
  { label: '30 minutes',value: '30m'   },
  { label: 'Never',     value: 'never' },
];

const DEFAULT_SETTINGS: VaultSettings = {
  disappearTimer:    'off',
  lockTimer:         '5m',
  fakePinEnabled:    false,
  screenshotAlert:   true,
  incognitoKeyboard: true,
  hidePreviewInApp:  true,
  hideChatPreview:   false,
};

// ─────────────────────────────────────────────────────────────────
// Generate temp chat code — 8 chars, alphanumeric
// ─────────────────────────────────────────────────────────────────

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  // Format as XXXX-XXXX
  return code.slice(0, 4) + '-' + code.slice(4);
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function VaultFeaturesScreen() {
  const router = useRouter();

  const [settings,      setSettings]      = useState<VaultSettings>(DEFAULT_SETTINGS);

  // Temp chat code
  const [chatCode,      setChatCode]      = useState<string | null>(null);
  const [codeExpiry,    setCodeExpiry]    = useState<string | null>(null);
  const [generatingCode,setGeneratingCode]= useState(false);
  const [codeCopied,    setCodeCopied]    = useState(false);

  // Fake PIN modal
  const [showFakePin,   setShowFakePin]   = useState(false);
  const [fakePin,       setFakePin]       = useState('');
  const [fakePinConfirm,setFakePinConfirm]= useState('');
  const [savingFakePin, setSavingFakePin] = useState(false);

  // Disappear picker modal
  const [showDisappear, setShowDisappear] = useState(false);
  // Lock timer picker modal
  const [showLock,      setShowLock]      = useState(false);

  // ── Load settings ─────────────────────────────────────────────
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const raw = await SecureStore.getItemAsync('vault_features_settings');
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });

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
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    // Device-local preferences (no server enforcement layer).
    await SecureStore.setItemAsync(
      'vault_features_settings',
      JSON.stringify(updated)
    );
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
        message: `Join me on VaultChat — use this secure invite code:\n\n${chatCode}\n\nExpires in 5 minutes. Enter it under Add Contact → Enter Their Code.`,
        title:   'VaultChat Secure Invite',
      });
    } catch {}
  };

  const handleRevokeCode = async () => {
    Alert.alert('Revoke Code', 'This will invalidate the current invite code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: async () => {
          await SecureStore.deleteItemAsync('vault_chat_code');
          await SecureStore.deleteItemAsync('vault_chat_code_expiry');
          setChatCode(null);
          setCodeExpiry(null);
        },
      },
    ]);
  };

  // ── Fake PIN ──────────────────────────────────────────────────
  const handleSaveFakePin = async () => {
    if (fakePin.length !== 8) {
      Alert.alert('Error', 'Fake PIN must be 8 digits');
      return;
    }
    if (fakePin !== fakePinConfirm) {
      Alert.alert('Error', 'PINs do not match');
      return;
    }
    // Check it's different from real PIN
    const realPin = await SecureStore.getItemAsync('vault_pin');
    if (fakePin === realPin) {
      Alert.alert('Error', 'Fake PIN must be different from your real PIN');
      return;
    }

    setSavingFakePin(true);
    try {
      await SecureStore.setItemAsync('vault_fake_pin', fakePin);
      await saveSetting('fakePinEnabled', true);
      setShowFakePin(false);
      setFakePin('');
      setFakePinConfirm('');
      Alert.alert(
        'Decoy Mode Enabled',
        'When someone enters this PIN, they will see an empty VaultChat account with no messages or contacts.'
      );
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setSavingFakePin(false);
    }
  };

  const handleDisableFakePin = async () => {
    Alert.alert('Disable Decoy Mode', 'Remove the fake PIN?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disable', style: 'destructive',
        onPress: async () => {
          await SecureStore.deleteItemAsync('vault_fake_pin');
          await saveSetting('fakePinEnabled', false);
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

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>‹</Text>
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
              <Text style={styles.sectionDesc}>
                Single-use invite code — expires in 24 hours
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

        {/* ── 2. Disappearing Messages ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>⏱️</Text>
            <View>
              <Text style={styles.sectionTitle}>Disappearing Messages</Text>
              <Text style={styles.sectionDesc}>
                Auto-delete all new messages after set time
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowDisappear(true)}
          >
            <Text style={styles.pickerLabel}>Default timer</Text>
            <View style={styles.pickerValue}>
              <Text style={styles.pickerValueText}>
                {DISAPPEAR_OPTIONS.find(o => o.value === settings.disappearTimer)?.label}
              </Text>
              <Text style={styles.pickerChevron}>›</Text>
            </View>
          </TouchableOpacity>

          {settings.disappearTimer !== 'off' && (
            <View style={styles.infoBanner}>
              <Text style={styles.infoBannerText}>
                ⏱️  All new messages will auto-delete after{' '}
                {DISAPPEAR_OPTIONS.find(o => o.value === settings.disappearTimer)?.label}
              </Text>
            </View>
          )}
        </View>

        {/* ── 3. Decoy Mode (Fake PIN) ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>🎭</Text>
            <View>
              <Text style={styles.sectionTitle}>Decoy Mode</Text>
              <Text style={styles.sectionDesc}>
                Fake PIN opens an empty decoy account
              </Text>
            </View>
            <Switch
              style={{ marginLeft: 'auto' }}
              value={settings.fakePinEnabled}
              onValueChange={v => {
                if (v) setShowFakePin(true);
                else   handleDisableFakePin();
              }}
              trackColor={{ false: '#E5E7EB', true: '#D1FAE5' }}
              thumbColor={settings.fakePinEnabled ? '#10B981' : '#6B7280'}
            />
          </View>

          {settings.fakePinEnabled && (
            <View style={styles.infoBanner}>
              <Text style={styles.infoBannerText}>
                🎭  Decoy mode active — entering fake PIN shows empty account
              </Text>
            </View>
          )}
        </View>

        {/* ── 4. Auto Screen Lock ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionIcon}>🔒</Text>
            <View>
              <Text style={styles.sectionTitle}>Auto Screen Lock</Text>
              <Text style={styles.sectionDesc}>
                Lock app after inactivity
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.pickerRow}
            onPress={() => setShowLock(true)}
          >
            <Text style={styles.pickerLabel}>Lock after</Text>
            <View style={styles.pickerValue}>
              <Text style={styles.pickerValueText}>
                {LOCK_OPTIONS.find(o => o.value === settings.lockTimer)?.label}
              </Text>
              <Text style={styles.pickerChevron}>›</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* ── 5. Privacy toggles ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel}>PRIVACY SETTINGS</Text>

          {[
            {
              key:   'screenshotAlert',
              icon:  '📸',
              title: 'Screenshot Alerts',
              desc:  'Notify you when someone screenshots your status',
            },
            {
              key:   'incognitoKeyboard',
              icon:  '⌨️',
              title: 'Incognito Keyboard',
              desc:  'Prevent keyboard from learning your messages',
            },
            {
              key:   'hidePreviewInApp',
              icon:  '🫥',
              title: 'Hide In-App Previews',
              desc:  'Blur notification previews inside app',
            },
            {
              key:   'hideChatPreview',
              icon:  '🔕',
              title: 'Hide Chat Preview',
              desc:  'Hide message text in notification tray',
            },
          ].map(({ key, icon, title, desc }) => (
            <View key={key} style={styles.toggleRow}>
              <Text style={styles.toggleIcon}>{icon}</Text>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleTitle}>{title}</Text>
                <Text style={styles.toggleDesc}>{desc}</Text>
              </View>
              <Switch
                value={settings[key as keyof VaultSettings] as boolean}
                onValueChange={v => saveSetting(key as keyof VaultSettings, v)}
                trackColor={{ false: '#E5E7EB', true: '#D1FAE5' }}
                thumbColor={
                  settings[key as keyof VaultSettings] ? '#10B981' : '#6B7280'
                }
              />
            </View>
          ))}
        </View>

        {/* ── 6. Export / Share ── */}
        <View style={styles.section}>
          <Text style={styles.toggleSectionLabel}>EXPORT</Text>

          <TouchableOpacity
            style={styles.exportRow}
            onPress={() => Alert.alert(
              'Export Chat',
              'Select a chat to export an encrypted transcript.',
              [{ text: 'OK', onPress: () => router.push('/(tabs)/chats') }]
            )}
          >
            <Text style={styles.exportIcon}>📧</Text>
            <View style={styles.exportInfo}>
              <Text style={styles.exportTitle}>Email Encrypted Transcript</Text>
              <Text style={styles.exportDesc}>Share a chat history via email</Text>
            </View>
            <Text style={styles.exportChevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.exportRow}
            onPress={() => router.push('/vault')}
          >
            <Text style={styles.exportIcon}>🔒</Text>
            <View style={styles.exportInfo}>
              <Text style={styles.exportTitle}>Vault Backup</Text>
              <Text style={styles.exportDesc}>Backup vault files to email</Text>
            </View>
            <Text style={styles.exportChevron}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Disappearing messages picker ── */}
      <Modal
        visible={showDisappear}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDisappear(false)}
      >
        <TouchableOpacity
          style={modalStyles.overlay}
          activeOpacity={1}
          onPress={() => setShowDisappear(false)}
        >
          <View style={modalStyles.panel}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>Disappearing Messages</Text>
            {DISAPPEAR_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  modalStyles.option,
                  settings.disappearTimer === opt.value && modalStyles.optionActive,
                ]}
                onPress={() => {
                  saveSetting('disappearTimer', opt.value);
                  setShowDisappear(false);
                }}
              >
                <Text style={[
                  modalStyles.optionText,
                  settings.disappearTimer === opt.value && modalStyles.optionTextActive,
                ]}>
                  {opt.label}
                </Text>
                {settings.disappearTimer === opt.value && (
                  <Text style={modalStyles.checkmark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

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
                  <Text style={modalStyles.checkmark}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── Fake PIN setup modal ── */}
      <Modal
        visible={showFakePin}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFakePin(false)}
      >
        <TouchableOpacity
          style={modalStyles.overlay}
          activeOpacity={1}
          onPress={() => setShowFakePin(false)}
        >
          <View style={modalStyles.panel}>
            <View style={modalStyles.handle} />
            <Text style={modalStyles.title}>🎭 Set Decoy PIN</Text>
            <Text style={modalStyles.subtitle}>
              When this PIN is entered, a clean empty account is shown.
              Your real messages stay hidden.
            </Text>

            <Text style={modalStyles.inputLabel}>Fake PIN (8 digits)</Text>
            <TextInput
              style={modalStyles.pinInput}
              value={fakePin}
              onChangeText={v => setFakePin(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={8}
              secureTextEntry
              placeholder="8-digit PIN"
              placeholderTextColor="#6B7280"
            />

            <Text style={modalStyles.inputLabel}>Confirm Fake PIN</Text>
            <TextInput
              style={modalStyles.pinInput}
              value={fakePinConfirm}
              onChangeText={v => setFakePinConfirm(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={8}
              secureTextEntry
              placeholder="Confirm PIN"
              placeholderTextColor="#6B7280"
            />

            <View style={modalStyles.btnRow}>
              <TouchableOpacity
                style={modalStyles.cancelBtn}
                onPress={() => { setShowFakePin(false); setFakePin(''); setFakePinConfirm(''); }}
              >
                <Text style={modalStyles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modalStyles.confirmBtn, savingFakePin && modalStyles.confirmBtnDim]}
                onPress={handleSaveFakePin}
                disabled={savingFakePin}
              >
                {savingFakePin
                  ? <ActivityIndicator color="#FFFFFF" size="small" />
                  : <Text style={modalStyles.confirmText}>Enable Decoy</Text>
                }
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#F9FAFB',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB', gap: 12,
  },
  back:          { fontSize: 28, color: '#10B981', fontWeight: 'bold' },
  headerCenter:  { flex: 1 },
  headerTitle:   { fontSize: 18, fontWeight: 'bold', color: '#000000' },
  headerSub:     { fontSize: 9, color: '#10B981', marginTop: 1, fontWeight: 'bold' },
  headerBadge:   { fontSize: 22 },

  scroll:        { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 60 },

  // Section
  section: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14, borderWidth: 0.5, borderColor: '#E5E7EB',
    padding: 16, marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14,
  },
  sectionIcon:   { fontSize: 26, marginTop: 2 },
  sectionTitle:  { fontSize: 15, fontWeight: 'bold', color: '#000000', marginBottom: 3 },
  sectionDesc:   { fontSize: 12, color: '#6B7280', lineHeight: 17 },

  // Temp chat code
  codeCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    padding: 14, alignItems: 'center', gap: 6,
  },
  codeValue: {
    fontSize: 28, fontWeight: 'bold', color: '#10B981',
    letterSpacing: 3, fontFamily: 'monospace',
  },
  codeExpiry:   { fontSize: 11, color: '#6B7280', marginBottom: 4 },
  codeActions:  { flexDirection: 'row', gap: 8, marginTop: 4 },
  codeBtn: {
    backgroundColor: '#F3F4F6', borderRadius: 8,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingHorizontal: 12, paddingVertical: 7,
  },
  codeBtnCopied:    { backgroundColor: '#D1FAE5', borderColor: '#10B981' },
  codeBtnRevoke:    { borderColor: '#FF4D6D44' },
  codeBtnText:      { fontSize: 12, color: '#000000' },
  codeBtnTextRevoke:{ color: '#FF4D6D' },

  actionBtn: {
    backgroundColor: '#10B981', borderRadius: 10,
    paddingVertical: 12, alignItems: 'center',
  },
  actionBtnDim:   { backgroundColor: '#D1FAE5' },
  actionBtnText:  { color: '#FFFFFF', fontWeight: 'bold', fontSize: 14 },

  // Picker row
  pickerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#F3F4F6', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  pickerLabel:      { fontSize: 14, color: '#000000' },
  pickerValue:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pickerValueText:  { fontSize: 14, color: '#10B981', fontWeight: 'bold' },
  pickerChevron:    { fontSize: 18, color: '#6B7280' },

  // Info banner
  infoBanner: {
    backgroundColor: '#D1FAE520', borderRadius: 8,
    borderWidth: 0.5, borderColor: '#10B98133',
    paddingHorizontal: 12, paddingVertical: 7, marginTop: 10,
  },
  infoBannerText: { fontSize: 12, color: '#10B981', lineHeight: 17 },

  // Toggle section
  toggleSectionLabel: {
    fontSize: 10, fontWeight: 'bold', color: '#6B7280',
    letterSpacing: 0.8, marginBottom: 10,
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#F3F4F6',
  },
  toggleIcon:   { fontSize: 20 },
  toggleInfo:   { flex: 1 },
  toggleTitle:  { fontSize: 13, fontWeight: 'bold', color: '#000000', marginBottom: 2 },
  toggleDesc:   { fontSize: 11, color: '#6B7280', lineHeight: 15 },

  // Export rows
  exportRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, gap: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#F3F4F6',
  },
  exportIcon:    { fontSize: 22 },
  exportInfo:    { flex: 1 },
  exportTitle:   { fontSize: 13, fontWeight: 'bold', color: '#000000', marginBottom: 2 },
  exportDesc:    { fontSize: 11, color: '#6B7280' },
  exportChevron: { fontSize: 18, color: '#6B7280' },
});

const modalStyles = StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  panel: {
    backgroundColor: '#F9FAFB',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  handle: {
    width: 40, height: 4, backgroundColor: '#E5E7EB',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  title: {
    fontSize: 17, fontWeight: 'bold', color: '#000000',
    textAlign: 'center', marginBottom: 8,
  },
  subtitle: {
    fontSize: 13, color: '#6B7280', textAlign: 'center',
    lineHeight: 19, marginBottom: 16,
  },
  option: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10,
    marginBottom: 6, backgroundColor: '#F3F4F6',
    borderWidth: 0.5, borderColor: '#E5E7EB',
  },
  optionActive:     { backgroundColor: '#D1FAE5', borderColor: '#10B981' },
  optionText:       { fontSize: 15, color: '#000000' },
  optionTextActive: { color: '#10B981', fontWeight: 'bold' },
  checkmark:        { fontSize: 16, color: '#10B981', fontWeight: 'bold' },
  inputLabel:       { fontSize: 11, color: '#6B7280', marginBottom: 6, marginTop: 4 },
  pinInput: {
    backgroundColor: '#F3F4F6', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingHorizontal: 14, paddingVertical: 11,
    color: '#000000', fontSize: 20,
    letterSpacing: 4, textAlign: 'center', marginBottom: 12,
  },
  btnRow:       { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1, backgroundColor: '#F3F4F6', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingVertical: 13, alignItems: 'center',
  },
  cancelText:   { color: '#6B7280', fontWeight: 'bold' },
  confirmBtn: {
    flex: 1, backgroundColor: '#10B981',
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  confirmBtnDim:  { backgroundColor: '#D1FAE5' },
  confirmText:    { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
});
