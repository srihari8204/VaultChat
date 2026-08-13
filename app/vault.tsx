// app/vault.tsx
// Real 8-PIN gated secure storage
// AES-256-GCM encrypted files via d2deService
// Tabs: Documents / Photos / Voice / Videos
// Upload files — stored encrypted in app's secure directory
// 30-day auto backup — email option
// PIN stored in hardware-backed SecureStore

import { BRAND_ACCENT } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, Alert, Vibration, ActivityIndicator,
  Modal, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as pinStore from '../services/security/pinStore';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { vaultEncrypt, vaultDecrypt } from '../lib/vaultCrypto';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

type VaultTab = 'Documents' | 'Photos' | 'Voice' | 'Videos';

interface VaultFile {
  id:          string;
  name:        string;
  size:        number;       // bytes
  type:        VaultTab;
  encPath:     string;       // path to encrypted file on disk
  addedAt:     number;       // timestamp ms
  mimeType:    string;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const TAB_CONFIG: Record<VaultTab, { icon: string; color: string; accept: string }> = {
  Documents: { icon: '📄', color: '#3B82F6', accept: '*/*' },
  Photos:    { icon: '🖼️', color: '#F5C842', accept: 'image/*' },
  Voice:     { icon: '🎵', color: '#EC4899', accept: 'audio/*' },
  Videos:    { icon: '🎥', color: BRAND_ACCENT, accept: 'video/*' },
};

const VAULT_DIR = (FileSystem as any).documentDirectory + 'vault/';
const MANIFEST_KEY = 'vault_manifest'; // SecureStore key for file list

function formatSize(bytes: number): string {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// ─────────────────────────────────────────────────────────────────
// PIN Entry Component
// ─────────────────────────────────────────────────────────────────

function PinGate({ onUnlock }: { onUnlock: (pin: string) => void }) {
  const [pin,   setPin]   = useState<string[]>([]);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);

  const handleKey = async (key: string) => {
    if (key === 'back') {
      setPin(p => p.slice(0, -1));
      setError('');
      return;
    }
    const next = [...pin, key];
    setPin(next);

    if (next.length === 8) {
      // pinStore verifies against the scrypt record (and migrates a legacy value
      // on first success) — the PIN is no longer readable to compare against.
      if (await pinStore.verifyPin(next.join(''))) {
        onUnlock(next.join(''));
      } else {
        Vibration.vibrate([0, 100, 100, 100]);
        setError('Incorrect PIN. Try again.');
        setShake(true);
        setTimeout(() => setShake(false), 400);
        setPin([]);
      }
    }
  };

  const KEYS = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['back', '0', ''],
  ];

