// components/chats/chatListStyles.ts — the Chats tab's styles, shared by the
// screen (app/(tabs)/chats.tsx) and the pieces split out of it (ChatListRow,
// AvatarPopup). Moved out of the screen unchanged except where noted.
//
// Every font size is multiplied by the vision-comfort scale here (`v`), which
// is why these screens use RN Text rather than AppText (that would scale twice).

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import { type Palette, brandAlpha } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { tint } from '../../lib/tintColor';

export function useChatListStyles() {
  const { colors } = useTheme();
  const { metrics, profile } = useVisionComfort();
  return useMemo(() => makeChatListStyles(colors, metrics, profile.highContrast), [colors, metrics, profile.highContrast]);
}

export const makeChatListStyles = (c: Palette, v = { textScale: 1, lineScale: 1, spacingScale: 1, controlScale: 1, bold: false }, highContrast = false) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: HEADER_TOP, paddingBottom: 14 },
  title: { color: c.text, fontSize: 28 * v.textScale, fontWeight: '800', flexShrink: 1 },
  // 40dp to keep six of them on one line; each carries hitSlop up to 44+.
  headerBtn: { minWidth: 40 * v.controlScale, minHeight: 40 * v.controlScale, borderRadius: 20, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  // Avatar photo popup. The scrim and the name bar over the photo are dark in
  // both themes on purpose: they sit over an arbitrary photo, under white text.
  avBackdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  avCard:       { width: '100%', maxWidth: 360, borderRadius: 16, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  avImgWrap:    { width: '100%', aspectRatio: 1, backgroundColor: c.primary },
  avImg:        { width: '100%', height: '100%' },
  avInitials:   { alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  avInitialsTxt:{ color: c.onPrimary, fontSize: 84, fontWeight: '800' },
  avNameBar:    { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
  avNameTxt:    { color: '#fff', fontSize: 19 * v.textScale, fontWeight: '700' },
  avActions:    { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: c.surfaceSolid },
  avActionBtn:  { alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 6, minWidth: 44, minHeight: 44 },
  avActionTxt:  { color: c.primary, fontSize: 12 * v.textScale, fontWeight: '600' },
  inviteBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 11,
    backgroundColor: brandAlpha(0.10),
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke,
  },
  inviteBannerTxt: { flex: 1, color: c.text, fontSize: 14 * v.textScale, fontWeight: '600' },
  inviteBannerCta: { color: c.primary, fontSize: 13 * v.textScale, fontWeight: '800' },
  errorBar: { backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, marginHorizontal: 16, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 * v.textScale },

  emptyTitle: { color: c.text, fontSize: 18 * v.textScale, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub: { color: c.textDim, fontSize: 14 * v.textScale, textAlign: 'center', lineHeight: Math.ceil(20 * v.textScale * v.lineScale), marginBottom: 24 },
  emptyBtn: { backgroundColor: c.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  emptyBtnTxt: { color: c.onPrimary, fontWeight: '800', fontSize: 14 * v.textScale },

  folderScroll: { flexGrow: 0 },
  folderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 8, gap: 8 },

  sectionHeader: { color: highContrast ? c.text : c.textFaint, fontSize: 11 * v.textScale, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 22, paddingTop: 14, paddingBottom: 6, backgroundColor: 'transparent' },
  // Inset = paddingLeft 12 + avatar 50 + gap 12, so the rule starts under the
  // text exactly like spec §6.4's 79. Was 88, left over from the 22pt padding.
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.hairline, marginLeft: 74 },

  // Aurora Glass: rows are undecorated on purpose. No fill, no border, no
  // shadow — the ground and the avatar ring carry the design, so the list stays
  // legible at a glance and costs nothing to scroll.
  // Geometry from Figma `ChatRow` (node 5:2) = WhatsApp spec §6.4: a FIXED
  // 72pt row, 12 padding, 12 gap. Was 76/22/14 — drift, not a decision.
  // minHeight, NOT height. The design says 72 and lib/responsiveLayout's
  // guard says never pin a row that holds text: at 130% OS font scale a
  // fixed 72 clips the name and the preview, which spec §10 forbids and
  // which this repo already has a failing test for. 72 is the resting
  // height — the rhythm the design wants — and the row grows only for a
  // reader who needs it.
  row: { flexDirection: 'row', minHeight: 72, paddingHorizontal: 12, paddingVertical: 8 * v.spacingScale, alignItems: 'center', gap: 12, backgroundColor: 'transparent' },
  rowSelected: { backgroundColor: brandAlpha(0.14) },
  avatarWrap: { width: 50, height: 50 },
  // Over the avatar while the first tap looks up who has a story.
  avatarBusy: { ...StyleSheet.absoluteFillObject, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: tint(c.bg, 0.55) },
  selBadge: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.bg },
  selBadgeOn: { backgroundColor: c.primary },
  selBadgeOff: { backgroundColor: c.surfaceSolid, borderColor: c.textDim },

  rowBody: { flex: 1, minWidth: 0, gap: 3 * v.spacingScale },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: c.text, fontSize: 17 * v.textScale, lineHeight: Math.ceil(22 * v.textScale * v.lineScale), fontWeight: v.bold ? '700' : '600', flex: 1, minWidth: 0 },
  // flexShrink: 0 — the name is the flexible child and the only thing that may
  // truncate. marginLeft:'auto' is gone: it dates from when the name took its
  // natural width, and with the name at flex:1 there is no free space left for
  // an auto margin to absorb.
  rowTime: { color: highContrast ? c.text : c.textFaint, fontSize: 12.5 * v.textScale, lineHeight: Math.ceil(16 * v.textScale * v.lineScale), flexShrink: 0 },
  // One box for the timer/mute/pin glyphs, tightly spaced among themselves, so
  // rowTop's gap is paid twice instead of four times.
  rowFlags: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowPreview: { color: highContrast ? c.text : c.textDim, fontSize: 14 * v.textScale, lineHeight: Math.ceil(19 * v.textScale * v.lineScale), flex: 1, minWidth: 0 },
  rowPreviewUnread: { color: c.text, fontWeight: '600' },
  // Temporary-chat sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32, paddingTop: 10 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 8 },
  sheetTitle: { color: c.textDim, fontSize: 13 * v.textScale, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 10 },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 6, marginHorizontal: 20 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15, minHeight: 44 },
  sheetItemTxt: { color: c.text, fontSize: 16 * v.textScale, fontWeight: '500' },
  draftLabel: { color: c.danger, fontWeight: '700' },
  unreadBadge: { backgroundColor: c.primary, borderRadius: 11, minWidth: 22 * v.controlScale, minHeight: 22 * v.controlScale, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  unreadTxt: { color: c.onPrimary, fontSize: 11 * v.textScale, lineHeight: Math.ceil(14 * v.textScale * v.lineScale), fontWeight: '600' },

  actionsRow: { flexDirection: 'row' },
  action: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 4 },
  // Pin and Mute sit on primary / purple fills; Delete overrides with onDanger.
  actionLbl: { color: c.onPrimary, fontSize: 11 * v.textScale, fontWeight: '700' },

  fab: { position: 'absolute', right: 22, bottom: TAB_BAR_SPACE + 18, width: 60 * v.controlScale, height: 60 * v.controlScale, borderRadius: 30 * v.controlScale, backgroundColor: c.accentDeep, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, elevation: 8, shadowColor: c.accentDeep, shadowOpacity: 0.55, shadowOffset: { width: 0, height: 10 }, shadowRadius: 24 },
});

export type ChatListStyles = ReturnType<typeof makeChatListStyles>;
