// components/notes/NotesBackupModal.tsx — Backup & restore for app/encrypted-notes.tsx
// (moved out of the screen in the round-4 split; behaviour unchanged).

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, TextInput, Alert, Modal, ScrollView } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { useTheme } from '../../lib/theme';
import {
  buildBundle, checkPassphrase, hasPassphrase, restoreBundle, restoreKeyFromWrap, setPassphrase,
} from '../../lib/notesVault';
import { useNotesStyles } from './notesStyles';

// The notes vault throws user copy (lib/notesVault); anything else gets the generic line.
const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Try again');

export function NotesBackupModal({ visible, onClose, loadFailed, withSystemUi, onKeyRestored }: {
  visible: boolean;
  onClose: () => void;
  /** The stored notes could not be opened: the key here may be a stand-in. */
  loadFailed: boolean;
  /** Brackets a system sheet so the screen's background re-lock ignores it. */
  withSystemUi: <T>(fn: () => Promise<T>) => Promise<T>;
  /** A key or bundle was restored: drop the cached key and re-read the notes. */
  onKeyRestored: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();

  // Backup / restore (lib/notesVault) — passphrase-wrapped, ciphertext only.
  const [bkPass, setBkPass] = useState('');
  const [bkPass2, setBkPass2] = useState('');
  const [bkBusy, setBkBusy] = useState(false);
  const [bkHasPass, setBkHasPass] = useState(false);
  useEffect(() => { hasPassphrase().then(setBkHasPass).catch(() => {}); }, [visible]);

  // ── Backup / restore (lib/notesVault) ─────────────────────────────────────
  // The vault's DEK lives only in SecureStore, which nothing backs up — while
  // the sealed notes blob IS swept into every cloud backup as a plain
  // AsyncStorage key. A restore therefore produced ciphertext with no key: the
  // backup looked fine and guaranteed total loss. A passphrase-wrapped copy of
  // the DEK travels with it now, so only the passphrase — never stored, never
  // sent — can open the vault, including from the server's side of a backup.

  const savePassphrase = async () => {
    // With the notes unreadable, the key on this device may be a stand-in;
    // wrapping it would replace the backup copy of the real one.
    if (loadFailed) { Alert.alert('Recover first', 'Your notes could not be opened. Recover the key with your existing passphrase before setting a new one.'); return; }
    if (bkPass !== bkPass2) { Alert.alert('Passphrases differ', 'The two entries must match.'); return; }
    setBkBusy(true);
    try {
      await setPassphrase(bkPass);
      setBkPass(''); setBkPass2(''); setBkHasPass(true);
      Alert.alert(
        'Backup passphrase set',
        'Your notes key is now included in backups, sealed with this passphrase.\n\nWrite it down. It is never stored and never sent — if you forget it, nobody can recover these notes, including us.',
      );
    } catch (e: unknown) {
      Alert.alert('Could not set passphrase', errMsg(e));
    } finally { setBkBusy(false); }
  };

  // Write a self-contained encrypted file and hand it to the share sheet.
  const exportBundle = async () => {
    if (loadFailed) { Alert.alert('Nothing to export', 'Your notes could not be opened on this device, so there is nothing safe to export.'); return; }
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter the passphrase to seal this export.'); return; }
    setBkBusy(true);
    try {
      if (bkHasPass && !(await checkPassphrase(bkPass))) {
        Alert.alert('Wrong passphrase', 'That is not your backup passphrase.');
        return;
      }
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Export unavailable', 'Sharing is not available on this device, so the export has nowhere to go.');
        return;
      }
      const bundle = await buildBundle(bkPass);
      const path = `${FileSystem.cacheDirectory}vaultchat-notes-${new Date().toISOString().slice(0, 10)}.vcnotes`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(bundle), { encoding: FileSystem.EncodingType.UTF8 });
      try {
        await withSystemUi(() => Sharing.shareAsync(path, { mimeType: 'application/json', dialogTitle: 'Encrypted notes backup' }));
      } finally {
        // The share target has its copy; ours must not linger in the cache.
        await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      }
      setBkPass(''); setBkPass2('');
    } catch (e: unknown) {
      Alert.alert('Export failed', errMsg(e));
    } finally { setBkBusy(false); }
  };

  const importBundleFile = async () => {
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter the passphrase this backup was sealed with.'); return; }
    const res = await withSystemUi(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
    if (res.canceled || !res.assets?.[0]) return;
    setBkBusy(true);
    try {
      const raw = await FileSystem.readAsStringAsync(res.assets[0].uri, { encoding: FileSystem.EncodingType.UTF8 });
      const r = await restoreBundle(bkPass, JSON.parse(raw));
      if (r.status === 'invalid') { Alert.alert('Not a notes backup', 'That file is not a crazzychat notes export.'); return; }
      if (r.status === 'wrong') { Alert.alert('Wrong passphrase', 'That passphrase does not open this backup.'); return; }
      if (r.status === 'occupied') {
        // Never silently swap the key: whatever this device already holds would
        // become permanently unreadable.
        Alert.alert(
          'This device already has notes',
          'Restoring replaces this device’s notes key. Any notes here that came from a different key will become unreadable. Continue?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: async () => {
              try {
                const f = await restoreBundle(bkPass, JSON.parse(raw), true);
                if (f.status === 'ok') { await onKeyRestored(); onClose(); Alert.alert('Restored', `Notes and ${f.attachments} attachment(s) restored.`); }
              } catch (e: unknown) { Alert.alert('Restore failed', errMsg(e)); }
            }},
          ],
        );
        return;
      }
      await onKeyRestored();
      onClose(); setBkPass('');
      Alert.alert('Restored', `Notes and ${r.attachments} attachment(s) restored.`);
    } catch (e: unknown) {
      Alert.alert('Restore failed', errMsg(e));
    } finally { setBkBusy(false); }
  };

  // After a device restore the notes blob and the wrap both came back through
  // the normal cloud/Drive backup — only the key is missing. This recovers it
  // in place, with no file to pick.
  const recoverKey = async () => {
    if (!bkPass) { Alert.alert('Passphrase needed', 'Enter your backup passphrase.'); return; }
    setBkBusy(true);
    try {
      const r = await restoreKeyFromWrap(bkPass);
      if (r === 'none') { Alert.alert('Nothing to recover', 'No wrapped key travelled with this install.'); return; }
      if (r === 'wrong') { Alert.alert('Wrong passphrase', 'That passphrase does not open the stored key.'); return; }
      if (r === 'occupied') {
        Alert.alert(
          'This device already has a different key',
          'Replacing it will make any notes written with the current key unreadable. Continue?',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: async () => {
              try {
                await restoreKeyFromWrap(bkPass, true);
                await onKeyRestored(); onClose();
                Alert.alert('Key recovered', 'Your notes should be readable again.');
              } catch (e: unknown) { Alert.alert('Could not recover', errMsg(e)); }
            }},
          ],
        );
        return;
      }
      await onKeyRestored();
      onClose(); setBkPass('');
      Alert.alert('Key recovered', 'Your notes should be readable again.');
    } catch (e: unknown) {
      Alert.alert('Could not recover', errMsg(e));
    } finally { setBkBusy(false); }
  };

  // Changing the passphrase needs the current one: anyone holding the unlocked
  // phone could otherwise re-seal the backup key under a passphrase of theirs.
  const startChangePassphrase = async () => {
    if (!bkPass) { Alert.alert('Current passphrase needed', 'Enter your current backup passphrase above, then tap Change passphrase.'); return; }
    setBkBusy(true);
    try {
      if (!(await checkPassphrase(bkPass))) { Alert.alert('Wrong passphrase', 'That is not your current backup passphrase.'); return; }
      setBkHasPass(false); setBkPass(''); setBkPass2('');
    } catch (e: unknown) {
      Alert.alert('Could not check passphrase', errMsg(e));
    } finally { setBkBusy(false); }
  };

  // Backup & restore — passphrase-wrapped key, ciphertext everywhere.
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardSafe keyboardOnly>
      <View style={s.editorScreen}>
        <View style={s.editorHeader}>
          <TouchableOpacity onPress={onClose} style={[s.textBtn, { flexDirection: 'row', alignItems: 'center', gap: 4 }]} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={16} color={colors.textDim} />
            <Text style={s.editorCancel}>Back</Text>
          </TouchableOpacity>
          <Text style={s.editorTitle} accessibilityRole="header">Backup</Text>
          <View style={{ width: 50 }} />
        </View>

        <ScrollView style={s.editorBody} contentContainerStyle={{ paddingBottom: 40 }}>
          <Text style={s.bkBody}>
            Your notes are sealed with a key that lives only in this phone’s keystore. Nothing
            copies it — so without a backup passphrase, losing this phone loses every note here
            permanently.
          </Text>
          <Text style={s.bkBody}>
            A passphrase seals a copy of that key so it can travel inside your normal backup.
            The passphrase is never stored and never sent: not to us, not to the server, not
            inside the backup. Only you can open it, and if you forget it nobody can help.
          </Text>

          <View style={s.edSection}>
            <Text style={s.edLabel}>{bkHasPass ? 'Backup passphrase (set)' : 'Set a backup passphrase'}</Text>
            <TextInput
              style={s.tagInput} placeholder={bkHasPass ? 'Current passphrase' : 'New passphrase (8+ characters)'} placeholderTextColor={colors.textFaint}
              value={bkPass} onChangeText={setBkPass} secureTextEntry autoCapitalize="none"
              accessibilityLabel={bkHasPass ? 'Current backup passphrase' : 'New backup passphrase'}
            />
            {!bkHasPass && (
              <TextInput
                style={s.tagInput} placeholder="Repeat passphrase" placeholderTextColor={colors.textFaint}
                value={bkPass2} onChangeText={setBkPass2} secureTextEntry autoCapitalize="none"
                accessibilityLabel="Repeat new backup passphrase"
              />
            )}
            {!bkHasPass && (
              <TouchableOpacity style={s.bkBtn} onPress={savePassphrase} disabled={bkBusy || bkPass.length < 8}
                accessibilityRole="button" accessibilityLabel="Set passphrase" accessibilityState={{ disabled: bkBusy || bkPass.length < 8, busy: bkBusy }}>
                <Text style={s.bkBtnTxt}>{bkBusy ? 'Working…' : 'Set passphrase'}</Text>
              </TouchableOpacity>
            )}
            {bkHasPass && (
              <TouchableOpacity style={[s.bkBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke }]}
                onPress={startChangePassphrase} disabled={bkBusy}
                accessibilityRole="button" accessibilityLabel="Change passphrase. Enter the current one first" accessibilityState={{ disabled: bkBusy, busy: bkBusy }}>
                <Text style={[s.bkBtnTxt, { color: colors.textDim }]}>Change passphrase</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={s.edSection}>
            <Text style={s.edLabel}>Export</Text>
            <Text style={s.attachHint}>
              One encrypted file holding your notes and every attachment, exactly as they are
              sealed on disk. Nothing inside it is readable without the passphrase.
            </Text>
            <TouchableOpacity style={s.bkBtn} onPress={exportBundle} disabled={bkBusy} accessibilityRole="button" accessibilityLabel="Export encrypted file" accessibilityState={{ disabled: bkBusy, busy: bkBusy }}>
              <Text style={s.bkBtnTxt}>{bkBusy ? 'Working…' : 'Export encrypted file'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.edSection}>
            <Text style={s.edLabel}>Restore</Text>
            <Text style={s.attachHint}>
              From an exported file, or — if your notes came back from a cloud backup unreadable —
              recover just the key that was left behind.
            </Text>
            <TouchableOpacity style={s.bkBtn} onPress={importBundleFile} disabled={bkBusy} accessibilityRole="button" accessibilityLabel="Restore from file" accessibilityState={{ disabled: bkBusy, busy: bkBusy }}>
              <Text style={s.bkBtnTxt}>Restore from file</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.bkBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassStroke }]}
              onPress={recoverKey} disabled={bkBusy} accessibilityRole="button" accessibilityLabel="Recover key from backup" accessibilityState={{ disabled: bkBusy, busy: bkBusy }}>
              <Text style={[s.bkBtnTxt, { color: colors.textDim }]}>Recover key from backup</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
      </KeyboardSafe>
    </Modal>
  );
}
