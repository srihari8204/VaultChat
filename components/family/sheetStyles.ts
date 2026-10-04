// components/family/sheetStyles.ts — the bottom-sheet shape shared by the
// Family hub's sheets (manage, check-in, announcement). Colours are applied
// at the call site from the theme; this holds geometry only.

import { StyleSheet } from 'react-native';

export const sheetSt = StyleSheet.create({
  // The dimmed backdrop behind every sheet. Black at 50% over any theme is the
  // modal scrim convention, not a surface colour.
  modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modal: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, padding: 18, paddingBottom: 28, gap: 8 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  noteInput: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 48, marginTop: 4, fontSize: 14.5 },
});
