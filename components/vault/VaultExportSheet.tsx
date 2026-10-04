// components/vault/VaultExportSheet.tsx — app/vault.tsx's "Export file list"
// sheet (moved out of the screen unchanged). It shares names, sizes and dates
// only — not the files, and not encrypted — and says so.

import React, { useMemo } from 'react';
import { ActivityIndicator, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { useColors } from '../../lib/theme';
import { makeStyles } from './vaultStyles';

interface Props {
  visible: boolean;
  onClose: () => void;
  count: number;
  busy: boolean;
  disabled: boolean;
  lastExport: string | null;
  /** The vault folder is known to be outside the phone's own backups (always
   *  on Android, where app backup is off; on iOS once the folder is marked). */
  backupExcluded: boolean;
  onExport: () => void;
}

export function VaultExportSheet({ visible, onClose, count, busy, disabled, lastExport, backupExcluded, onExport }: Props) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        {/* Backdrop as a sibling of the panel so the sheet's buttons stay reachable by screen readers. */}
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose}
          accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.backupPanel}>
          <View style={styles.backupHandle} />
          <Text style={styles.backupTitle} accessibilityRole="header">Export file list</Text>
          <Text style={styles.backupDesc}>
            Shares a list of your {count} vault file names, sizes and
            dates. The list is NOT encrypted and does not contain the files —
            they stay encrypted on this phone only.
          </Text>

          <View style={styles.backupBtnRow}>
            <TouchableOpacity style={styles.backupCancelBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={styles.backupCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.backupConfirmBtn}
              onPress={onExport}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Export file list"
              accessibilityState={{ disabled, busy }}
            >
              {busy
                ? <ActivityIndicator color={c.onPrimary} size="small" />
                : <Text style={styles.backupConfirmText}>Export</Text>}
            </TouchableOpacity>
          </View>

          {lastExport ? <Text style={styles.backupLastText}>Last export: {lastExport}</Text> : null}

          <Text style={styles.backupNote}>
            {backupExcluded
              ? 'Vault files are not backed up anywhere — not automatically, and not with chat backup. Deleting the app deletes them.'
              : 'Vault files are not in chat backup, but this phone\'s own backup (iCloud or a computer) may include them, still encrypted. Deleting the app deletes them from this phone.'}
          </Text>
        </View>
      </View>
    </Modal>
  );
}
