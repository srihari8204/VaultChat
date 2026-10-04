// components/spaces/NewRunModal.tsx — the "New run" dialog, split out of
// app/space-runs-admin.tsx. It owns its own fields; the screen owns the create
// call and what happens after it.

import React, { useState } from 'react';
import { View, TouchableOpacity, ActivityIndicator, TextInput, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
// The app's one cross-platform date+time picker (native dialog on Android,
// an inline sheet inside this dialog on iOS), in the app theme.
import { useDatePicker } from '../ui/useDatePicker';
import { plannedPickStart } from '../../lib/spaces/runPlan';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import type { RunsAdminStyles } from './runsAdminStyles';

export const RUN_KINDS: { key: string; label: string }[] = [
  { key: 'school_pickup', label: 'Morning pickup' },
  { key: 'school_drop', label: 'Afternoon drop' },
  { key: 'cab_pickup', label: 'Cab pickup' },
  { key: 'cab_drop', label: 'Cab drop' },
  { key: 'generic', label: 'Other' },
];

export const whenLabel = (d: Date) =>
  d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface NewRunBody {
  name: string; kind: string; vehicleLabel?: string; scheduledAt?: string; requireCode?: boolean;
}

export default function NewRunModal({ visible, colors, s, busy, onClose, onCreate }: {
  visible: boolean;
  colors: Palette;
  s: RunsAdminStyles;
  busy: boolean;
  onClose: () => void;
  /** Resolves true when the run was created; the fields are then cleared. */
  onCreate: (body: NewRunBody) => Promise<boolean>;
}) {
  const picker = useDatePicker(undefined, { inModal: true });
  const [name, setName] = useState('');
  const [kind, setKind] = useState('school_pickup');
  const [vehicle, setVehicle] = useState('');
  // When the run happens. Setting it here means stop times start on the run's
  // own day.
  const [when, setWhen] = useState<Date | null>(null);
  const [requireCode, setRequireCode] = useState(false);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    const ok = await onCreate({
      name: n, kind, vehicleLabel: vehicle.trim() || undefined,
      ...(when ? { scheduledAt: when.toISOString() } : {}),
      ...(requireCode ? { requireCode: true } : {}),
    });
    if (ok) { setName(''); setVehicle(''); setWhen(null); setRequireCode(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={picker.close}>
      <KeyboardSafe keyboardOnly>
      <View style={s.modalWrap}>
        <View style={s.modal}>
          <Text style={s.modalTitle} accessibilityRole="header">New run</Text>
          <TextInput
            style={s.input} value={name} onChangeText={setName}
            placeholder="Name, e.g. Route 1 morning" placeholderTextColor={colors.textDim} autoFocus
            accessibilityLabel="Run name"
          />
          <TextInput
            style={s.input} value={vehicle} onChangeText={setVehicle}
            placeholder="Vehicle, e.g. Bus 01" placeholderTextColor={colors.textDim}
            accessibilityLabel="Vehicle"
          />
          <View style={s.kinds} accessibilityRole="radiogroup" accessibilityLabel="Kind of run">
            {RUN_KINDS.map((k) => (
              <TouchableOpacity
                key={k.key}
                onPress={() => setKind(k.key)}
                accessibilityRole="radio"
                accessibilityState={{ checked: kind === k.key }}
                style={[s.kind, kind === k.key && { backgroundColor: colors.brandOnLight }]}
              >
                {/* White ink on the solid brandOnLight fill (deep blue in both schemes). */}
                <Text style={[s.kindText, kind === k.key && { color: colors.onBrand }]}>{k.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* When: picked, not typed. Optional — an unscheduled run asks for
              a day when a stop is given a planned time. */}
          <View style={s.pickRow}>
            <TouchableOpacity
              style={[s.addStop, { flex: 1 }]}
              onPress={() => picker.open(when ?? plannedPickStart(null, null, null, null, Date.now()), setWhen, 'datetime')}
              accessibilityRole="button"
              accessibilityLabel={when ? `Scheduled for ${whenLabel(when)}. Change` : 'Set the date and time of the run'}
            >
              <Ionicons name="calendar-outline" size={18} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: '600', flexShrink: 1 }}>
                {when ? whenLabel(when) : 'Set date and time (optional)'}
              </Text>
            </TouchableOpacity>
            {when && (
              <TouchableOpacity onPress={() => setWhen(null)} style={s.iconHit} accessibilityRole="button" accessibilityLabel="Clear the date and time">
                <Ionicons name="close-circle-outline" size={19} color={colors.textDim} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={s.pickRow} onPress={() => setRequireCode((v) => !v)}
            accessibilityRole="checkbox" accessibilityState={{ checked: requireCode }}
            accessibilityLabel="Ask for a handover code when a rider boards and is dropped off"
          >
            <Ionicons name={requireCode ? 'checkbox' : 'square-outline'} size={19} color={requireCode ? colors.primary : colors.textDim} />
            <Text style={[s.pickText, requireCode && { color: colors.text }]}>Ask for a handover code at boarding and drop-off</Text>
          </TouchableOpacity>
          <View style={s.modalRow}>
            <TouchableOpacity style={s.modalBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={s.muted}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modalBtn, s.primaryBtn, (!name.trim() || busy) && s.off]}
              onPress={create} disabled={!name.trim() || busy}
              accessibilityRole="button" accessibilityLabel="Create run"
              accessibilityState={{ disabled: !name.trim() || busy, busy }}
            >
              {busy ? <ActivityIndicator size="small" color={colors.onBrand} /> : <Text style={s.primaryText}>Create</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </KeyboardSafe>
      {/* Last child: on iOS the picker is an overlay inside this Modal, not a
          second Modal (components/ui/useDatePicker inModal). */}
      {picker.element}
    </Modal>
  );
}
