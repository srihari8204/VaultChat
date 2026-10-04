// components/ui/useDatePicker.tsx — one date (or date + time) picker for any
// screen, on both platforms, in the app theme.
//
// DateTimePickerAndroid.open exists only on Android, so on iOS a date field
// that called it directly was a button that did nothing. Android keeps its
// native dialog; iOS gets the inline DateTimePicker in a modal sheet with
// Cancel / Done. Finance screens use components/finance/useDatePicker, which
// is this hook with the finance palette passed as `skin`.
//
// Usage: const picker = useDatePicker();  picker.open(date, onPick[, 'datetime'])
//        and render {picker.element} once anywhere in the screen.

import React, { useCallback, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useTheme } from '../../lib/theme';
import { Button } from './Button';

export type PickMode = 'date' | 'datetime';
interface Request { mode: PickMode; onPick: (d: Date) => void }

/** Sheet colours; defaults come from the app theme. */
export interface DatePickerSkin {
  sheet: string; edge: string; accent: string;
  scrim: string; scrimOpacity: number;
}

export function useDatePicker(skin?: DatePickerSkin) {
  const { colors, scheme } = useTheme();
  const [req, setReq] = useState<Request | null>(null);
  const [draft, setDraft] = useState(() => new Date());

  const open = useCallback((value: Date, onPick: (d: Date) => void, mode: PickMode = 'date') => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value, mode: 'date',
        onChange: (e, d) => {
          if (e.type !== 'set' || !d) return;
          if (mode === 'date') { onPick(d); return; }
          // Android has no combined mode: chain the time dialog. Dismissing it
          // keeps the chosen day at the previous time of day.
          DateTimePickerAndroid.open({
            value, mode: 'time',
            onChange: (e2, t) => {
              const day = new Date(d);
              if (e2.type === 'set' && t) day.setHours(t.getHours(), t.getMinutes(), 0, 0);
              onPick(day);
            },
          });
        },
      });
      return;
    }
    setDraft(value);
    setReq({ mode, onPick });
  }, []);

  // Scrim from theme ink: the darkest ink of each scheme, faded by opacity, so
  // it dims the screen in light and dark alike.
  const k: DatePickerSkin = skin ?? {
    sheet: colors.surfaceSolid, edge: colors.border, accent: colors.primary,
    scrim: scheme === 'dark' ? colors.bg : colors.text,
    scrimOpacity: scheme === 'dark' ? 0.7 : 0.4,
  };
  const close = () => setReq(null);
  // iOS: this sheet is its own Modal, so don't open it from inside another
  // Modal (a second Modal may present behind the first). Screens with a modal
  // composer draw DateTimePicker inline instead (group-calendar does).
  const element = req ? (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.wrap}>
        <Pressable
          style={[styles.scrim, { backgroundColor: k.scrim, opacity: k.scrimOpacity }]}
          onPress={close} accessibilityRole="button" accessibilityLabel="Close the date picker" />
        <View style={[styles.sheet, { backgroundColor: k.sheet, borderColor: k.edge }]}>
          <DateTimePicker
            value={draft}
            mode={req.mode}
            display="inline"
            themeVariant={scheme === 'dark' ? 'dark' : 'light'}
            accentColor={k.accent}
            onChange={(_e, d) => { if (d) setDraft(d); }}
          />
          <View style={styles.row}>
            <Button title="Cancel" variant="ghost" onPress={close} style={styles.btn} />
            <Button title="Done" onPress={() => { req.onPick(draft); close(); }} style={styles.btn} />
          </View>
        </View>
      </View>
    </Modal>
  ) : null;

  return { open, element };
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: 32 },
  scrim: { ...StyleSheet.absoluteFillObject },
  sheet: { width: '100%', maxWidth: 600, alignSelf: 'center', borderRadius: 16, borderWidth: 1, padding: 12 },
  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btn: { flex: 1 },
});

export default useDatePicker;
