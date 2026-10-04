// components/groups/GroupEventComposer.tsx — the new/edit event sheet of the
// group calendar (app/group-calendar.tsx). It owns the draft (title, place,
// start, repeat) and hands it to `onSave`; sealing and sending stay with the
// screen. The screen remounts it (a new `key`) each time it opens, so a draft
// starts from `editing` or from the defaults, and a failed save keeps the
// sheet open with everything typed.

import React, { useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  ActivityIndicator, Modal, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui';
import { useDatePicker } from '../ui/useDatePicker';
import { brandAlpha } from '../../constants/theme';
import {
  withDayOffset, withHour, isDayOffset,
  type GroupEvent, type Recurrence,
} from '../../lib/groups/calendar';

export const REPEATS: { key: Recurrence; label: string }[] = [
  { key: 'none', label: 'Once' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

const WHEN: { label: string; addDays: number }[] = [
  { label: 'Today', addDays: 0 },
  { label: 'Tomorrow', addDays: 1 },
  { label: 'Next week', addDays: 7 },
];

const HOURS = [8, 9, 10, 12, 14, 16, 18, 19, 20];

export const dayLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
export const timeLabel = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const whenLabel = (ts: number) => `${dayLabel(ts)}, ${timeLabel(ts)}`;

/** A new event starts at 18:00 today unless the composer says otherwise. */
const defaultStart = () => withHour(Date.now(), 18);

/** What the sheet hands back; `title` and `location` are untrimmed. */
export interface EventDraft { title: string; location: string; start: number; repeat: Recurrence }

export function GroupEventComposer({ visible, editing, busy, canSave, onClose, onSave }: {
  visible: boolean;
  /** The event being edited, or null for a new one. */
  editing: GroupEvent | null;
  /** A save is in flight. */
  busy: boolean;
  /** Who I am is known (a new event needs its author). */
  canSave: boolean;
  onClose: () => void;
  onSave: (d: EventDraft) => void;
}) {
  const { colors, scheme } = useTheme();
  // A repeating event is edited as a series: the sheet shows the series start,
  // not the occurrence that was tapped.
  const [title, setTitle] = useState(editing?.title ?? '');
  const [location, setLocation] = useState(editing?.location ?? '');
  const [start, setStart] = useState(() => editing?.startsAt ?? defaultStart());
  const [repeat, setRepeat] = useState<Recurrence>(editing?.recurrence ?? 'none');
  // Android: the native date/time dialogs (not a React Modal). iOS: the picker
  // is drawn inline in the sheet, because the hook's iOS sheet is its own
  // <Modal> and a Modal presented from inside this one is unreliable.
  const picker = useDatePicker();
  const [pickingIOS, setPickingIOS] = useState(false);

  const startLabel = whenLabel(start);
  const pickStart = () => {
    if (Platform.OS === 'ios') setPickingIOS((v) => !v);
    else picker.open(new Date(start), (d) => setStart(d.getTime()), 'datetime');
  };
  const ready = !!title.trim() && !busy && canSave;
  const chip = (on: boolean) =>
    [st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }];

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-17): a React Native
            <Modal> is its own Android window and never receives the activity's
            adjustResize, and KAV's 'padding' math mixes Modal-relative layout
            coords with absolute screen coords, so the lift came up short.
            keyboardOnly: this sheet already sets its own bottom padding. */}
        <KeyboardSafe keyboardOnly style={[st.backdrop, { backgroundColor: colors.scrim }]}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose}
            accessibilityRole="button" accessibilityLabel="Close without saving" />
          {/* Scrolls when the inline iOS picker makes it taller than the screen. */}
          <ScrollView style={[st.sheet, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}
            contentContainerStyle={st.sheetBody} keyboardShouldPersistTaps="handled" bounces={false}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, marginBottom: 14 }} accessibilityRole="header">
              {editing ? 'Edit event' : 'New event'}
            </Text>

            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <Ionicons name="calendar" size={17} color={colors.textDim} />
              <TextInput value={title} onChangeText={setTitle} placeholder="What is it?" accessibilityLabel="Event title"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>
            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
              <Ionicons name="location-outline" size={17} color={colors.textDim} />
              <TextInput value={location} onChangeText={setLocation} placeholder="Where (optional)" accessibilityLabel="Where, optional"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>

            <TouchableOpacity
              onPress={pickStart}
              accessibilityRole="button" accessibilityLabel={`Starts ${startLabel}`}
              accessibilityHint={pickingIOS ? 'Hides the date and time picker' : 'Opens a date and time picker'}
              accessibilityState={Platform.OS === 'ios' ? { expanded: pickingIOS } : undefined}
              style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
              <Ionicons name="time-outline" size={17} color={colors.textDim} />
              <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{startLabel}</Text>
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>{pickingIOS ? 'Done' : 'Change'}</Text>
            </TouchableOpacity>
            {pickingIOS && (
              <DateTimePicker
                value={new Date(start)}
                mode="datetime"
                display="inline"
                themeVariant={scheme === 'dark' ? 'dark' : 'light'}
                accentColor={colors.primary}
                onChange={(_e, d) => { if (d) setStart(d.getTime()); }}
              />
            )}

            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Day">
              {WHEN.map((wd) => {
                const on = isDayOffset(start, wd.addDays, Date.now());
                return (
                  <TouchableOpacity key={wd.label} onPress={() => setStart((s0) => withDayOffset(s0, wd.addDays, Date.now()))}
                    accessibilityRole="radio" accessibilityLabel={wd.label} accessibilityState={{ selected: on, checked: on }}
                    style={chip(on)}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>{wd.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ gap: 7 }}
              accessibilityRole="radiogroup" accessibilityLabel="Time">
              {HOURS.map((h) => {
                const d = new Date(start);
                const on = d.getHours() === h && d.getMinutes() === 0;
                return (
                  <TouchableOpacity key={h} onPress={() => setStart((s0) => withHour(s0, h))}
                    accessibilityRole="radio" accessibilityLabel={`${String(h).padStart(2, '0')}:00`} accessibilityState={{ selected: on, checked: on }}
                    style={chip(on)}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>
                      {String(h).padStart(2, '0')}:00
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Repeat">
              {REPEATS.map((rp) => {
                const on = repeat === rp.key;
                return (
                  <TouchableOpacity key={rp.key} onPress={() => setRepeat(rp.key)}
                    accessibilityRole="radio" accessibilityLabel={`Repeat ${rp.label}`} accessibilityState={{ selected: on, checked: on }}
                    style={chip(on)}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>{rp.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {editing?.recurrence && editing.recurrence !== 'none' && (
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 12 }}>
                Changes apply to every repeat of this event.
              </Text>
            )}

            <TouchableOpacity onPress={() => onSave({ title, location, start, repeat })} disabled={!ready}
              accessibilityRole="button" accessibilityState={{ disabled: !ready, busy }}
              style={[st.btn, { backgroundColor: ready ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color={colors.onPrimary} />
                : <><Ionicons name="checkmark" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>{editing ? 'Save changes' : 'Add to calendar'}</Text></>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardSafe>
      </Modal>
      {/* Always null today (Android uses native dialogs, iOS the inline picker);
          kept outside the Modal so it can never nest inside it. */}
      {picker.element}
    </>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, flexGrow: 0, flexShrink: 1 },
  sheetBody: { padding: 18, paddingBottom: 32 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
  input: { flex: 1, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 18 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
});
