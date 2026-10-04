// components/family/PlaceEditSheet.tsx — the Safe Zones "Edit place" sheet,
// moved out of app/family-places.tsx. The sheet owns the form (name, radius,
// schedule, lifetime) and validates it; the screen persists the result and
// owns everything that touches the lock engine or the reference place.

import React, { useState } from 'react';
import { View, Modal, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui';
import { useTheme } from '../../lib/theme';
import { brandAlpha } from '../../constants/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { type Geofence, type ZoneSchedule } from '../../lib/family/geofence';
import {
  RADII, MIN_RADIUS, MAX_RADIUS, DAYS, DAY_NAMES, PRESETS, LIFETIMES, CHIP_SLOP, hhmm, iconFor,
} from '../../lib/family/placeOptions';
import { sheetSt } from './sheetStyles';

export interface PlacePatch {
  name: string;
  radiusM: number;
  /** Undefined rather than null, so an "always on / permanent" zone carries
   *  no schedule keys at all and reads identically to one saved before
   *  schedules existed. */
  schedule?: ZoneSchedule;
  expiresAt?: number;
}

/** One single-choice chip (radius, window, lifetime): a radio. */
export function ZoneChoice({ on, label, a11y, onPress, fontSize = 12.5, bold = true }: {
  on: boolean; label: string; a11y?: string; onPress: () => void; fontSize?: number; bold?: boolean;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <TouchableOpacity onPress={onPress}
      accessibilityRole="radio" accessibilityState={{ checked: on, selected: on }} accessibilityLabel={a11y ?? label}
      hitSlop={CHIP_SLOP}
      style={[st.rchip, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}>
      <Text numberOfLines={1} style={{ color: on ? G.accentText : colors.text, fontSize, fontWeight: bold && on ? '700' : '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function PlaceEditSheet({
  place, locked, saving, onClose, onSave, onDelete, onNavigate, onLock, onUnlock, onViewLock,
}: {
  place: Geofence | null;
  /** The shared Location Lock is armed on this place. */
  locked: boolean;
  /** A save is in flight — Save ignores repeat taps until it lands. */
  saving: boolean;
  onClose: () => void;
  onSave: (patch: PlacePatch) => void;
  onDelete: (p: Geofence) => void;
  onNavigate: (p: Geofence) => void;
  onLock: (p: Geofence) => void;
  onUnlock: () => void;
  onViewLock: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const [name, setName] = useState('');
  const [radius, setRadius] = useState('');
  const [sched, setSched] = useState<ZoneSchedule | null>(null);
  const [expiry, setExpiry] = useState<number | null>(null);
  /** Which timed lifetime chip was tapped in this edit (null = none / permanent). */
  const [life, setLife] = useState<string | null>(null);
  // Reset the form on every open — during render, so the sheet never shows the
  // previous edit's values for a frame. Closing forgets which place the form
  // was for, so reopening the SAME place drops edits abandoned with
  // "Close without saving" instead of offering them to Save.
  const [formFor, setFormFor] = useState<Geofence | null>(null);
  if (!place && formFor) setFormFor(null);
  if (place && place !== formFor) {
    setFormFor(place);
    setName(place.name);
    setRadius(String(place.radiusM));
    setSched(place.schedule ?? null);
    setExpiry(place.expiresAt ?? null);
    setLife(null);
  }

  const save = () => {
    if (saving) return;
    const nm = name.trim();
    const r = Math.round(Number(radius));
    if (!nm) { Alert.alert('Name required', 'Give the place a name.'); return; }
    if (!Number.isFinite(r) || r < MIN_RADIUS || r > MAX_RADIUS) {
      Alert.alert('Radius', `Pick a radius between ${MIN_RADIUS} and ${MAX_RADIUS} metres.`);
      return;
    }
    onSave({ name: nm, radiusM: r, schedule: sched ?? undefined, expiresAt: expiry ?? undefined });
  };

  return (
    <Modal visible={!!place} transparent animationType="slide" onRequestClose={onClose}>
      {/* KeyboardSafe, not the screen-level one (2026-09-18): a React Native
          <Modal> is its own Android window, so the wrapper around the screen
          does not reach in here and the sheet — which is pinned to the
          bottom — sat underneath the keyboard. keyboardOnly: the sheet
          already pads its own bottom. */}
      <KeyboardSafe keyboardOnly style={sheetSt.modalWrap}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose}
          accessibilityRole="button" accessibilityLabel="Close without saving" />
        {/* Height-capped with an inner scroll: radius + schedule + lifetime
            + four buttons overflow a short phone, and the keyboard renders
            over a native Modal with no KeyboardAvoidingView — scrolling is
            what keeps Save reachable while typing. */}
        <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '88%' }]}>
          <View style={[sheetSt.grab, { backgroundColor: colors.border }]} />
          <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '800', fontSize: 18, marginBottom: 14, textAlign: 'center' }}>Edit place</Text>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">

          <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}>
            <Ionicons name={iconFor(name)} size={18} color={colors.textDim} />
            <TextInput value={name} onChangeText={setName} placeholder="Name"
              accessibilityLabel="Place name" maxLength={60}
              placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} />
          </View>

          <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint, marginTop: 10 }]}>
            <Ionicons name="resize" size={18} color={colors.textDim} />
            <TextInput value={radius} onChangeText={setRadius} keyboardType="number-pad"
              accessibilityLabel={`Radius in metres, ${MIN_RADIUS} to ${MAX_RADIUS}`} maxLength={4}
              placeholder={`Radius in metres (${MIN_RADIUS}–${MAX_RADIUS})`} placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text }]} />
          </View>

          <View style={st.radii} accessibilityRole="radiogroup" accessibilityLabel="Radius">
            {RADII.map((r) => (
              <ZoneChoice key={r} on={Number(radius) === r} label={`${r} m`} a11y={`${r} metre radius`}
                fontSize={13} bold={false} onPress={() => setRadius(String(r))} />
            ))}
          </View>

          <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 20, marginBottom: 8 }]}>When it&apos;s active</Text>
          <View style={st.radii} accessibilityRole="radiogroup" accessibilityLabel="When it's active">
            {PRESETS.map((pr) => {
              // "Always" is the one with no schedule; the rest match on window.
              const on = pr.sched == null
                ? sched == null
                : !!sched && sched.fromMin === pr.sched.fromMin && sched.toMin === pr.sched.toMin;
              return (
                <ZoneChoice key={pr.label} on={on} label={pr.label}
                  onPress={() => setSched(pr.sched ? { ...pr.sched } : null)} />
              );
            })}
          </View>

          {!!sched && (
            <>
              <View style={[st.days, { marginTop: 12 }]}>
                {DAYS.map((d, i) => {
                  // An empty day list means EVERY day, so render that as all-on
                  // rather than as none-selected, which would read as broken.
                  const all = !sched.days || sched.days.length === 0;
                  const on = all || sched.days!.includes(i);
                  return (
                    <TouchableOpacity key={i} onPress={() => {
                      const cur = all ? [0, 1, 2, 3, 4, 5, 6] : [...sched.days!];
                      const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
                      // Deselecting the last day would silently disable the zone;
                      // treat "none" as "every day" instead.
                      setSched({ ...sched, days: next.length ? next : [] });
                    }}
                      accessibilityRole="checkbox" accessibilityLabel={DAY_NAMES[i]} accessibilityState={{ checked: on }}
                      hitSlop={CHIP_SLOP}
                      style={[st.day, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}>
                      <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 12, fontWeight: '700' }}>{d}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 10 }}>
                {hhmm(sched.fromMin)} to {hhmm(sched.toMin)}
                {sched.fromMin > sched.toMin ? ' (overnight)' : ''}
              </Text>
            </>
          )}

          <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 20, marginBottom: 8 }]}>How long it lasts</Text>
          <View style={st.radii} accessibilityRole="radiogroup" accessibilityLabel="How long it lasts">
            {/* A timed zone reopened for editing: its CURRENT lifetime is a
                chip of its own, selected until another is picked — the timed
                chips below are relative to now and can never match it. */}
            {place?.expiresAt != null && place.expiresAt > Date.now() && (() => {
              const until = new Date(place.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
              return (
                <ZoneChoice on={expiry === place.expiresAt} label={`Until ${until}`}
                  a11y={`Keep the current end time, ${until}`}
                  onPress={() => { setExpiry(place.expiresAt!); setLife(null); }} />
              );
            })()}
            {LIFETIMES.map((lt) => (
              // Timed choices are remembered by label for this edit: the
              // stored value is an absolute expiresAt, which no chip matches.
              <ZoneChoice key={lt.label} on={lt.ms == null ? expiry == null : life === lt.label} label={lt.label}
                onPress={() => { setExpiry(lt.ms == null ? null : Date.now() + lt.ms); setLife(lt.ms == null ? null : lt.label); }} />
            ))}
          </View>
          {expiry != null && (
            <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 8 }}>
              Stops on {new Date(expiry).toLocaleString()}
            </Text>
          )}

          {/* v3 — actions on the shared engines (Navigate module + Lock engine) */}
          {place && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
              <TouchableOpacity
                onPress={() => onNavigate(place)}
                accessibilityRole="button" accessibilityLabel={`Navigate to ${place.name}`}
                style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: G.chipEdge }]}>
                <Ionicons name="navigate" size={17} color={colors.primary} />
                <Text style={[st.btnTxt, { color: colors.text }]}>Navigate</Text>
              </TouchableOpacity>
              {locked ? (
                <TouchableOpacity onPress={onUnlock} accessibilityRole="button" accessibilityLabel={`Unlock ${place.name}`}
                  style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger }]}>
                  <Ionicons name="lock-open" size={17} color={G.dangerText} />
                  <Text style={[st.btnTxt, { color: G.dangerText }]}>Unlock</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => onLock(place)} accessibilityRole="button" accessibilityLabel={`Lock at ${place.name}`}
                  style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary }]}>
                  <Ionicons name="lock-closed" size={17} color={colors.primary} />
                  <Text style={[st.btnTxt, { color: G.accentText }]}>Lock here</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          {place && locked && (
            <TouchableOpacity onPress={onViewLock} accessibilityRole="link" hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} style={{ alignSelf: 'center', marginTop: 10 }}>
              <Text style={{ color: G.accentText, fontWeight: '600', fontSize: 13 }}>View live lock status</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={save} disabled={saving}
            accessibilityRole="button" accessibilityLabel="Save place" accessibilityState={{ disabled: saving, busy: saving }}
            style={[st.btn, { backgroundColor: saving ? colors.border : colors.brandOnLight }]}>
            {saving
              ? <ActivityIndicator color={colors.onPrimary} />
              : <><Ionicons name="checkmark" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>Save</Text></>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => place && onDelete(place)} accessibilityRole="button" style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger, marginTop: 8 }]}>
            <Ionicons name="trash" size={18} color={G.dangerText} />
            <Text style={[st.btnTxt, { color: G.dangerText }]}>Delete place</Text>
          </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardSafe>
    </Modal>
  );
}

// The same geometry the Safe Zones screen uses for its own form.
export const st = StyleSheet.create({
  h: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 50 },
  input: { flex: 1, fontSize: 15 },
  radii: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  days: { flexDirection: 'row', gap: 6 },
  // 2026-09-18: the day letter scales with the OS font, the pinned 36 did not.
  // minHeight keeps the row of seven identical at scale 1.0.
  day: { flex: 1, minHeight: 36, paddingVertical: 6, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rchip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 16, marginTop: 14 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderTopWidth: 1, padding: 18, paddingBottom: 34 },
});
