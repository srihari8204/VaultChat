// app/vault.tsx
// Device-PIN gated local file vault (the PIN set in Settings → Device PIN,
// 4–8 digits — services/security/pinFormat).
// Files are AES-256-GCM encrypted on this phone (lib/vaultCrypto v2: a random
// file key wrapped under the PIN, so changing the PIN does not orphan files).
// Tabs: Documents / Photos / Voice / Videos
// "Export file list" shares names/sizes/dates only — not the files, not encrypted.
// There is no automatic or server backup of vault files.
// Leaving the app (background) locks the vault again, except while a system
// picker or share sheet that this screen opened is in front.

import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, TouchableOpacity, StyleSheet,
  FlatList, Alert, Vibration, ActivityIndicator,
  Modal, AppState,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as pinStore from '../services/security/pinStore';
import { isPinFormat, PIN_MAX, PIN_MIN } from '../services/security/pinFormat';
import { PinPad } from '../components/PinPad';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { clearVaultKeyCache, vaultFileDecrypt, vaultFileEncrypt, type VaultKeys } from '../lib/vaultCrypto';
import { unlockVaultKeys, type VaultKeyMiss } from '../lib/vaultKeyStore';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { HEADER_TOP } from '../constants/layout';
import { permissionDenied } from '../lib/permissionDenied';
import { parseVaultManifest } from '../lib/vaultManifestParse';

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

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const TAB_CONFIG: Record<VaultTab, { icon: IconName }> = {
  Documents: { icon: 'document-text-outline' },
  Photos:    { icon: 'image-outline' },
  Voice:     { icon: 'musical-notes-outline' },
  Videos:    { icon: 'videocam-outline' },
};

const VAULT_DIR = FileSystem.documentDirectory + 'vault/';
// Decrypted copies handed to the share sheet. Each is deleted once the sheet
// returns, and the whole folder on every vault open and close, so a copy the
// share target was still reading (or a crash) cannot outlive the next visit.
const OPEN_DIR = FileSystem.cacheDirectory + 'vault-open/';
const wipeOpenDir = () => FileSystem.deleteAsync(OPEN_DIR, { idempotent: true }).catch(() => {});
/** A file name safe to use as a path segment. */
const safeName = (name: string) => name.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'file';
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

