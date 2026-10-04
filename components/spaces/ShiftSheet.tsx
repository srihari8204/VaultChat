// components/spaces/ShiftSheet.tsx — set a space's shift window and how late a
// run may be before guardians are told.
//
// setShift had no caller, so "late", "left early" and "absent" were never
// computed and the attendance screen's advice to set a shift pointed at a
// setting that did not exist. Validation lives in lib/spaces/shift.ts.

import React, { useEffect, useState } from 'react';
import {
  View, Modal, TouchableOpacity, TextInput, Alert, ActivityIndicator, StyleSheet,
} from 'react-native';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import type { SpacePalette } from '../../lib/spaces/theme';
import { setShift } from '../../lib/spaces/api';
import { shiftBody, loadSavedShift, rememberShift, type ShiftForm } from '../../lib/spaces/shift';

export default function ShiftSheet({ visible, onClose, colors, spaceId }: {
  visible: boolean; onClose: () => void; colors: SpacePalette; spaceId: string;
}) {
  const [form, setForm] = useState<ShiftForm>({ start: '', end: '', grace: '', delay: '' });
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pre-fill with what THIS device last saved — the server has no read for it.
  useEffect(() => {
    if (!visible) return;
    let live = true;
    loadSavedShift(spaceId).then((b) => {
      if (!live) return;
      setKnown(!!b);
      setForm(b
        ? { start: b.shiftStart, end: b.shiftEnd, grace: String(b.shiftGraceMinutes), delay: b.runDelayThresholdMinutes ? String(b.runDelayThresholdMinutes) : '' }
        : { start: '', end: '', grace: '', delay: '' });
    });
    return () => { live = false; };
  }, [visible, spaceId]);

  const save = async () => {
    const r = shiftBody(form);
    if ('error' in r) { Alert.alert('Check the times', r.error); return; }
    setBusy(true);
    try {
      await setShift(spaceId, r.body);
      await rememberShift(spaceId, r.body);
      onClose();
    } catch (e: any) {
      Alert.alert('Could not save the shift', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const field = (k: keyof ShiftForm, label: string, placeholder: string, numeric = false) => (
    <View style={{ gap: 4 }}>
      <Text style={[s.label, { color: colors.textDim }]}>{label}</Text>
      <TextInput
        style={[s.input, { borderColor: colors.glassStroke, color: colors.text }]}
        value={form[k]} onChangeText={(t) => setForm((f) => ({ ...f, [k]: t }))}
        placeholder={placeholder} placeholderTextColor={colors.textDim}
        keyboardType={numeric ? 'number-pad' : 'numbers-and-punctuation'} maxLength={5}
        accessibilityLabel={label}
      />
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardSafe keyboardOnly>
        <View style={s.wrap}>
          <View style={[s.modal, { backgroundColor: colors.bg }]}>
            <Text style={[s.title, { color: colors.text }]}>Shift and lateness</Text>
            <Text style={{ color: colors.textDim, fontSize: 12.5 }}>
              {known
                ? 'Showing what was last saved from this device.'
                : 'The current setting cannot be read back from the server, so these fields start empty. Saving replaces it.'}
            </Text>
            <View style={s.pair}>
              <View style={{ flex: 1 }}>{field('start', 'Shift starts', '09:00')}</View>
              <View style={{ flex: 1 }}>{field('end', 'Shift ends', '17:30')}</View>
            </View>
            {field('grace', 'Grace before “late” (minutes)', '10', true)}
            {field('delay', 'Tell guardians a run is late after (minutes)', 'Keep current', true)}
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              Leave both shift times empty to clear the shift. Times are local to the workplace.
            </Text>
            <View style={s.row}>
              <TouchableOpacity style={s.btn} onPress={onClose} accessibilityRole="button">
                <Text style={{ color: colors.textDim }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { backgroundColor: colors.brandOnLight }, busy && { opacity: 0.4 }]}
                onPress={save} disabled={busy}
                accessibilityRole="button" accessibilityLabel="Save shift" accessibilityState={{ disabled: busy }}
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', borderRadius: 16, padding: 20, gap: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  label: { fontSize: 12 },
  pair: { flexDirection: 'row', gap: 10 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  btn: { paddingHorizontal: 18, minHeight: 44, justifyContent: 'center', borderRadius: 10 },
});
