// components/groups/communityStyles.ts — styles shared by app/communities.tsx
// and its two pieces (CommunityDetailView, CommunityNameModal).

import { StyleSheet } from 'react-native';
import { HEADER_TOP, SCREEN_BOTTOM } from '../../constants/layout';
import { type Palette } from '../../constants/theme';

export const makeCommunityStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:  { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32, paddingVertical: 32 },
  listContent: { paddingTop: 8, paddingBottom: SCREEN_BOTTOM + 16 },
  header:  { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  hBtn:    { width: 44, height: 44, borderRadius: 16, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  hTitle:  { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },

  commHero: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  commIcon: { width: 80, height: 80, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  commName: { color: c.text, fontSize: 22, fontWeight: '800', marginTop: 8 },
  commDesc: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, paddingHorizontal: 24 },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginHorizontal: 16, marginTop: 8, marginBottom: 4 },

  row:      { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginBottom: 10, padding: 16, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  rowName:  { color: c.text, fontSize: 16, fontWeight: '600' },
  rowSub:   { color: c.textDim, fontSize: 13, marginTop: 2 },
  commIconSm: { width: 48, height: 48, borderRadius: 16, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  groupIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },
  addRow:   { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  addIcon:  { width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  addTxt:   { color: c.primary, fontSize: 16, fontWeight: '600' },
  dangerRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  dangerTxt: { color: c.danger, fontSize: 16, fontWeight: '600' },

  errBar:   { marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.danger },
  errTxt:   { color: c.danger, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  emptySub: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cta:      { marginTop: 8, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14 },
  ctaTxt:   { color: c.onPrimary, fontWeight: '800', fontSize: 14 },

  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  modalScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalCard: { width: '100%', maxWidth: 420, maxHeight: '100%', flexGrow: 0, backgroundColor: c.surfaceSolid, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  modalContent: { padding: 20, gap: 12 },
  modalTitle: { color: c.text, fontSize: 17, fontWeight: '800' },
  modalInput: { color: c.text, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  modalBtn:  { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  modalBtnPrimary: { backgroundColor: c.primary, minWidth: 84, alignItems: 'center' },
  modalCancel: { color: c.textDim, fontWeight: '700' },
  modalCreate: { color: c.onPrimary, fontWeight: '800' },
});

export type CommunityStyles = ReturnType<typeof makeCommunityStyles>;
