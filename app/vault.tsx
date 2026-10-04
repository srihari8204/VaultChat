// app/vault.tsx
// Device-PIN gated local file vault (the PIN set in Settings → Device PIN,
// 4–8 digits — services/security/pinFormat).
// Files are AES-256-GCM encrypted on this phone (lib/vaultCrypto: a random
// file key wrapped under the PIN, so changing the PIN does not orphan files).
// New files are v4, streamed in chunks from disk to disk and bound to their
// file id (components/vault/vaultFileIO); older v1/v2/v3 files still open.
// The key's data-loss rules (lost key, New key, Try an old PIN) are in
// lib/vaultKeyStore; the notice and old-PIN sheet in components/vault/VaultKeyPanel.
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
  View, TouchableOpacity,
  FlatList, Alert, Vibration, ActivityIndicator,
  AppState,
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
import { clearVaultKeyCache, VaultCancelledError, type VaultKeys } from '../lib/vaultCrypto';
import { replaceVaultKeys, tryOldVaultPin, unlockVaultKeys, type VaultKeyMiss, type VaultUnlock } from '../lib/vaultKeyStore';
import { holdAppSwitcherBlur } from '../lib/screenGuard';
import { openVaultFileTo, scanVaultDir, sealFileToVault, sweepPartialSeals, type VaultDirScan } from '../components/vault/vaultFileIO';
import { VaultKeyPanel } from '../components/vault/VaultKeyPanel';
import { VaultExportSheet } from '../components/vault/VaultExportSheet';
import { makePinStyles, makeStyles } from '../components/vault/vaultStyles';
import { File as FsFile } from 'expo-file-system';
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
// The .enc file of an entry. Resolved against TODAY's vault folder by file
// name: iOS can move the app's container on an update, so an absolute path
// saved in the manifest may point at a folder that no longer exists.
const encUriOf = (f: VaultFile) => VAULT_DIR + (f.encPath.split('/').pop() || `${f.id}.enc`);

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
          onPress={() => router.push('/backup-pin?from=settings')}
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
  // The file key. null when this PIN cannot open the key record (the PIN was
  // reset somewhere that could not re-wrap it), the record is damaged or lost,
  // or storage failed: v1 files still open via the PIN, and ADDING is off until
  // the key is back — there is no weaker fallback format (lib/vaultCrypto).
  const [vaultKeys,   setVaultKeys]   = useState<VaultKeys | null>(null);
  const [keyMiss,     setKeyMiss]     = useState<VaultKeyMiss | undefined>(undefined);
  // Archived keys this PIN opens (read-only), and how many it does not.
  const [olderKeys,   setOlderKeys]   = useState<VaultKeys[]>([]);
  const [lockedArchives, setLockedArchives] = useState(0);
  // What is on disk at unlock: unlisted files can be listed again, and the
  // key-dependent count is what the "lost key" notice reports.
  const [diskScan,    setDiskScan]    = useState<VaultDirScan | null>(null);
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
  // Chunk progress (0–1) of the running seal or open, and its cancel flag. A
  // re-lock or leaving the screen cancels it: an open stops writing plaintext,
  // a seal deletes its partial file and never reaches the manifest.
  const [progress,    setProgress]    = useState<number | null>(null);
  const op = useRef<{ cancelled: boolean } | null>(null);
  const beginOp = () => {
    const o = { cancelled: false };
    op.current = o;
    setProgress(0);
    return {
      cancelled: () => o.cancelled,
      onProgress: (d: number, t: number) => { if (!o.cancelled) setProgress(d / t); },
      o,
    };
  };
  const cancelOp = () => { if (op.current) op.current.cancelled = true; };
  const [showBackup,  setShowBackup]  = useState(false);
  const [lastBackup,  setLastBackup]  = useState<string | null>(null);

  // Nothing decrypted outlives the screen, and the derived keys go with it.
  useEffect(() => {
    wipeOpenDir();
    return () => { cancelOp(); wipeOpenDir(); clearVaultKeyCache(); };
  }, []);

  const unlock = async (pin: string) => {
    // A seal the OS killed left a .part file: nothing lists it, so delete it.
    try { sweepPartialSeals(VAULT_DIR); } catch { /* next unlock tries again */ }
    let scan: VaultDirScan | null = null;
    try { scan = scanVaultDir(VAULT_DIR); } catch { /* unknown: never treated as empty */ }
    let res: VaultUnlock;
    try {
      res = await unlockVaultKeys(pin, async () => {
        if (!scan) throw new Error('The vault folder could not be read.');
        return scan.keyed > 0;
      });
    } catch { res = { keys: null, miss: 'storage', older: [], lockedArchives: 0 }; }
    setDiskScan(scan);
    setVaultKeys(res.keys);
    setKeyMiss(res.keys ? undefined : res.miss);
    setOlderKeys(res.older);
    setLockedArchives(res.lockedArchives);
    setVaultPin(pin);
    setUnlocked(true);
  };

  // iOS: blur the app-switcher snapshot and the screen while the app is
  // inactive (Control Center), which the background re-lock below does not
  // cover. Android's FLAG_SECURE already blanks the recents thumbnail.
  useEffect(() => (unlocked ? holdAppSwitcherBlur() : undefined), [unlocked]);

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
      cancelOp();
      clearVaultKeyCache();
      wipeOpenDir();
      setVaultPin('');
      setVaultKeys(null);
      setKeyMiss(undefined);
      setOlderKeys([]);
      setLockedArchives(0);
      setDiskScan(null);
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

  const [keyBusy, setKeyBusy] = useState(false);
  const retryKeys = async () => {
    if (!vaultPin || keyBusy) return;
    setKeyBusy(true);
    try { await unlock(vaultPin); } finally { setKeyBusy(false); }
  };

  // The way out when the key record cannot be opened with this PIN (or is
  // damaged, or lost): a fresh key, after the old record is archived (never
  // deleted, and listed so "Try an old PIN" can still open it).
  const startNewKey = () => {
    if (!vaultPin || keyBusy) return;
    Alert.alert(
      'Start a new vault key?',
      keyMiss === 'lost'
        ? 'The old key is gone from this phone\'s secure storage, so the files that need it cannot be opened again. They stay in the vault folder. New files will use the new key.'
        : keyMiss === 'damaged'
          ? 'The damaged key is kept on this phone as it is, but it cannot open anything, so files added with it stay unopenable. New files will use the new key.'
          : 'Files added with the current key stay unopenable with this PIN. The key is kept on this phone: if you later remember the PIN you used before, Try an old PIN opens those files again. New files will use the new key.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new key', style: 'destructive', onPress: async () => {
          setKeyBusy(true);
          try {
            await replaceVaultKeys(vaultPin);
            await unlock(vaultPin);   // picks up the new key and the archive count
          } catch (e: any) {
            Alert.alert('No new key', `Nothing was changed. ${e?.message ?? 'Try again.'}`);
          } finally { setKeyBusy(false); }
        } },
      ],
    );
  };

  // "Try an old PIN": re-wraps every key the old PIN opens under this one,
  // then unlocks again so their files open. Returns how many it opened.
  const recoverWithOldPin = async (oldPin: string): Promise<number> => {
    if (!vaultPin) return 0;
    const n = await tryOldVaultPin(oldPin, vaultPin);
    if (n > 0) {
      await unlock(vaultPin);
      Alert.alert('Old key opened', `${n === 1 ? 'An old vault key' : `${n} old vault keys`} now ${n === 1 ? 'opens' : 'open'} with your current PIN, so ${n === 1 ? 'its' : 'their'} files open again.`);
    }
    return n;
  };

  // .enc files in the folder that the list does not name: the list was lost
  // with the key (both live in SecureStore), or the app stopped between
  // sealing a file and listing it. They are offered back, never deleted.
  const unlisted = useMemo(() => {
    if (!diskScan || manifestState !== 'ok') return [];
    const listed = new Set(files.map(f => encUriOf(f).split('/').pop()!.replace(/\.enc$/, '')));
    return diskScan.ids.filter(id => !listed.has(id));
  }, [diskScan, files, manifestState]);

  const relistUnlisted = async () => {
    const now = Date.now();
    const entries: VaultFile[] = unlisted.map((id, i) => {
      const f = new FsFile(VAULT_DIR + id + '.enc');
      return {
        // The size shown is the encrypted file's, a close stand-in for the original.
        id, name: `Recovered file ${i + 1}`, size: f.size, type: 'Documents', encPath: VAULT_DIR + id + '.enc',
        addedAt: f.modificationTime ?? now, mimeType: 'application/octet-stream',
      };
    });
    try {
      await saveManifest([...filesRef.current, ...entries]);
      setActiveTab('Documents');
    } catch (e) {
      Alert.alert('Not listed', (e as Error)?.message ?? 'Try again.');
    }
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
    const run = beginOp();
    try {
      // 1–3. Seal it chunk by chunk under the vault key straight to disk
      // (v4, bound to fileId): the file is never held whole in memory, and
      // without the key nothing is written (no weaker fallback).
      const fileId  = `vault_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const encPath = VAULT_DIR + fileId + '.enc';
      const sealedBytes = await sealFileToVault(vaultKeys, uri, encPath, size, run);
      if (run.o.cancelled) {
        await FileSystem.deleteAsync(encPath, { idempotent: true }).catch(() => {});
        return;
      }

      // 4. Add to manifest
      const newFile: VaultFile = {
        id: fileId, name, size: sealedBytes, type,
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
      if (e instanceof VaultCancelledError || run.o.cancelled) return;   // nothing was kept
      Alert.alert('Not added', e?.message || 'The file could not be encrypted. Try again.');
    } finally {
      if (op.current === run.o) op.current = null;
      setProgress(null);
      setLoading(false);
    }
  };

  // ── Add file handlers per tab ─────────────────────────────────
  const handleAdd = async () => {
    if (adding.current || loading || manifestState !== 'ok' || !vaultKeys) return;
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
          asset.uri, name, asset.fileSize || 0, asset.mimeType || 'image/jpeg', 'Photos'
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
          asset.uri, name, asset.fileSize || 0, asset.mimeType || 'video/mp4', 'Videos'
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
    const run = beginOp();
    let tempPath: string | null = null;
    try {
      // 1–3. Decrypt to a temp copy (deleted below): v3/v4 stream chunk by
      // chunk, older v1/v2 files take the whole-file path. Archived keys an
      // old PIN recovered are tried after the current one.
      await FileSystem.makeDirectoryAsync(OPEN_DIR, { intermediates: true }).catch(() => {});
      tempPath = OPEN_DIR + safeName(file.name);
      await openVaultFileTo(vaultKeys, olderKeys, vaultPin, encUriOf(file), tempPath, run);
      // Re-locked (or left) while decrypting: never hand the copy to a share sheet.
      if (run.o.cancelled) return;

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
      if (!(e instanceof VaultCancelledError) && !run.o.cancelled) {
        Alert.alert('Could not open', e?.message || 'The file could not be decrypted.');
      }
    } finally {
      // ponytail: deleted as soon as the share sheet returns. Android resolves
      // shareAsync once the chooser closes, which is after a viewer has read the
      // file in the cases checked; a target that reads lazily would lose it, and
      // then the copy must move to a longer-lived cleanup (mediaCacheGC).
      if (tempPath) await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
      if (op.current === run.o) op.current = null;
      setProgress(null);
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
              await FileSystem.deleteAsync(encUriOf(file), { idempotent: true }).catch(() => {});
              const gone = encUriOf(file).split('/').pop()!.replace(/\.enc$/, '');
              setDiskScan(d => d && { ...d, ids: d.ids.filter(id => id !== gone) });
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

      <VaultKeyPanel
        hasKeys={!!vaultKeys}
        miss={keyMiss}
        lockedArchives={lockedArchives}
        keyedOnDisk={diskScan?.keyed ?? 0}
        busy={keyBusy}
        onRetry={retryKeys}
        onNewKey={startNewKey}
        onTryOldPin={recoverWithOldPin}
      />

      {unlisted.length > 0 && !loading ? (
        <View style={styles.unlistedRow}>
          <Text style={[styles.unlistedText, { flex: 1 }]}>
            {unlisted.length === 1 ? '1 encrypted file' : `${unlisted.length} encrypted files`} in the vault folder
            {unlisted.length === 1 ? ' is' : ' are'} not in the list (the list may have been lost). Names and types were
            in the list, so {unlisted.length === 1 ? 'it comes' : 'they come'} back as “Recovered file” under Documents.
          </Text>
          <TouchableOpacity style={styles.unlistedBtn} onPress={relistUnlisted} accessibilityRole="button"
            accessibilityLabel={`List ${unlisted.length} recovered file${unlisted.length === 1 ? '' : 's'} again`}>
            <Text style={styles.unlistedBtnText}>List again</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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
          <Text style={styles.loadingText} accessibilityLiveRegion="polite">
            {progress !== null && progress > 0 ? `${loadingText} ${Math.round(progress * 100)}%` : loadingText}
          </Text>
          {progress !== null ? (
            <TouchableOpacity style={styles.cancelOpBtn} onPress={cancelOp} accessibilityRole="button"
              accessibilityLabel={loadingText.startsWith('Decrypt') ? 'Cancel opening' : 'Cancel adding'}>
              <Text style={styles.cancelOpText}>Cancel</Text>
            </TouchableOpacity>
          ) : null}
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
        accessibilityState={{ disabled: loading || manifestState !== 'ok' || !vaultKeys }}
        disabled={loading || manifestState !== 'ok' || !vaultKeys}
        style={[styles.fab, (loading || manifestState !== 'ok' || !vaultKeys) && styles.fabDisabled]}
        onPress={handleAdd}
      >
        <Ionicons name="add" size={28} color={c.onPrimary} />
      </TouchableOpacity>

      <VaultExportSheet
        visible={showBackup}
        onClose={() => setShowBackup(false)}
        count={files.length}
        busy={loading}
        disabled={loading || manifestState !== 'ok'}
        lastExport={lastBackup}
        onExport={handleBackup}
      />
    </View>
  );
}
