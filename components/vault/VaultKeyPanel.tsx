// components/vault/VaultKeyPanel.tsx — app/vault.tsx's vault-key notice and the
// "Try an old PIN" sheet (lib/vaultKeyStore.tryOldVaultPin).
//
// Shown when the key new files are sealed with is not open (and why), when
// archived keys from before a reset are still closed, or when the list of
// archived keys was found damaged. Every message says what is kept and what
// the user can do; nothing here deletes a key or a file. The wrong-old-PIN
// limit is kept by lib/vaultKeyStore in storage, so re-locking does not reset it.

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { PinPad } from '../PinPad';
import { PIN_MAX, PIN_MIN, isPinFormat } from '../../services/security/pinFormat';
import { OldPinLimitError, oldVaultPinTries, type VaultKeyMiss } from '../../lib/vaultKeyStore';
import { useColors } from '../../lib/theme';
import { makeKeyPanelStyles } from './vaultStyles';

export function vaultKeyMessage(miss: VaultKeyMiss | undefined, keyedOnDisk: number): string {
  const files = keyedOnDisk === 1 ? '1 file needs' : `${keyedOnDisk} files need`;
  switch (miss) {
    case 'storage':
      return 'This phone\'s secure storage could not be read, so the vault key did not load. Files may not open, and adding files is paused, until it does.';
    case 'damaged':
      return 'The saved vault key is damaged, so files added with it cannot open. It is kept as it is. Adding files is paused until you start a new key.';
    case 'lost':
      return `This phone's secure storage no longer has the vault key. That can happen after some security changes, such as removing the screen lock, or when the app is restored or moved to another phone without its secure storage. ${files} that key and cannot be opened; they are kept, not deleted. Adding files is paused until you start a new key.`;
    default:
      return 'This PIN cannot open the vault key: it was made under the PIN you had before a reset. If you remember that PIN, tap Try an old PIN to open your files again. Otherwise adding files is paused until you start a new key.';
  }
}

interface Props {
  hasKeys: boolean;
  miss: VaultKeyMiss | undefined;
  /** Archived keys this PIN could not open. */
  lockedArchives: number;
  /** The list of archived keys was damaged (the names still readable in it are used). */
  indexDamaged?: boolean;
  keyedOnDisk: number;
  busy: boolean;
  onRetry: () => void;
  onNewKey: () => void;
  /** Resolves to how many keys the old PIN opened. */
  onTryOldPin: (oldPin: string) => Promise<number>;
}

export function VaultKeyPanel({ hasKeys, miss, lockedArchives, indexDamaged, keyedOnDisk, busy, onRetry, onNewKey, onTryOldPin }: Props) {
  const c = useColors();
  const s = useMemo(() => makeKeyPanelStyles(c), [c]);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [trying, setTrying] = useState(false);

  // An old PIN can open the current record (PIN reset) or an archived one.
  const canTryOld = (!hasKeys && miss === 'pin') || lockedArchives > 0;
  if (hasKeys && lockedArchives === 0 && !indexDamaged) return null;

  const submit = async (v: string) => {
    if (trying) return;
    if (!isPinFormat(v)) { setError(`Enter the ${PIN_MIN}–${PIN_MAX} digit PIN you used before.`); return; }
    setTrying(true);
    try {
      const n = await onTryOldPin(v);
      if (n > 0) { setOpen(false); setPin(''); setError(''); return; }
      const tries = await oldVaultPinTries().catch(() => null);
      const mins = tries ? Math.max(1, Math.ceil(tries.waitMs / 60_000)) : 0;
      setError(!tries
        ? 'That PIN opens none of the old vault keys.'
        : tries.left > 0
          ? `That PIN opens none of the old vault keys. ${tries.left} ${tries.left === 1 ? 'try' : 'tries'} left.`
          : `That PIN opens none of the old vault keys. You can try again in ${mins} min.`);
      setPin('');
    } catch (e) {
      // Fixed text: a storage error's own message is not for people.
      setError(e instanceof OldPinLimitError ? e.message : 'Could not check that PIN. Try again.');
      setPin('');
    } finally { setTrying(false); }
  };

  const damagedNote = indexDamaged
    ? 'The list of old vault keys on this phone was damaged. The keys still named in it are used, and a copy of the damaged list is kept; nothing was deleted.'
    : null;
  const message = hasKeys && lockedArchives === 0
    ? damagedNote
    : hasKeys
    ? `${lockedArchives === 1 ? 'An older vault key' : `${lockedArchives} older vault keys`} from before a reset ${lockedArchives === 1 ? 'is' : 'are'} kept on this phone but ${lockedArchives === 1 ? 'does' : 'do'} not open with this PIN, so files sealed with ${lockedArchives === 1 ? 'it' : 'them'} stay closed. If you remember the PIN you used then, try it.`
    : vaultKeyMessage(miss, keyedOnDisk);

  return (
    <View style={s.row}>
      <Text style={[s.notice, hasKeys && { color: c.textDim }]} accessibilityLiveRegion="polite">{message}</Text>
      {damagedNote && message !== damagedNote ? <Text style={[s.notice, { color: c.textDim }]}>{damagedNote}</Text> : null}
      <View style={s.actions}>
        {canTryOld ? (
          <TouchableOpacity style={s.btn} onPress={() => { setError(''); setPin(''); setOpen(true); }} disabled={busy}
            accessibilityRole="button" accessibilityLabel="Try an old PIN" accessibilityState={{ disabled: busy }}>
            <Text style={s.btnText}>Try an old PIN</Text>
          </TouchableOpacity>
        ) : null}
        {!hasKeys ? (
          <TouchableOpacity style={s.btn} onPress={miss === 'storage' ? onRetry : onNewKey} disabled={busy}
            accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}
            accessibilityLabel={miss === 'storage' ? 'Try loading the vault key again' : 'Start a new vault key'}>
            {busy ? <ActivityIndicator color={c.primary} /> : <Text style={s.btnText}>{miss === 'storage' ? 'Try again' : 'New key'}</Text>}
          </TouchableOpacity>
        ) : null}
      </View>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={s.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setOpen(false)}
            accessibilityRole="button" accessibilityLabel="Close" />
          <View style={s.panel}>
            <Text style={s.title} accessibilityRole="header">Try an old PIN</Text>
            <Text style={s.sub}>
              Enter a Device PIN you used before, then tap ✓. If it opens an old vault key, that key is
              re-sealed under your current PIN and its files open again. Nothing is deleted.
            </Text>
            <PinPad
              value={pin}
              onChange={(v) => { if (!trying) { setPin(v); setError(''); } }}
              length={PIN_MAX}
              minLength={PIN_MIN}
              onSubmit={submit}
              onComplete={submit}
              error={!!error}
            />
            {trying ? <ActivityIndicator color={c.primary} style={{ marginTop: 8 }} accessibilityLabel="Checking" /> : null}
            {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}
            <TouchableOpacity style={s.cancel} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}
