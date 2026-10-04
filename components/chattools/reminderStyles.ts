// components/chattools/reminderStyles.ts — styles shared by the reminder
// composer (app/message-reminder.tsx) and components/chattools/RemindersList.

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { HEADER_TOP } from '../../constants/layout';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

export function useReminderStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:      { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },

  previewCard:  { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, padding: 12 },
  previewLabel: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6 },
  previewBody:  { color: c.text, fontSize: 14, lineHeight: 20 },
  previewMissing: { color: c.textDim, fontStyle: 'italic' },

  gridCol:      { gap: 8 },
  preset:       { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  presetOff:    { opacity: 0.5 },
  presetLabel:  { color: c.text, fontSize: 15, fontWeight: '700' },
  presetSub:    { color: c.textDim, fontSize: 12, marginTop: 2 },

  busy:         { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:      { color: c.textDim, fontSize: 12 },
  note:         { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },

  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retryBtn:     { marginTop: 20, minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  retryTxt:     { color: c.onPrimary, fontWeight: '700' },
  clearBtn:     { marginTop: 8, minHeight: 44, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  clearTxt:     { color: c.danger, fontWeight: '700' },

  row:          { flexDirection: 'row', alignItems: 'center', paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  rowMain:      { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 20, paddingRight: 4, paddingVertical: 14 },
  cancelBtn:    { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconBox:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  iconTxt:      { fontSize: 18 },
  rowWhen:      { color: c.text, fontSize: 14, fontWeight: '700' },
  rowPreview:   { color: c.text, fontSize: 13, marginTop: 4 },
  rowSub:       { color: c.textDim, fontSize: 11, marginTop: 6 },
});
