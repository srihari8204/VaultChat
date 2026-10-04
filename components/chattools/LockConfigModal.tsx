// components/chattools/LockConfigModal.tsx — the per-chat lock setup dialog,
// its option lists and the dialog styles it shares with the screen's
// remove-lock PIN prompt. Split out of app/app-lock-chats.tsx unchanged in
// behaviour; the dialog now takes one draft object instead of eight props.

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo } from 'react';
import { ActivityIndicator, Modal, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { type AutoLockTimer, type LockMethod } from '../../lib/chatLock';
import { AppText as Text, KeyboardSafe } from '../ui';

/** Digits only, at most 8 — the chat PIN is 4–8 digits. */
export const digitsOnly = (t: string) => t.replace(/\D/g, '').slice(0, 8);

export const AUTO_LOCK_OPTIONS: { label: string; value: AutoLockTimer }[] = [
  { label: 'Immediately', value: 0 },
  { label: 'After 1 min', value: 60 },
  { label: 'After 5 min', value: 300 },
];

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export const LOCK_METHOD_OPTIONS: { label: string; value: LockMethod; icon: IconName }[] = [
  { label: 'Biometric', value: 'biometric', icon: 'finger-print' },
  { label: 'PIN', value: 'pin', icon: 'keypad' },
  { label: 'Both', value: 'both', icon: 'shield-checkmark' },
];

export function useLockDialogStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeDialogStyles(colors), [colors]);
}

/** What the setup dialog edits. */
export interface LockDraft { method: LockMethod; timer: AutoLockTimer; pin: string; pinConfirm: string }

// The lock setup dialog for one chat. Its state lives in the screen (the
// entry-from-a-chat effect pre-selects the method), so it is passed in as one
// draft plus a patch callback.
export function LockConfigModal({
  chatName, methods, draft, onChange, saving, onCancel, onConfirm,
}: {
  chatName: string;
  /** The methods this device can satisfy (the screen filters LOCK_METHOD_OPTIONS). */
  methods: typeof LOCK_METHOD_OPTIONS;
  draft: LockDraft; onChange: (patch: Partial<LockDraft>) => void;
  saving: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const { colors } = useTheme();
  const s = useLockDialogStyles();
  const { method, timer, pin, pinConfirm } = draft;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
    <KeyboardSafe style={s.fill}>
    <View style={s.overlay}>
      <View style={s.configPanel}>
        <Text style={s.configTitle} accessibilityRole="header">Lock &quot;{chatName}&quot;</Text>

        <Text style={s.configLabel}>Lock Method</Text>
        <View style={s.chipRow}>
          {methods.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[s.chip, method === opt.value && s.chipActive]}
              onPress={() => onChange({ method: opt.value })}
              accessibilityRole="radio"
              accessibilityLabel={`Lock method: ${opt.label}`}
              accessibilityState={{ checked: method === opt.value }}
            >
              <Ionicons name={opt.icon} size={16} color={method === opt.value ? colors.accent : colors.textDim} />
              <Text style={[s.chipText, method === opt.value && s.chipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {(method === 'pin' || method === 'both') && (
          <>
            <Text style={s.configLabel}>Set PIN (4–8 digits)</Text>
            <TextInput
              style={s.pinInput}
              value={pin}
              onChangeText={(t) => onChange({ pin: digitsOnly(t) })}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              placeholderTextColor={colors.textFaint}
              placeholder="Enter PIN"
              accessibilityLabel="New chat PIN"
            />
            <TextInput
              style={[s.pinInput, s.pinInputNext]}
              value={pinConfirm}
              onChangeText={(t) => onChange({ pinConfirm: digitsOnly(t) })}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              placeholderTextColor={colors.textFaint}
              placeholder="Enter PIN again"
              accessibilityLabel="Confirm chat PIN"
            />
          </>
        )}

        <Text style={s.configLabel}>Auto-Lock After</Text>
        <View style={s.chipRow}>
          {AUTO_LOCK_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[s.chip, timer === opt.value && s.chipActive]}
              onPress={() => onChange({ timer: opt.value })}
              accessibilityRole="radio"
              accessibilityLabel={`Auto-lock: ${opt.label}`}
              accessibilityState={{ checked: timer === opt.value }}
            >
              <Text style={[s.chipText, timer === opt.value && s.chipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={s.configActions}>
          <TouchableOpacity
            style={s.cancelBtn}
            onPress={onCancel}
            accessibilityRole="button"
          >
            <Text style={s.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.confirmBtn, saving && s.btnBusy]}
            onPress={onConfirm}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={`Enable lock on ${chatName}`}
            accessibilityState={{ disabled: saving, busy: saving }}
          >
            {/* Brand gradient CTA; its text is the white on-accent token. */}
            <LinearGradient
              colors={[colors.accentLight, colors.accentDeep]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.confirmBtnGrad}
            >
              {saving
                ? <ActivityIndicator color={colors.onPrimary} size="small" />
                : <Ionicons name="lock-closed" size={16} color={colors.onPrimary} style={s.confirmIcon} />}
              <Text style={s.confirmBtnText}>Enable Lock</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </View>
    </KeyboardSafe>
    </Modal>
  );
}

const makeDialogStyles = (c: Palette) => StyleSheet.create({
  fill: { flex: 1 },
  // Config overlay
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  configPanel: {
    width: '100%',
    backgroundColor: c.glass,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  configTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 20, textAlign: 'center' },
  configLabel: { fontSize: 13, color: c.textDim, marginTop: 16, marginBottom: 8, fontWeight: '600' },

  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: c.surfaceSolid,
    borderWidth: 1,
    borderColor: c.glassStroke,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipActive: { backgroundColor: c.glass, borderColor: c.accent },
  chipText: { fontSize: 13, color: c.textDim, fontWeight: '600' },
  chipTextActive: { color: c.accent },

  pinInput: {
    backgroundColor: c.surfaceSolid,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: c.text,
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },

  configActions: { flexDirection: 'row', marginTop: 24, gap: 12 },
  cancelBtn: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.glassStroke,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, color: c.textDim, fontWeight: '600' },
  confirmBtn: { flex: 2, borderRadius: 10, overflow: 'hidden' },
  removeBtn: { flex: 2, minHeight: 44, borderRadius: 10, backgroundColor: c.danger, justifyContent: 'center', alignItems: 'center', paddingVertical: 12 },
  confirmBtnGrad: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: 12,
  },
  // White on the accent gradient and on the danger fill, in both themes.
  confirmBtnText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },
  removeBtnText: { fontSize: 14, fontWeight: '700', color: c.onDanger },
  pinInputNext: { marginTop: 8 },
  errTxt: { color: c.danger },
  btnBusy: { opacity: 0.6 },
  confirmIcon: { marginRight: 6 },
});
