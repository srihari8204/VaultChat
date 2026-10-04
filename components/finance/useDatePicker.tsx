// components/finance/useDatePicker.tsx — one date (or date + time) picker for
// every finance form, on both platforms.
//
// Every finance screen used to call DateTimePickerAndroid.open directly. That
// API exists only on Android, so on iOS (a configured target, app.json) each
// date field was a button that did nothing. Android keeps its native dialog;
// iOS gets the inline DateTimePicker in a modal sheet with Cancel / Done.
//
// Usage: const picker = useDatePicker();  picker.open(date, onPick[, 'datetime'])
//        and render {picker.element} once anywhere in the screen.

import React, { useCallback, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useTheme } from '../../lib/theme';
import { useFinanceTheme } from './useFinanceTheme';
import { Btn } from './ui';

type PickMode = 'date' | 'datetime';
interface Request { mode: PickMode; onPick: (d: Date) => void }

export function useDatePicker() {
  const FIN = useFinanceTheme();
  const { scheme } = useTheme();
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

  const close = () => setReq(null);
  const element = req ? (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.wrap}>
        <Pressable style={styles.scrim} onPress={close} accessibilityRole="button" accessibilityLabel="Close the date picker" />
        <View style={[styles.sheet, { backgroundColor: FIN.cardSolid, borderColor: FIN.glassEdge }]}>
          <DateTimePicker
            value={draft}
            mode={req.mode}
            display="inline"
            themeVariant={scheme === 'dark' ? 'dark' : 'light'}
            accentColor={FIN.brandDeep}
            onChange={(_e, d) => { if (d) setDraft(d); }}
          />
          <View style={styles.row}>
            <Btn label="Cancel" kind="ghost" onPress={close} wide />
            <Btn label="Done" onPress={() => { req.onPick(draft); close(); }} wide />
          </View>
        </View>
      </View>
    </Modal>
  ) : null;

  return { open, element };
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: 32 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { width: '100%', maxWidth: 600, alignSelf: 'center', borderRadius: 16, borderWidth: 1, padding: 12 },
  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
});

export default useDatePicker;
