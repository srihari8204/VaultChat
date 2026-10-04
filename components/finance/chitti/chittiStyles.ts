// components/finance/chitti/chittiStyles.ts — styles and dues metadata shared
// by the Lucky Draw group screen (app/finance/chitti/[id].tsx) and its tabs.
// Moved out of that screen unchanged when the tabs were split into files.

import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TABULAR, FIN_SHADOW, type FinancePalette, HERO_INK } from '../../../constants/financeTheme';
import type { ChittiCollection, CollectionStatus } from '../../../db/chitti';

/** Tapping a dues row moves it along this cycle. */
export const CYCLE: CollectionStatus[] = ['pending', 'paid', 'overdue'];

export const getCollectionMeta = (FIN: FinancePalette): Record<CollectionStatus, { fg: string; bg: string; label: string; icon: keyof typeof Ionicons.glyphMap }> => ({
  paid:    { fg: FIN.good, bg: FIN.goodSoft, label: 'Paid',    icon: 'checkmark-circle' },
  pending: { fg: FIN.warn, bg: FIN.warnSoft, label: 'Pending', icon: 'ellipse-outline' },
  overdue: { fg: FIN.bad,  bg: FIN.badSoft,  label: 'Overdue', icon: 'alert-circle' },
});

/** A member's dues status for a month; no row yet means pending. */
export function collectionStatus(collections: ChittiCollection[], memberId: string, month: number): CollectionStatus {
  return collections.find(c => c.member_id === memberId && c.month === month)?.status ?? 'pending';
}

export const makeChittiStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  // Hero ink: the FIN_HERO gradient is dark in both schemes (HERO_INK, constants/financeTheme).
  heroLabel: { color: HERO_INK.label, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: HERO_INK.strong, fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: HERO_INK.rule },
  heroFootTxt: { color: HERO_INK.soft, fontSize: 12, fontWeight: '600' },
  tileRow: { marginTop: 12 },

  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, backgroundColor: FIN.card, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  addRowTxt: { color: FIN.brandDeep, fontSize: 14.5, fontWeight: '700' },
  addBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: FIN.brandDeep, alignItems: 'center', justifyContent: 'center' },

  memRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  memNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  memNumTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  memName: { color: FIN.text, fontSize: 15, fontWeight: '600' },
  memSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },

  monthRow: { gap: 8, paddingVertical: 14 },
  monthChip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card },
  monthChipOn: { backgroundColor: FIN.brandDeep, borderColor: FIN.brandDeep },
  monthTxt: { color: FIN.sub, fontSize: 13, fontWeight: '700' },

  colPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  colTxt: { fontSize: 11.5, fontWeight: '800' },

  empty: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  hint: { color: FIN.faint, fontSize: 11.5, textAlign: 'center', marginTop: 10 },

  auctionForm: { backgroundColor: FIN.card, borderRadius: 14, padding: 14, marginTop: 14, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  formLabel: { color: FIN.text, fontSize: 13, fontWeight: '700', marginBottom: 6, marginTop: 4 },
  winnerWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  winnerChip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card2 },
  winnerChipOn: { backgroundColor: FIN.brandDeep, borderColor: FIN.brandDeep },
  winnerTxt: { color: FIN.sub, fontSize: 12.5, fontWeight: '700' },
  dividendHint: { color: FIN.brandDeep, fontSize: 12.5, fontWeight: '700', marginTop: 10 },
  dividendNote: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },

  auctionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  aMonth: { width: 34, height: 34, borderRadius: 10, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  aMonthTxt: { color: FIN.brandDeep, fontSize: 12, fontWeight: '800' },
  aWinner: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  aSub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  aDiv: { color: FIN.good, fontSize: 12, fontWeight: '700', marginTop: 2 },

  histRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginTop: 10, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  histDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: FIN.brand, marginTop: 5 },
  histTxt: { color: FIN.text, fontSize: 13.5, fontWeight: '600' },
  histAt: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },
});