function PinGate({ onUnlock }: { onUnlock: (pin: string) => Promise<void> }) {
  const c = useColors();
  const router = useRouter();
  const pinStyles = useMemo(() => makePinStyles(c), [c]);
  const [pin,   setPin]   = useState('');
  const [error, setError] = useState('');
  const [busy,  setBusy]  = useState(false);
  // null = not checked yet. Re-checked on focus, so returning from Device PIN
  // setup shows the keypad without leaving the screen.
  const [havePin, setHavePin] = useState<boolean | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    pinStore.hasPin().then(h => { if (live) setHavePin(h); }).catch(() => { if (live) setHavePin(true); });
    return () => { live = false; };
  }, []));

  const submit = async (v: string) => {
    if (busy) return;
    if (!isPinFormat(v)) { setError(`Enter your ${PIN_MIN}–${PIN_MAX} digit Device PIN.`); return; }
    setBusy(true);
    try {
      // pinStore verifies against the scrypt record (and migrates a legacy value
      // on first success) — the PIN is no longer readable to compare against.
      if (await pinStore.verifyPin(v)) { await onUnlock(v); return; }
      // verifyPin also answers false while a brute-force backoff is running;
      // "Incorrect PIN" would then be a lie the user cannot act on.
      const wait = await pinStore.pinBackoffMs();
      Vibration.vibrate([0, 100, 100, 100]);
      setError(wait > 0
        ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`
        : 'Incorrect PIN. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  if (havePin === false) {
    return (
      <View style={pinStyles.container}>
        <AuroraBackground />
        <BackButton onPress={() => router.back()} color={c.primary} />
        <Ionicons name="lock-closed" size={52} color={c.primary} style={pinStyles.lockIcon} importantForAccessibility="no" accessibilityElementsHidden />
        <Text style={pinStyles.title} accessibilityRole="header">Vault</Text>
        <Text style={[pinStyles.sub, { textAlign: 'center', paddingHorizontal: 32 }]}>
          The vault opens with your Device PIN, and this phone does not have one yet.
        </Text>
        <TouchableOpacity
          style={pinStyles.setBtn}
          onPress={() => router.push('/backup-pin?from=settings' as any)}
          accessibilityRole="button"
          accessibilityLabel="Set a Device PIN"
        >
          <Text style={pinStyles.setBtnText}>Set a Device PIN</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={pinStyles.container}>
      <AuroraBackground />
      <BackButton onPress={() => router.back()} color={c.primary} />
      <Ionicons name="lock-closed" size={52} color={c.primary} style={pinStyles.lockIcon} importantForAccessibility="no" accessibilityElementsHidden />
      <Text style={pinStyles.title} accessibilityRole="header">Vault</Text>
      <Text style={pinStyles.sub} accessibilityLabel="Enter your Device PIN, then tap Done">Enter your Device PIN, then tap ✓</Text>

      <PinPad
        value={pin}
        onChange={(v) => { setPin(v); setError(''); }}
        length={PIN_MAX}
        minLength={PIN_MIN}
        onSubmit={submit}
        onComplete={submit}
        error={!!error}
      />

      {busy ? <ActivityIndicator color={c.primary} style={{ marginTop: 8 }} /> : null}
      {error ? <Text style={pinStyles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

      <Text style={pinStyles.note}>
        Files are AES-256-GCM encrypted
      </Text>
    </View>
  );
}

function BackButton({ onPress, color }: { onPress: () => void; color: string }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={onPress} hitSlop={8}
      style={{ position: 'absolute', top: HEADER_TOP, left: 12, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="arrow-back" size={26} color={color} />
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main Vault Screen
// ─────────────────────────────────────────────────────────────────

export default function VaultScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const router = useRouter();

  const [unlocked,    setUnlocked]    = useState(false);
  const [vaultPin,    setVaultPin]    = useState('');
  // The v2 file key. null when this PIN cannot open the key record (the PIN
  // was reset somewhere that could not re-wrap it): older files still open via
  // the PIN, new files fall back to the PIN-derived format — see vaultKeyStore.
  const [vaultKeys,   setVaultKeys]   = useState<VaultKeys | null>(null);
  const [keyMiss,     setKeyMiss]     = useState<VaultKeyMiss | undefined>(undefined);
  const [activeTab,   setActiveTab]   = useState<VaultTab>('Documents');
  const [files,       setFiles]       = useState<VaultFile[]>([]);
  // Latest saved manifest, so an add or delete never builds on a stale render.
  const filesRef = useRef<VaultFile[]>([]);
  // Writes are allowed only after a good read: saving over a manifest we could
  // not read would orphan every earlier .enc file.
  const [manifestState, setManifestState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const adding = useRef(false);
  const [loading,     setLoading]     = useState(false);
  const [loadingText, setLoadingText] = useState('Encrypting…');
  const [showBackup,  setShowBackup]  = useState(false);
  const [lastBackup,  setLastBackup]  = useState<string | null>(null);

  // Nothing decrypted outlives the screen, and the derived keys go with it.
  useEffect(() => {
    wipeOpenDir();
    return () => { wipeOpenDir(); clearVaultKeyCache(); };
  }, []);

  const unlock = async (pin: string) => {
    let res: { keys: VaultKeys | null; miss?: VaultKeyMiss };
    try { res = await unlockVaultKeys(pin); } catch { res = { keys: null, miss: 'storage' }; }
    setVaultKeys(res.keys);
    setKeyMiss(res.keys ? undefined : res.miss);
    setVaultPin(pin);
    setUnlocked(true);
  };

  // Re-lock when the app goes to the background. A picker or share sheet this
  // screen opened also backgrounds the app (Android runs it as another
  // activity), so those are bracketed by `systemUi` and do not lock.
  // ponytail: the bracket is a counter around our own awaits, not a signal
  // from the OS. If the user leaves the app from inside a picker, the vault
  // stays open until the picker returns. Replace with an OS-level signal if
  // one becomes available; needs a device check either way.
  const systemUi = useRef(0);
  const withSystemUi = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    systemUi.current++;
    try { return await fn(); } finally { systemUi.current--; }
  }, []);
  useEffect(() => {
    if (!unlocked) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'background' || systemUi.current > 0) return;
      clearVaultKeyCache();
      wipeOpenDir();
      setVaultPin('');
      setVaultKeys(null);
      setKeyMiss(undefined);
      // filesRef is left alone: the next unlock re-reads the manifest, and an
      // empty ref here is what a save would build on.
      setFiles([]);
      setShowBackup(false);
      setManifestState('loading');
      setUnlocked(false);
    });
    return () => sub.remove();
  }, [unlocked]);

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
    setManifestState('loading');
    try {
      const list = parseVaultManifest<VaultFile>(await SecureStore.getItemAsync(MANIFEST_KEY));
      filesRef.current = list;
      setFiles(list);
      setManifestState('ok');
    } catch {
      setManifestState('failed');
    }
  };

  const saveManifest = async (updated: VaultFile[]) => {
    if (manifestState !== 'ok') throw new Error('The vault file list did not load. Retry before changing it.');
    await SecureStore.setItemAsync(MANIFEST_KEY, JSON.stringify(updated));
    filesRef.current = updated;
    setFiles(updated);
  };

  const loadLastBackupDate = async () => {
    const d = await SecureStore.getItemAsync('vault_last_backup').catch(() => null);
    if (d) setLastBackup(d);
  };

  const retryKeys = async () => {
    if (vaultPin) await unlock(vaultPin);
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
      const encrypted = vaultFileEncrypt(vaultKeys, vaultPin, base64);

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
      try {
        await saveManifest([...filesRef.current, newFile]);
      } catch (e) {
        await FileSystem.deleteAsync(encPath, { idempotent: true }).catch(() => {});
        throw e;
      }

      Alert.alert('Added to Vault', `${name} encrypted and stored.`);
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to encrypt file');
    } finally {
      setLoading(false);
    }
  };

  // ── Add file handlers per tab ─────────────────────────────────
  const handleAdd = async () => {
    if (adding.current || loading || manifestState !== 'ok') return;
    adding.current = true;
    // The whole add (picker, encrypt, manifest save) is one bracket, so going
    // to the background mid-encrypt cannot lock the vault under it.
    try { await withSystemUi(pickAndAdd); } finally { adding.current = false; }
  };

  const pickAndAdd = async () => {
    if (activeTab === 'Photos') {
      const { status, canAskAgain } = await withSystemUi(() => ImagePicker.requestMediaLibraryPermissionsAsync());
      if (status !== 'granted') {
        permissionDenied('Photo access needed', 'Allow gallery access to move a photo into the vault.', canAskAgain);
        return;
      }
      const result = await withSystemUi(() => ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality:    0.85,
      }));
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const name  = asset.fileName || `photo_${Date.now()}.jpg`;
        await encryptAndSave(
          asset.uri, name, asset.fileSize || 0, 'image/jpeg', 'Photos'
        );
      }
    } else if (activeTab === 'Videos') {
      const { status , canAskAgain } = await withSystemUi(() => ImagePicker.requestMediaLibraryPermissionsAsync());
      if (status !== 'granted') {
        permissionDenied('Photo access needed', 'Allow gallery access to move a video into the vault.', canAskAgain);
        return;
      }
      const result = await withSystemUi(() => ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      }));
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const name  = asset.fileName || `video_${Date.now()}.mp4`;
        await encryptAndSave(
          asset.uri, name, asset.fileSize || 0, 'video/mp4', 'Videos'
        );
      }
    } else {
      // Documents and Voice — use document picker
      const result = await withSystemUi(() => DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
      }));
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
    setLoadingText('Decrypting…');
    setLoading(true);
    let tempPath: string | null = null;
    try {
      // 1. Read encrypted payload from disk
      const raw = await FileSystem.readAsStringAsync(file.encPath, {
        encoding: 'utf8',
      });
      const payload = JSON.parse(raw);

      // 2. Decrypt with the PIN-derived key
      const base64 = vaultFileDecrypt(vaultKeys, vaultPin, payload);

      // 3. Write decrypted file to temp location (deleted below)
      await FileSystem.makeDirectoryAsync(OPEN_DIR, { intermediates: true }).catch(() => {});
      tempPath = OPEN_DIR + safeName(file.name);
      await FileSystem.writeAsStringAsync(tempPath, base64, {
        encoding: 'base64',
      });

      // 4. Share/open with system viewer
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        const path = tempPath;
        await withSystemUi(() => Sharing.shareAsync(path, {
          mimeType: file.mimeType,
          dialogTitle: file.name,
        }));
      } else {
        Alert.alert('Cannot open', 'This device has no app to open the file with.');
      }
    } catch (e: any) {
      Alert.alert('Error', 'Failed to decrypt file: ' + e.message);
    } finally {
      // ponytail: deleted as soon as the share sheet returns. Android resolves
      // shareAsync once the chooser closes, which is after a viewer has read the
      // file in the cases checked; a target that reads lazily would lose it, and
      // then the copy must move to a longer-lived cleanup (mediaCacheGC).
      if (tempPath) await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
      setLoading(false);
      setLoadingText('Encrypting…');
    }
  };

  // ── Delete file ───────────────────────────────────────────────
  const handleDelete = (file: VaultFile) => {
    if (manifestState !== 'ok') return;
    Alert.alert(
      'Delete File',
      `Permanently delete "${file.name}" from Vault?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              // List first: if saving it fails, the file is still there and still
              // listed. The other order left an entry pointing at a deleted file.
              await saveManifest(filesRef.current.filter(f => f.id !== file.id));
              await FileSystem.deleteAsync(file.encPath, { idempotent: true }).catch(() => {});
            } catch (e: any) {
              Alert.alert('Not deleted', e?.message ?? 'The file could not be removed. Try again.');
            }
          },
        },
      ]
    );
  };

  // ── Export file list ──────────────────────────────────────────
  // The Vault is local-only: there is no server backup of these files and no
  // automatic one. This shares a LIST (name, type, size, date) through the
  // share sheet — not the files, not encrypted, and without on-device paths —
  // and the copy in the modal says exactly that.
  const handleBackup = async () => {
    setLoadingText('Preparing list…');
    setLoading(true);
    let exportPath: string | null = null;
    try {
      if (manifestState !== 'ok') return;   // never share an empty stand-in list
      setShowBackup(false);
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Cannot share', 'This device has no app to share the list with.');
        return;
      }
      const list = filesRef.current.map(f => ({ name: f.name, type: f.type, size: f.size, addedAt: new Date(f.addedAt).toISOString() }));
      const path = FileSystem.cacheDirectory + `vault_file_list_${Date.now()}.json`;
      exportPath = path;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(list, null, 2), { encoding: 'utf8' });
      await withSystemUi(() => Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: 'Vault file list' }));

      // Recorded only once the share sheet has returned.
      const now = new Date().toLocaleDateString();
      setLastBackup(now);
      await SecureStore.setItemAsync('vault_last_backup', now).catch(() => {});
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Try again.');
    } finally {
      if (exportPath) await FileSystem.deleteAsync(exportPath, { idempotent: true }).catch(() => {});
      setLoading(false);
      setLoadingText('Encrypting…');
    }
  };

  // ── Filtered files for active tab ─────────────────────────────
  const tabFiles = files.filter(f => f.type === activeTab);

  // ─────────────────────────────────────────────────────────────
  // Show PIN gate until unlocked
  // ─────────────────────────────────────────────────────────────
  if (!unlocked) {
    return <PinGate onUnlock={unlock} />;
  }

  // ─────────────────────────────────────────────────────────────
  // Main Vault UI
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <AuroraBackground />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={26} color={c.primary} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} accessibilityRole="header">Vault</Text>
          <Text style={styles.headerSub}>AES-256-GCM Encrypted</Text>
        </View>
        <TouchableOpacity hitSlop={4}
          style={[styles.backupBtn, manifestState !== 'ok' && { opacity: 0.4 }]}
          onPress={() => setShowBackup(true)}
          // Exporting before the list has loaded would share an empty list.
          disabled={manifestState !== 'ok'}
          accessibilityRole="button"
          accessibilityLabel="Export file list"
          accessibilityState={{ disabled: manifestState !== 'ok' }}
        >
          <Ionicons name="download-outline" size={20} color={c.primary} />
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
          <Text style={styles.statLabel}>Last export</Text>
        </View>
      </View>

      {!vaultKeys && (
        keyMiss === 'storage' ? (
          <View style={styles.keyNoticeRow}>
            <Text style={[styles.keyNotice, { flex: 1 }]} accessibilityLiveRegion="polite">
              This phone&apos;s secure storage could not be read, so the vault key did not load. Files may
              not open until it does.
            </Text>
            <TouchableOpacity style={styles.keyRetryBtn} onPress={retryKeys} accessibilityRole="button" accessibilityLabel="Try loading the vault key again">
              <Text style={styles.keyRetryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={styles.keyNotice} accessibilityLiveRegion="polite">
            {keyMiss === 'damaged'
              ? 'The saved vault key is damaged, so files added with it may not open. It has been left as it is. New files are still encrypted with your PIN.'
              : 'This PIN cannot open the vault key from before your PIN was reset, so files added under the old PIN may not open. New files are still encrypted with this PIN.'}
          </Text>
        )
      )}

      {/* Tabs */}
      <View style={styles.tabs}>
        {(Object.keys(TAB_CONFIG) as VaultTab[]).map(tab => {
          const count = files.filter(f => f.type === tab).length;
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
              accessibilityRole="tab"
              accessibilityLabel={`${tab}, ${count} file${count === 1 ? '' : 's'}`}
              accessibilityState={{ selected: activeTab === tab }}
            >
              <Ionicons name={TAB_CONFIG[tab].icon} size={20} color={activeTab === tab ? c.primary : c.textDim} />
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab}
              </Text>
              {count > 0 && (
                <View style={styles.tabCount}>
                  <Text style={styles.tabCountText}>{count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* File list */}
      {manifestState !== 'ok' && !loading ? (
        <View style={styles.loadingWrap}>
          {manifestState === 'loading' ? (
            <ActivityIndicator color={c.primary} size="large" accessibilityLabel="Loading vault files" />
          ) : (
            <>
              <Text style={styles.keyNotice} accessibilityRole="alert">
                The vault file list could not be read. Your files are untouched; adding and deleting
                are paused until it loads.
              </Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={loadManifest}
                accessibilityRole="button"
                accessibilityLabel="Retry loading vault files"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={styles.loadingText}>{loadingText}</Text>
        </View>
      ) : (
        <FlatList
          data={tabFiles}
          keyExtractor={f => f.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Ionicons name={TAB_CONFIG[activeTab].icon} size={52} color={c.textDim} importantForAccessibility="no" accessibilityElementsHidden />
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
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}, ${formatSize(item.size)}`}
              accessibilityActions={[{ name: 'delete', label: `Delete ${item.name}` }]}
              onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') handleDelete(item); }}
            >
              <View style={styles.fileIcon}>
                <Ionicons name={TAB_CONFIG[item.type].icon} size={22} color={c.primary} />
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
                <View style={styles.encBadge} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                  <Ionicons name="lock-closed" size={11} color={c.primary} />
                  <Text style={styles.encBadgeText}>ENC</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => handleDelete(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.name}`}
                >
                  <Ionicons name="trash-outline" size={20} color={c.danger} />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Add file FAB */}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Add to vault"
        accessibilityState={{ disabled: loading || manifestState !== 'ok' }}
        disabled={loading || manifestState !== 'ok'}
        style={[styles.fab, (loading || manifestState !== 'ok') && styles.fabDisabled]}
        onPress={handleAdd}
      >
        {/* bubbleOutText is the palette's white-on-accent ink. */}
        <Ionicons name="add" size={28} color={c.bubbleOutText} />
      </TouchableOpacity>

      {/* Backup modal */}
      <Modal
        visible={showBackup}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBackup(false)}
      >
        <View style={styles.modalOverlay}>
          {/* Backdrop as a sibling of the panel so the sheet's buttons stay reachable by screen readers. */}
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setShowBackup(false)}
            accessibilityRole="button" accessibilityLabel="Close" />
          <View style={styles.backupPanel}>
            <View style={styles.backupHandle} />
            <Text style={styles.backupTitle}>Export file list</Text>
            <Text style={styles.backupDesc}>
              Shares a list of your {files.length} vault file names, sizes and
              dates. The list is NOT encrypted and does not contain the files —
              they stay encrypted on this phone only.
            </Text>

            <View style={styles.backupBtnRow}>
              <TouchableOpacity
                style={styles.backupCancelBtn}
                onPress={() => setShowBackup(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.backupCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.backupConfirmBtn}
                onPress={handleBackup}
                disabled={loading || manifestState !== 'ok'}
                accessibilityRole="button"
                accessibilityLabel="Export file list"
                accessibilityState={{ disabled: loading || manifestState !== 'ok', busy: loading }}
              >
                {loading
                  ? <ActivityIndicator color={c.bubbleOutText} size="small" />
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
              Vault files are not backed up anywhere — not automatically, and not
              with chat backup. Deleting the app deletes them.
            </Text>
          </View>
        </View>
      </Modal>

      
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const makePinStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: c.glassSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  lockIcon:  { marginBottom: 12 },
  title:     { fontSize: 26, fontWeight: 'bold', color: c.text, marginBottom: 4 },
  sub:       { fontSize: 13, color: c.textDim, marginBottom: 24 },
  error:     { color: c.danger, fontSize: 13, marginTop: 12, textAlign: 'center', paddingHorizontal: 24 },
  note:      { marginTop: 28, color: c.textDim, fontSize: 11 },
  setBtn:    { marginTop: 8, minHeight: 48, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  setBtnText:{ color: c.bubbleOutText, fontWeight: 'bold', fontSize: 15 },
});

const makeStyles = (c: Palette) => StyleSheet.create({
  container:    { flex: 1, backgroundColor: c.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
    gap: 12,
  },
  backBtn:      { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: 'bold', color: c.text },
  headerSub:    { fontSize: 12, color: c.primary, marginTop: 1 },
  backupBtn: {
    width: 44, height: 44, backgroundColor: c.glassSoft,
    borderRadius: 9, borderWidth: 0.5, borderColor: c.glassStroke,
    justifyContent: 'center', alignItems: 'center',
  },

  // Stats
  statsBar: {
    flexDirection: 'row', backgroundColor: c.bg,
    paddingVertical: 12, paddingHorizontal: 20,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  statItem:    { flex: 1, alignItems: 'center' },
  statNum:     { fontSize: 15, fontWeight: 'bold', color: c.text },
  statLabel:   { fontSize: 12, color: c.textDim, marginTop: 2 },
  statDivider: { width: 0.5, backgroundColor: c.surfaceSolid, marginVertical: 4 },

  keyNotice: { color: c.danger, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 8 },
  keyNoticeRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 12 },
  keyRetryBtn: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, justifyContent: 'center' },
  keyRetryText: { color: c.primary, fontWeight: '700', fontSize: 13 },

  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  tab: {
    flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3,
  },
  tabActive: {
    borderBottomWidth: 2, borderBottomColor: c.primary,
  },
  tabText:       { fontSize: 12, color: c.textDim },
  tabTextActive: { color: c.primary, fontWeight: 'bold' },
  tabCount: {
    borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: c.glass,
  },
  tabCountText:  { fontSize: 12, fontWeight: 'bold', color: c.primary },

  // Loading
  loadingWrap: {
    flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12,
  },
  loadingText: { fontSize: 13, color: c.textDim },

  // List
  listContent: { padding: 14, paddingBottom: 100, flexGrow: 1 },

  // Empty
  emptyWrap: {
    flex: 1, alignItems: 'center', paddingTop: 64, gap: 10,
  },
  emptyTitle: { fontSize: 16, fontWeight: 'bold', color: c.textDim },
  emptyHint:  { fontSize: 12, color: c.textDim, textAlign: 'center' },

  // File row
  fileRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 0.5, borderColor: c.glassStroke,
  },
  fileIcon: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: c.glassSoft,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  fileInfo:      { flex: 1 },
  fileName:      { fontSize: 14, fontWeight: 'bold', color: c.text, marginBottom: 3 },
  fileMeta:      { fontSize: 12, color: c.textDim },
  fileActions:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: c.glassSoft, borderRadius: 6,
    borderWidth: 0.5, borderColor: c.primary,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  encBadgeText:  { fontSize: 12, color: c.primary, fontWeight: 'bold' },
  deleteBtn:     { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  // FAB
  fab: {
    position: 'absolute', right: 18, bottom: 74,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: c.primary,
    justifyContent: 'center', alignItems: 'center',
    elevation: 6,
  },
  fabDisabled: { opacity: 0.4 },
  retryBtn: { minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  retryText: { color: c.bubbleOutText, fontWeight: 'bold', fontSize: 15 },

  // Backup modal
  // Modal scrim: a translucent black dims whatever is behind in either theme.
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.53)', justifyContent: 'flex-end',
  },
  backupPanel: {
    backgroundColor: c.bg,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  backupHandle: {
    width: 40, height: 4, backgroundColor: c.surfaceSolid,
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  backupTitle: {
    fontSize: 17, fontWeight: 'bold', color: c.text,
    textAlign: 'center', marginBottom: 8,
  },
  backupDesc: {
    fontSize: 13, color: c.textDim, lineHeight: 20,
    textAlign: 'center', marginBottom: 20,
  },
  backupBtnRow:  { flexDirection: 'row', gap: 10, marginBottom: 12 },
  backupCancelBtn: {
    flex: 1, backgroundColor: c.surfaceSolid,
    borderRadius: 10, borderWidth: 0.5, borderColor: c.glassStroke,
    paddingVertical: 13, alignItems: 'center',
  },
  backupCancelText:  { color: c.textDim, fontWeight: 'bold' },
  backupConfirmBtn: {
    flex: 1, backgroundColor: c.primary,
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  backupConfirmText: { color: c.bubbleOutText, fontWeight: 'bold', fontSize: 15 },
  backupLastText:    { fontSize: 12, color: c.textDim, textAlign: 'center' },
  backupNote:        { fontSize: 12, color: c.text, textAlign: 'center', marginTop: 6 },
});
