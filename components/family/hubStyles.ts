// components/family/hubStyles.ts — the Family hub's shared geometry, moved out
// of app/family.tsx with the pieces that use it (HubTop, HubMemberRow,
// HubQuickActions, HubSpaceCards, HubDistancePanel, HubManageSheet). Colours
// are applied at each call site from the theme and SPACE_GLASS.

import { StyleSheet } from 'react-native';
import { SPACE_SHADOW } from '../../constants/spaceTheme';

// Spacing rides the 4/8/12/16 grid; radii step 18 → 20 → 24 → 28 with
// importance (tiles → cards → map/sheets → modals); glass panes carry
// SPACE_SHADOW so they float instead of reading as outlined boxes.
export const st = StyleSheet.create({
  screen: { flex: 1 },
  // Loading placeholders — glass shapes, no shimmer (see the loading gate).
  skel: { borderWidth: 1 },
  dash: { padding: 16 },
  greetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderWidth: 1, borderRadius: 22, marginBottom: 12, ...SPACE_SHADOW.raised },
  statusIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  // minWidth, not width: the "+N" overflow chip grows into a pill for double
  // digits instead of clipping; single initials stay a 26dp circle.
  miniDot: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  miniDotTxt: { fontWeight: '800', fontSize: 11 },
  mapCard: { height: 300, borderRadius: 24, borderWidth: 1, overflow: 'hidden', marginBottom: 12, ...SPACE_SHADOW.raised },
  mapBadge: { position: 'absolute', top: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, ...SPACE_SHADOW.rest },
  collapse: { position: 'absolute', top: 12, right: 12, width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center', ...SPACE_SHADOW.rest },
  // ── design screen 5: greeting + quick-action cards ──
  greetBell: {
    width: 42, height: 42, borderRadius: 21, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', ...SPACE_SHADOW.rest,
  },
  bellDot: {
    position: 'absolute', top: 8, right: 9, width: 9, height: 9,
    borderRadius: 5, borderWidth: 1.5,
  },
  qaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  // Three across on a normal phone; wraps to two on narrow screens rather than
  // squeezing the subtitle out of existence. (minWidth tracks the 16px screen
  // margin — at 104 the wider gutters pushed 360dp phones down to two-up.)
  qa: {
    flexBasis: '30%', flexGrow: 1, minWidth: 100,
    borderWidth: 1, borderRadius: 18, padding: 12, gap: 8, ...SPACE_SHADOW.rest,
  },
  qaIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  qaTitle: { fontSize: 13.5, fontWeight: '700' },
  qaSub: { fontSize: 11 },
  badge: { position: 'absolute', top: 6, right: 10, minWidth: 18, height: 18, borderRadius: 9, borderWidth: 1.5, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeTxt: { fontSize: 10, fontWeight: '800' },
  announce: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: 1, borderRadius: 18, marginBottom: 12, ...SPACE_SHADOW.rest },
  sosBig: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderWidth: 1.5, borderRadius: 20, overflow: 'hidden', marginBottom: 12, ...SPACE_SHADOW.rest },
  sosIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  // The share toggle's own pane on the dashboard.
  shareCard: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 2, marginBottom: 12, ...SPACE_SHADOW.rest },
  shareRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  shareNote: { fontSize: 12, lineHeight: 17, marginTop: -4, marginBottom: 10 },
  // marginTop 4: every card above a section head now carries marginBottom 12,
  // so the total 16 lands on the grid without double-counting.
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 8 },
  secTitle: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 },
  // One vertical rhythm: every card in the scroll column sits 12 under its
  // neighbour — the audit found 4/10/12/14 all in play, the classic tell.
  card: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 12, ...SPACE_SHADOW.rest },
  // Tertiary info rows: faint glass, no float — they explain, they don't lead.
  quiet: { shadowOpacity: 0, elevation: 0 },
  distRow: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 10 },
  distCell: { flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  distVal: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  distLbl: { fontSize: 11, textAlign: 'center' },
  distDiv: { width: 1, height: 30 },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  // 30dp visual height reads as a chip, not a button; the 7dp vertical hitSlop
  // on every user of this style is what carries the target to the 44dp floor.
  sortChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 30, justifyContent: 'center' },
  sheet: { borderTopWidth: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 6, ...SPACE_SHADOW.raised },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dotTxt: { fontWeight: '800' },
  rowBtn: { padding: 6 },
  saveBtn: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  mRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  mTxt: { fontSize: 15, fontWeight: '600' },
});
