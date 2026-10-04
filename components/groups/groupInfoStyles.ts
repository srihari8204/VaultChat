// components/groups/groupInfoStyles.ts — the styles of app/group-info.tsx,
// shared with its sections (components/groups/GroupInfoSections.tsx).

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { HEADER_TOP } from '../../constants/layout';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

export function useGroupInfoStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeGroupInfoStyles(colors), [colors]);
}

export const makeGroupInfoStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 8, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  titleBar:      { color: c.text, fontSize: 22, fontWeight: '800' },

  heroWrap:      { alignItems: 'center', paddingVertical: 20, gap: 8 },
  hero:          { width: 112, height: 112, borderRadius: 56, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  heroImg:       { width: '100%', height: '100%' },
  heroTxt:       { color: c.onPrimary, fontSize: 48, fontWeight: '800' },
  heroBusy:      { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  heroEditPill:  { position: 'absolute', right: 0, bottom: 0, backgroundColor: c.primary, borderRadius: 16, padding: 6, borderWidth: 2, borderColor: c.bg },
  groupName:     { color: c.text, fontSize: 22, fontWeight: '700' },
  subInfo:       { color: c.textDim, fontSize: 12 },

  renameRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, width: '100%' },
  renameInput:   { flex: 1, color: c.text, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  saveBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  saveBtnTxt:    { color: c.onPrimary, fontWeight: '700' },

  staleBar:      { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 4, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: c.danger },
  staleTxt:      { color: c.danger, fontSize: 12.5, flex: 1 },
  addBtn:        { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center', justifyContent: 'center' },
  addBtnTxt:     { color: c.primary, fontWeight: '700' },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  navRow:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  navIcon:       { width: 28, textAlign: 'center' },
  navTitle:      { color: c.text, fontSize: 15, fontWeight: '600' },
  navSub:        { color: c.textDim, fontSize: 12, marginTop: 2 },
  mediaGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 12 },

  descText:      { color: c.text, fontSize: 15, lineHeight: 21, marginTop: 4 },
  descPlaceholder: { color: c.textDim, fontSize: 15, marginTop: 4 },
  descEditRow:   { gap: 8 },
  descInput:     { color: c.text, backgroundColor: c.glassSoft, borderRadius: 12, padding: 12, fontSize: 15, minHeight: 70, textAlignVertical: 'top' },
  memberSearch:  { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  memberSearchInput: { flex: 1, color: c.text, fontSize: 14, padding: 0 },
  memberItem:    { paddingHorizontal: 16 },
  memberRow:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  memberAvatarWrap: { width: 44, height: 44 },
  memberAvatar:  { width: 44, height: 44, borderRadius: 22, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  memberAvatarImg: { width: '100%', height: '100%' },
  memberAvatarTxt: { color: c.onPrimary, fontWeight: '700', fontSize: 17 },
  memberPresenceDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: c.online, borderWidth: 2, borderColor: c.bg },
  memberName:    { color: c.text, fontSize: 15, fontWeight: '600' },
  memberMeTag:   { color: c.textDim, fontSize: 12, fontWeight: '400' },
  memberSub:     { color: c.textDim, fontSize: 12, marginTop: 2 },
  removeBtn:     { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: c.danger },
  removeBtnTxt:  { color: c.danger, fontSize: 11, fontWeight: '700' },

  leaveBtn:      { marginHorizontal: 16, marginTop: 32, padding: 14, borderRadius: 24, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  leaveTxt:      { color: c.danger, fontWeight: '700' },
});
