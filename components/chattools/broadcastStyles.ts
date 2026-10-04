// components/chattools/broadcastStyles.ts — styles shared by app/broadcast.tsx
// (channel list) and BroadcastChannelView (one channel's posts).

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { HEADER_TOP } from '../../constants/layout';
import { brandAlpha, type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

export function useBroadcastStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeBroadcastStyles(colors), [colors]);
}

export const makeBroadcastStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12, gap: 12 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  shareBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  leaveLink: { color: c.danger, fontSize: 14, fontWeight: '700' },
  postErrBox: { alignItems: 'center', padding: 32 },
  staleTxt: { color: c.textDim, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  retryBtn: { marginTop: 16, minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800', flex: 1 },
  shareLink: { color: c.accent, fontSize: 14, fontWeight: '700' },
  topBtns: { flexDirection: 'row', gap: 8, padding: 12 },
  createBtn: { flex: 1, flexDirection: 'row', backgroundColor: c.glassSoft, borderRadius: 12, paddingVertical: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.glassStroke },
  joinBtn: { backgroundColor: brandAlpha(0.13), borderColor: brandAlpha(0.3) },
  createTxt: { color: c.accent, fontSize: 13, fontWeight: '700' },
  chRow: { flexDirection: 'row', alignItems: 'center', padding: 14, marginHorizontal: 12, marginBottom: 6, backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: 1, borderColor: c.glassStroke },
  chAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  chName: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1, marginRight: 8 },
  chSubs: { color: c.textDim, fontSize: 11 },
  chLast: { color: c.textDim, fontSize: 12, marginTop: 2 },
  adminBadge: { backgroundColor: brandAlpha(0.15), borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 8 },
  adminTxt: { color: c.accent, fontSize: 10, fontWeight: '800' },
  channelInfo: { padding: 12, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.hairline },
  channelMeta: { color: c.textDim, fontSize: 12 },
  channelDesc: { color: c.textDim, fontSize: 12, marginTop: 4 },
  postCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  postAuthor: { color: c.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  postText: { color: c.text, fontSize: 15, lineHeight: 22 },
  postTime: { color: c.textFaint, fontSize: 10, marginTop: 6, textAlign: 'right' },
  postBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.hairline },
  postInput: { flex: 1, backgroundColor: c.glassSoft, color: c.text, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, maxHeight: 100, marginRight: 8, borderWidth: 1, borderColor: c.glassStroke },
  postBtn: { backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  postBtnOff: { opacity: 0.4 },
  postBtnTxt: { color: c.onPrimary, fontWeight: '900' },
  readOnly: { padding: 14, alignItems: 'center', backgroundColor: c.glassSoft, borderTopWidth: 1, borderTopColor: c.hairline },
  readOnlyTxt: { color: c.textDim, fontSize: 13 },
  emptyBox: { alignItems: 'center', padding: 40 },
  emptyTxt: { color: c.textDim, fontSize: 14 },
  emptySub: { color: c.textFaint, fontSize: 12, marginTop: 8 },
  // Fixed scrim: dims whatever is behind the sheet the same way in both themes (no scrim token exists).
  modalBg: { flex: 1, backgroundColor: c.scrim, justifyContent: 'flex-end' },
  modal: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, borderTopWidth: 1, borderColor: c.glassStroke },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '900', marginBottom: 16 },
  modalInput: { backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: c.text, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: c.glassStroke },
  modalBtn: { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  modalBtnOff: { opacity: 0.5 },
  modalInputTall: { height: 80, textAlignVertical: 'top' },
  modalBtnTxt: { color: c.onPrimary, fontWeight: '800' },
  modalCancelBtn: { minHeight: 44, justifyContent: 'center', marginTop: 4 },
  modalCancel: { color: c.textDim, textAlign: 'center' },
});
