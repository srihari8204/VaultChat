// components/chattools/BackupSecretModal.tsx — asks for the password or
// 64-character key an end-to-end encrypted backup copy was made with (split
// out of app/chat-backup.tsx, which owns the restore flow).
//
// Alert.prompt is iOS-only, and this is exactly the moment a returning Android
// user hits — a fresh install with their whole history behind one secret. The
// secret is masked by default (shoulder-surfing); Show reveals it to check a
// long key. What was typed is dropped when the dialog closes.

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { KeyboardSafe } from '../ui/KeyboardSafe';

export function BackupSecretModal({ ask, sourceName, busy, unlocking, onCancel, onUnlock }: {
  /** The copy that asked, and which kind of secret it needs; null = closed. */
  ask: { mode: 'password' | 'key' } | null;
  /** Where that copy is ("Google Drive", "your account"). */
  sourceName: string;
  busy: boolean;
  /** A restore with the typed secret is running. */
  unlocking: boolean;
  onCancel: () => void;
  onUnlock: (secret: string) => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [secretInput, setSecretInput] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  useEffect(() => { if (!ask) { setSecretInput(''); setShowSecret(false); } }, [ask]);
  const askSecret = ask?.mode ?? null;

  return (
    <Modal visible={askSecret !== null} transparent animationType="fade"
           onRequestClose={onCancel}>
      <KeyboardSafe keyboardOnly>
      <View style={s.modalWrap}>
        <View style={s.modalCard}>
          <Text style={s.modalTitle} accessibilityRole="header">
            {askSecret === 'key' ? 'Enter your 64-character key' : 'Enter your backup password'}
          </Text>
          <Text style={s.modalBody}>
            The copy in {sourceName} is end-to-end encrypted. It can only be
            unlocked with the {askSecret === 'key' ? 'key' : 'password'} it was made with — if you have changed
            it since, use the one you had then.
          </Text>
          <TextInput
            style={[s.modalInput, askSecret === 'key' && s.modalInputMono, askSecret === 'key' && showSecret && s.modalInputTall]}
            value={secretInput}
            onChangeText={setSecretInput}
            // secureTextEntry cannot be multiline, so the key wraps only when shown.
            secureTextEntry={!showSecret}
            autoFocus
            multiline={askSecret === 'key' && showSecret}
            importantForAutofill="no"
            autoComplete="off"
            placeholder={askSecret === 'key' ? '0000 0000 0000 …' : 'Password'}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={askSecret === 'key' ? '64-character backup key' : 'Backup password'}
          />
          <TouchableOpacity
            onPress={() => setShowSecret(v => !v)}
            style={s.showBtn}
            accessibilityRole="switch"
            accessibilityLabel={askSecret === 'key' ? 'Show key' : 'Show password'}
            accessibilityState={{ checked: showSecret }}>
            <Ionicons name={showSecret ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.primary} />
            <Text style={s.showTxt}>{showSecret ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
          <View style={s.modalBtns}>
            <TouchableOpacity onPress={onCancel} disabled={busy} style={s.modalBtn} accessibilityRole="button">
              <Text style={s.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onUnlock(secretInput)}
              disabled={busy || !secretInput.trim()}
              style={s.modalBtn}
              accessibilityRole="button"
              accessibilityLabel="Unlock backup"
              accessibilityState={{ disabled: busy || !secretInput.trim() }}>
              {unlocking
                ? <ActivityIndicator color={colors.primary} />
                : <Text style={[s.modalOk, !secretInput.trim() && s.btnOff]}>UNLOCK</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </KeyboardSafe>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  // The theme's scrim dims whatever is behind the dialog.
  modalWrap: { flex: 1, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: c.bg, borderRadius: 14, padding: 20 },
  modalTitle: { color: c.text, fontSize: 17, fontWeight: '700', marginBottom: 8 },
  modalBody: { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  modalInput: {
    color: c.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  modalInputMono: { letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  modalInputTall: { minHeight: 92, textAlignVertical: 'top' },
  showBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44 },
  showTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 18 },
  modalBtn: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  modalCancel: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  modalOk: { color: c.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  btnOff: { opacity: 0.6 },
});

export default BackupSecretModal;