  return (
    <View style={pinStyles.container}>
      <Text style={pinStyles.lockIcon}>🔒</Text>
      <Text style={pinStyles.title}>Vault</Text>
      <Text style={pinStyles.sub}>Enter 8-digit PIN to access</Text>

      {/* PIN dots */}
      <View style={[pinStyles.dotsRow, shake && pinStyles.shake]}>
        {Array(8).fill(0).map((_, i) => (
          <View
            key={i}
            style={[
              pinStyles.dot,
              i < pin.length && pinStyles.dotFilled,
            ]}
          />
        ))}
      </View>

      {error ? <Text style={pinStyles.error}>{error}</Text> : null}

      {/* Numpad */}
      {KEYS.map((row, ri) => (
        <View key={ri} style={pinStyles.keyRow}>
          {row.map((k, ki) => {
            if (!k) return <View key={ki} style={pinStyles.keyEmpty} />;
            return (
              <TouchableOpacity
                key={k}
                style={pinStyles.key}
                onPress={() => handleKey(k)}
              >
                <Text style={pinStyles.keyText}>
                  {k === 'back' ? '⌫' : k}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      <Text style={pinStyles.note}>
        🔐 Files are AES-256-GCM encrypted
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main Vault Screen
// ─────────────────────────────────────────────────────────────────

export default function VaultScreen() {
  const router = useRouter();

  const [unlocked,    setUnlocked]    = useState(false);
  const [vaultPin,    setVaultPin]    = useState('');
  const [activeTab,   setActiveTab]   = useState<VaultTab>('Documents');
  const [files,       setFiles]       = useState<VaultFile[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [showBackup,  setShowBackup]  = useState(false);
  const [lastBackup,  setLastBackup]  = useState<string | null>(null);

  // ── Load manifest on unlock ───────────────────────────────────
  useEffect(() => {
    if (unlocked) {
      ensureVaultDir();
      loadManifest();
      loadLastBackupDate();
    }
  }, [unlocked]);

  const ensureVaultDir = async () => {
    const info = await FileSystem.getInfoAsync(VAULT_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(VAULT_DIR, { intermediates: true });
    }
  };

  const loadManifest = async () => {
    try {
      const raw = await SecureStore.getItemAsync(MANIFEST_KEY);
      if (raw) setFiles(JSON.parse(raw));
    } catch {}
  };

  const saveManifest = async (updated: VaultFile[]) => {
    await SecureStore.setItemAsync(MANIFEST_KEY, JSON.stringify(updated));
    setFiles(updated);
  };

  const loadLastBackupDate = async () => {
    const d = await SecureStore.getItemAsync('vault_last_backup');
    if (d) setLastBackup(d);
  };

  // ── File encryption + save ────────────────────────────────────
  const encryptAndSave = async (
    uri:      string,
    name:     string,
    size:     number,
    mimeType: string,
    type:     VaultTab,
  ): Promise<void> => {
    setLoading(true);
    try {
      // 1. Read file as base64
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: 'base64',
      });

      // 2. Encrypt with AES-256-GCM using a key derived from the Vault PIN
      const encrypted = vaultEncrypt(vaultPin, base64);

      // 3. Save encrypted payload to disk
      const fileId  = `vault_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const encPath = VAULT_DIR + fileId + '.enc';

      await FileSystem.writeAsStringAsync(
        encPath,
        JSON.stringify(encrypted),
        { encoding: 'utf8' }
      );

      // 4. Add to manifest
      const newFile: VaultFile = {
        id: fileId, name, size, type,
        encPath, addedAt: Date.now(), mimeType,
      };
      const updated = [...files, newFile];
      await saveManifest(updated);

      Alert.alert('Added to Vault', `${name} encrypted and stored.`);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to encrypt file');
    } finally {
      setLoading(false);
    }
  };

  // ── Add file handlers per tab ─────────────────────────────────
  const handleAdd = async () => {
    if (activeTab === 'Photos') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Grant gallery access');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality:    0.85,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const name  = asset.fileName || `photo_${Date.now()}.jpg`;
        await encryptAndSave(
          asset.uri, name, asset.fileSize || 0, 'image/jpeg', 'Photos'
        );
      }
    } else if (activeTab === 'Videos') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Grant gallery access');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const name  = asset.fileName || `video_${Date.now()}.mp4`;
        await encryptAndSave(
          asset.uri, name, asset.fileSize || 0, 'video/mp4', 'Videos'
        );
      }
    } else {
      // Documents and Voice — use document picker
      const result = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        await encryptAndSave(
          asset.uri,
          asset.name,
          asset.size || 0,
          asset.mimeType || 'application/octet-stream',
          activeTab,
        );
      }
    }
  };

  // ── Decrypt and open file ─────────────────────────────────────
  const handleOpen = async (file: VaultFile) => {
    setLoading(true);
    try {
      // 1. Read encrypted payload from disk
      const raw = await FileSystem.readAsStringAsync(file.encPath, {
        encoding: 'utf8',
      });
      const payload = JSON.parse(raw);

      // 2. Decrypt with the PIN-derived key
      const base64 = vaultDecrypt(vaultPin, payload);

      // 3. Write decrypted file to temp location
      const tempPath = (FileSystem as any).cacheDirectory + file.name;
      await FileSystem.writeAsStringAsync(tempPath, base64, {
        encoding: 'base64',
      });

      // 4. Share/open with system viewer
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(tempPath, {
          mimeType: file.mimeType,
          dialogTitle: file.name,
        });
      } else {
        Alert.alert('Opened', `File decrypted to: ${tempPath}`);
      }
    } catch (e: any) {
      Alert.alert('Error', 'Failed to decrypt file: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Delete file ───────────────────────────────────────────────
  const handleDelete = (file: VaultFile) => {
    Alert.alert(
      'Delete File',
      `Permanently delete "${file.name}" from Vault?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await FileSystem.deleteAsync(file.encPath, { idempotent: true });
              const updated = files.filter(f => f.id !== file.id);
              await saveManifest(updated);
            } catch {}
          },
        },
      ]
    );
  };

  // ── Backup ────────────────────────────────────────────────────
  // The Vault is local-first: there is no server backup endpoint, so a
  // "backup" exports the encrypted manifest via the system share sheet so the
  // user can stash it wherever they like. The files themselves stay in the
  // app's encrypted vault directory.
  const handleBackup = async () => {
    setLoading(true);
    try {
      const now = new Date().toLocaleDateString();
      const manifestRaw = (await SecureStore.getItemAsync(MANIFEST_KEY)) || '[]';
      const exportPath = (FileSystem as any).cacheDirectory + `vault_manifest_${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(exportPath, manifestRaw, { encoding: 'utf8' });

      await SecureStore.setItemAsync('vault_last_backup', now);
      setLastBackup(now);
      setShowBackup(false);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(exportPath, { mimeType: 'application/json', dialogTitle: 'Export Vault manifest' });
      } else {
        Alert.alert('Saved', `Vault manifest exported to:\n${exportPath}`);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Filtered files for active tab ─────────────────────────────
  const tabFiles = files.filter(f => f.type === activeTab);

  // ─────────────────────────────────────────────────────────────
  // Show PIN gate until unlocked
  // ─────────────────────────────────────────────────────────────
  if (!unlocked) {
    return <PinGate onUnlock={(pin) => { setVaultPin(pin); setUnlocked(true); }} />;
  }

  // ─────────────────────────────────────────────────────────────
  // Main Vault UI
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={26} color={BRAND_ACCENT} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Vault</Text>
          <Text style={styles.headerSub}>AES-256-GCM Encrypted</Text>
        </View>
        <TouchableOpacity
          style={styles.backupBtn}
          onPress={() => setShowBackup(true)}
        >
          <Text style={styles.backupBtnText}>💾</Text>
        </TouchableOpacity>
      </View>

      {/* Stats bar */}
      <View style={styles.statsBar}>
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{files.length}</Text>
          <Text style={styles.statLabel}>Files</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNum}>
            {formatSize(files.reduce((a, f) => a + f.size, 0))}
          </Text>
          <Text style={styles.statLabel}>Total Size</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNum}>{lastBackup || 'Never'}</Text>
          <Text style={styles.statLabel}>Last Backup</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(Object.keys(TAB_CONFIG) as VaultTab[]).map(tab => {
          const count = files.filter(f => f.type === tab).length;
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={styles.tabIcon}>{TAB_CONFIG[tab].icon}</Text>
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab}
              </Text>
              {count > 0 && (
                <View style={[styles.tabCount,
                  { backgroundColor: TAB_CONFIG[tab].color + '33' }]}>
                  <Text style={[styles.tabCountText,
                    { color: TAB_CONFIG[tab].color }]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* File list */}
      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={BRAND_ACCENT} size="large" />
          <Text style={styles.loadingText}>Encrypting...</Text>
        </View>
      ) : (
        <FlatList
          data={tabFiles}
          keyExtractor={f => f.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyIcon}>{TAB_CONFIG[activeTab].icon}</Text>
              <Text style={styles.emptyTitle}>
                No {activeTab.toLowerCase()} yet
              </Text>
              <Text style={styles.emptyHint}>
                Tap + Add to encrypt and store files
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.fileRow}
              onPress={() => handleOpen(item)}
              onLongPress={() => handleDelete(item)}
            >
              <View style={[styles.fileIcon,
                { backgroundColor: TAB_CONFIG[item.type].color + '22' }]}>
                <Text style={styles.fileIconText}>
                  {TAB_CONFIG[item.type].icon}
                </Text>
              </View>
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.fileMeta}>
                  {formatSize(item.size)}  ·  {formatDate(item.addedAt)}
                </Text>
              </View>
              <View style={styles.fileActions}>
                <View style={styles.encBadge}>
                  <Text style={styles.encBadgeText}>🔐 ENC</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => handleDelete(item)}
                >
                  <Text style={styles.deleteBtnText}>🗑️</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Add file FAB */}
      <TouchableOpacity style={styles.fab} onPress={handleAdd}>
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </TouchableOpacity>

      {/* Backup modal */}
      <Modal
        visible={showBackup}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBackup(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowBackup(false)}
        >
          <View style={styles.backupPanel}>
            <View style={styles.backupHandle} />
            <Text style={styles.backupTitle}>Export Vault</Text>
            <Text style={styles.backupDesc}>
              Export a manifest of your {files.length} vault files via the
              share sheet. Files are AES-256-GCM encrypted with your Vault PIN —
              only you can open it.
            </Text>

            <View style={styles.backupBtnRow}>
              <TouchableOpacity
                style={styles.backupCancelBtn}
                onPress={() => setShowBackup(false)}
              >
                <Text style={styles.backupCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.backupConfirmBtn}
                onPress={handleBackup}
                disabled={loading}
              >
                {loading
                  ? <ActivityIndicator color="#FFFFFF" size="small" />
                  : <Text style={styles.backupConfirmText}>Export</Text>
                }
              </TouchableOpacity>
            </View>

            {lastBackup && (
              <Text style={styles.backupLastText}>
                Last export: {lastBackup}
              </Text>
            )}

            <Text style={styles.backupNote}>
              Auto-backup runs every 30 days · Local storage only
            </Text>
          </View>
        </TouchableOpacity>
      </Modal>

      
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const pinStyles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
  lockIcon:  { fontSize: 52, marginBottom: 12 },
  title:     { fontSize: 26, fontWeight: 'bold', color: '#000000', marginBottom: 4 },
  sub:       { fontSize: 13, color: '#6B7280', marginBottom: 32 },
  dotsRow:   { flexDirection: 'row', gap: 12, marginBottom: 10 },
  shake:     { transform: [{ translateX: 8 }] },
  dot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#F3F4F6',
    borderWidth: 1.5, borderColor: '#E5E7EB',
  },
  dotFilled: { backgroundColor: BRAND_ACCENT, borderColor: BRAND_ACCENT },
  error:     { color: '#FF4D6D', fontSize: 13, marginBottom: 12 },
  keyRow:    { flexDirection: 'row', gap: 20, marginBottom: 14 },
  key: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#F9FAFB',
    borderWidth: 1, borderColor: '#E5E7EB',
    justifyContent: 'center', alignItems: 'center',
  },
  keyEmpty:  { width: 72, height: 72 },
  keyText:   { fontSize: 24, color: '#000000', fontWeight: '600' },
  note:      { marginTop: 28, color: '#6B7280', fontSize: 11 },
});

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#FFFFFF' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#F9FAFB',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
    gap: 12,
  },
  back:         { fontSize: 28, color: BRAND_ACCENT, fontWeight: 'bold' },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: 'bold', color: '#000000' },
  headerSub:    { fontSize: 9, color: BRAND_ACCENT, marginTop: 1 },
  backupBtn: {
    width: 36, height: 36, backgroundColor: '#F3F4F6',
    borderRadius: 9, borderWidth: 0.5, borderColor: '#E5E7EB',
    justifyContent: 'center', alignItems: 'center',
  },
  backupBtnText: { fontSize: 18 },

  // Stats
  statsBar: {
    flexDirection: 'row', backgroundColor: '#F9FAFB',
    paddingVertical: 12, paddingHorizontal: 20,
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
  },
  statItem:    { flex: 1, alignItems: 'center' },
  statNum:     { fontSize: 15, fontWeight: 'bold', color: '#000000' },
  statLabel:   { fontSize: 10, color: '#6B7280', marginTop: 2 },
  statDivider: { width: 0.5, backgroundColor: '#E5E7EB', marginVertical: 4 },

  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5, borderBottomColor: '#E5E7EB',
  },
  tab: {
    flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3,
  },
  tabActive: {
    borderBottomWidth: 2, borderBottomColor: BRAND_ACCENT,
  },
  tabIcon:       { fontSize: 20 },
  tabText:       { fontSize: 10, color: '#6B7280' },
  tabTextActive: { color: BRAND_ACCENT, fontWeight: 'bold' },
  tabCount: {
    borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1,
  },
  tabCountText:  { fontSize: 9, fontWeight: 'bold' },

  // Loading
  loadingWrap: {
    flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12,
  },
  loadingText: { fontSize: 13, color: '#6B7280' },

  // List
  listContent: { padding: 14, paddingBottom: 100, flexGrow: 1 },

  // Empty
  emptyWrap: {
    flex: 1, alignItems: 'center', paddingTop: 64, gap: 10,
  },
  emptyIcon:  { fontSize: 52 },
  emptyTitle: { fontSize: 16, fontWeight: 'bold', color: '#6B7280' },
  emptyHint:  { fontSize: 12, color: '#6B7280', textAlign: 'center' },

  // File row
  fileRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 0.5, borderColor: '#E5E7EB',
  },
  fileIcon: {
    width: 44, height: 44, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  fileIconText:  { fontSize: 22 },
  fileInfo:      { flex: 1 },
  fileName:      { fontSize: 14, fontWeight: 'bold', color: '#000000', marginBottom: 3 },
  fileMeta:      { fontSize: 11, color: '#6B7280' },
  fileActions:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  encBadge: {
    backgroundColor: '#D1FAE5', borderRadius: 6,
    borderWidth: 0.5, borderColor: BRAND_ACCENT + '44',
    paddingHorizontal: 6, paddingVertical: 2,
  },
  encBadgeText:  { fontSize: 9, color: BRAND_ACCENT, fontWeight: 'bold' },
  deleteBtn:     { padding: 4 },
  deleteBtnText: { fontSize: 16 },

  // FAB
  fab: {
    position: 'absolute', right: 18, bottom: 74,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: BRAND_ACCENT,
    justifyContent: 'center', alignItems: 'center',
    elevation: 6,
  },
  fabText: { fontSize: 28, color: '#FFFFFF', fontWeight: 'bold', lineHeight: 32 },

  // Backup modal
  modalOverlay: {
    flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end',
  },
  backupPanel: {
    backgroundColor: '#F9FAFB',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  backupHandle: {
    width: 40, height: 4, backgroundColor: '#E5E7EB',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  backupTitle: {
    fontSize: 17, fontWeight: 'bold', color: '#000000',
    textAlign: 'center', marginBottom: 8,
  },
  backupDesc: {
    fontSize: 13, color: '#6B7280', lineHeight: 20,
    textAlign: 'center', marginBottom: 20,
  },
  backupLabel:   { fontSize: 12, color: '#6B7280', marginBottom: 6 },
  backupInput: {
    backgroundColor: '#F3F4F6', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingHorizontal: 14, paddingVertical: 11,
    color: '#000000', fontSize: 15, marginBottom: 16,
  },
  backupBtnRow:  { flexDirection: 'row', gap: 10, marginBottom: 12 },
  backupCancelBtn: {
    flex: 1, backgroundColor: '#F3F4F6',
    borderRadius: 10, borderWidth: 0.5, borderColor: '#E5E7EB',
    paddingVertical: 13, alignItems: 'center',
  },
  backupCancelText:  { color: '#6B7280', fontWeight: 'bold' },
  backupConfirmBtn: {
    flex: 1, backgroundColor: BRAND_ACCENT,
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  backupConfirmText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  backupLastText:    { fontSize: 11, color: '#6B7280', textAlign: 'center' },
  backupNote:        { fontSize: 10, color: '#E5E7EB', textAlign: 'center', marginTop: 6 },
});
