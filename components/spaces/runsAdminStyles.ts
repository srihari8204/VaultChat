// components/spaces/runsAdminStyles.ts — styles shared by app/space-runs-admin.tsx
// and the dialogs split out of it (NewRunModal, StopFormModal), so the three
// stay one visual piece.

import { StyleSheet } from 'react-native';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';

export const runsAdminStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  section: { color: c.textDim, fontSize: 11.5, letterSpacing: 1, marginTop: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, minHeight: 44 },
  pickText: { color: c.textDim, flex: 1, fontSize: 14.5 },
  seq: { color: c.textDim, width: 20, fontVariant: ['tabular-nums'] },
  addStop: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  iconHit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  riderToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minHeight: 44 },
  stopChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 160, minHeight: 44,
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 16, paddingHorizontal: 10,
  },
  stopChipText: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  input: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12,
    color: c.text, fontSize: 15,
  },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 22, paddingHorizontal: 14,
    minHeight: 44, justifyContent: 'center',
  },
  kindText: { color: c.textDim, fontSize: 12.5 },
  // The theme's scrim (Palette.scrim) behind the dialog.
  modalWrap: { flex: 1, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  primaryBtn: { backgroundColor: c.brandOnLight },
  // White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1).
  primaryText: { color: c.onBrand, fontWeight: '700' },
  off: { opacity: 0.4 },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: c.glassStroke,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '700', flex: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
});

export type RunsAdminStyles = ReturnType<typeof runsAdminStyles>;
