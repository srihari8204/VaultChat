// components/spaces/StopFormModal.tsx — the new/edit stop dialog, split out of
// app/space-runs-admin.tsx. Rendered INSIDE the run editor's Modal so it stacks
// above it on iOS. It turns the typed place into coordinates and the picked
// date+time into an instant; the screen builds and saves the stop list.

import React, { useEffect, useState } from 'react';
import { View, TouchableOpacity, ActivityIndicator, TextInput, Modal, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { useDatePicker } from '../ui/useDatePicker';
import { parseCoords, dayOf } from '../../lib/spaces/runPlan';
import { geocodeSearch } from '../../lib/nav/geocode';
import { permissionDenied } from '../../lib/permissionDenied';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import type { RunsAdminStyles } from './runsAdminStyles';
import { whenLabel } from './NewRunModal';
import { errMsg } from '../../lib/spaces/errors';

export interface StopFormInitial {
  /** Index into the ordered stops, or null for a new stop. */
  index: number | null;
  label: string;
  /** "lat, lng" or an address. */
  where: string;
  planned: Date | null;
}

export interface StopFormResult {
  label: string;
  place: { lat: number; lng: number } | null;
  plannedAt: string | null;
}

export default function StopFormModal({ initial, colors, s, busy, pickStart, scheduledAt, onClose, onSubmit }: {
  /** null = closed. */
  initial: StopFormInitial | null;
  colors: Palette;
  s: RunsAdminStyles;
  busy: boolean;
  /** Where the date+time picker starts when the stop has no planned time. */
  pickStart: Date;
  /** The run's scheduled instant, to point out a stop planned on another day. */
  scheduledAt: string | null;
  onClose: () => void;
  onSubmit: (v: StopFormResult) => void;
}) {
  const picker = useDatePicker(undefined, { inModal: true });
  const [label, setLabel] = useState('');
  const [where, setWhere] = useState('');
  const [planned, setPlanned] = useState<Date | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setLabel(initial.label); setWhere(initial.where); setPlanned(initial.planned);
  }, [initial]);

  const fillHere = async () => {
    try {
      const Location = await import('expo-location');
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        permissionDenied('Location needed', 'Allow location to place this stop where you are standing, or type an address or "lat, lng".', perm.canAskAgain);
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setWhere(`${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}`);
    } catch (e) {
      Alert.alert('Could not read your location', errMsg(e) ?? 'Try again.');
    }
  };

  const submit = async () => {
    const l = label.trim();
    if (!l) return;
    const w = where.trim();
    let place: { lat: number; lng: number } | null = null;
    if (w) {
      place = parseCoords(w);
      if (!place) {
        setLocating(true);
        const hits = await geocodeSearch(w).catch(() => []);
        setLocating(false);
        if (!hits[0]) {
          Alert.alert('Place not found', `Could not find "${w}". Try an address, "lat, lng", or use your current location.`);
          return;
        }
        place = { lat: hits[0].lat, lng: hits[0].lng };
      }
    }
    onSubmit({ label: l, place, plannedAt: planned ? planned.toISOString() : null });
  };

  // The day is visible in the picker and the label; say so when it is not the
  // run's own day, since "running late" is measured against this instant.
  const scheduledDay = dayOf(scheduledAt);
  const offDay = !!planned && !!scheduledDay && dayOf(planned.toISOString()) !== scheduledDay;
  const working = busy || locating;

  return (
    <Modal visible={!!initial} transparent animationType="fade" onRequestClose={onClose} onDismiss={picker.close}>
      <KeyboardSafe keyboardOnly>
      <View style={s.modalWrap}>
        <View style={s.modal}>
          <Text style={s.modalTitle} accessibilityRole="header">{initial?.index == null ? 'New stop' : 'Edit stop'}</Text>
          <TextInput
            style={s.input} value={label} autoFocus onChangeText={setLabel}
            placeholder="Name, e.g. Green Lane" placeholderTextColor={colors.textDim}
            accessibilityLabel="Stop name" maxLength={120}
          />
          <TextInput
            style={s.input} value={where} onChangeText={setWhere}
            placeholder='Address or "lat, lng" (optional)' placeholderTextColor={colors.textDim}
            accessibilityLabel="Stop location: an address or latitude, longitude"
          />
          <TouchableOpacity style={s.addStop} onPress={fillHere} accessibilityRole="button" accessibilityLabel="Use my current location">
            <Ionicons name="locate-outline" size={18} color={colors.primary} />
            <Text style={{ color: colors.primary, fontWeight: '600' }}>Use my current location</Text>
          </TouchableOpacity>
          {/* Picked, not typed: date and time together, so the planned instant
              is never measured against the wrong day. */}
          <View style={s.pickRow}>
            <TouchableOpacity
              style={[s.addStop, { flex: 1 }]}
              onPress={() => picker.open(planned ?? pickStart, setPlanned, 'datetime')}
              accessibilityRole="button"
              accessibilityLabel={planned ? `Planned for ${whenLabel(planned)}. Change` : 'Set a planned time, optional'}
            >
              <Ionicons name="time-outline" size={18} color={colors.primary} />
              <Text style={{ color: colors.primary, fontWeight: '600', flexShrink: 1 }}>
                {planned ? `Planned ${whenLabel(planned)}` : 'Set a planned time (optional)'}
              </Text>
            </TouchableOpacity>
            {planned && (
              <TouchableOpacity onPress={() => setPlanned(null)} style={s.iconHit} accessibilityRole="button" accessibilityLabel="Clear the planned time">
                <Ionicons name="close-circle-outline" size={19} color={colors.textDim} />
              </TouchableOpacity>
            )}
          </View>
          {offDay && (
            <Text style={[s.muted, { color: colors.warning }]}>
              This is not the run’s scheduled day. Lateness is measured against the date and time shown.
            </Text>
          )}
          <Text style={s.muted}>
            The location gives guardians an arrival estimate and lets the driver’s phone
            notice a route deviation. The planned time is what “running late” is measured against.
          </Text>
          <View style={s.modalRow}>
            <TouchableOpacity style={s.modalBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={s.muted}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modalBtn, s.primaryBtn, (!label.trim() || working) && s.off]}
              onPress={submit} disabled={!label.trim() || working}
              accessibilityRole="button" accessibilityLabel="Save stop"
              accessibilityState={{ disabled: !label.trim() || working, busy: working }}
            >
              {working ? <ActivityIndicator size="small" color={colors.onBrand} /> : <Text style={s.primaryText}>Save</Text>}
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
