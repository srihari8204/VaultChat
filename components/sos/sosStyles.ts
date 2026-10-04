// components/sos/sosStyles.ts — styles shared by app/emergency-sos.tsx and its
// sections (components/sos/SosContacts.tsx, SosHistory.tsx).

import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { brandAlpha, type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { tint } from '../../lib/tintColor';
import { SOS_BUTTON } from '../../constants/sosPalette';

export function useSosStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const SOS_SIZE = 160;
const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: brandAlpha(0.08), justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16 },

  // SOS Button
  sosSection: { alignItems: 'center', marginVertical: 30 },
  sosHint: { color: c.textDim, fontSize: 14, marginBottom: 20, textAlign: 'center' },
  sosButton: { width: SOS_SIZE, height: SOS_SIZE, borderRadius: SOS_SIZE / 2, overflow: 'hidden', elevation: 10, shadowColor: c.danger, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 20 },
  sosGradient: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: SOS_SIZE / 2, borderWidth: 4, borderColor: tint(c.danger, 0.5) },
  // Fixed ink on the fixed SOS gradient (constants/sosPalette.ts), not onDanger.
  sosText: { color: SOS_BUTTON.ink, fontSize: 48, fontWeight: '900', letterSpacing: 6 },
  testBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 10, minHeight: 44, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: tint(c.warning, 0.3), backgroundColor: tint(c.warning, 0.08) },
  testBtnText: { color: c.warning, fontSize: 14, fontWeight: '600' },

  // Countdown
  countdownContainer: { alignItems: 'center' },
  countdownLabel: { color: c.danger, fontSize: 18, fontWeight: '600', marginBottom: 10 },
  countdownNumber: { color: c.text, fontSize: 72, fontWeight: '900' },
  countdownTo: { color: c.textDim, fontSize: 14, marginTop: 4, textAlign: 'center' },
  cancelBtn: { marginTop: 20, backgroundColor: tint(c.danger, 0.15), paddingHorizontal: 40, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger },
  cancelBtnText: { color: c.danger, fontSize: 18, fontWeight: '800', letterSpacing: 2 },

  // Sending/Sent
  sendingContainer: { alignItems: 'center', marginVertical: 30 },
  sendingText: { color: c.danger, fontSize: 16, fontWeight: '600', marginTop: 12 },
  sentContainer: { alignItems: 'center', marginVertical: 20 },
  sentCheck: { fontSize: 48, color: c.primary },
  sentText: { color: c.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  sentSub: { color: c.textDim, fontSize: 14, marginTop: 4 },
  // Wraps and grows: this line is longer than the others and must stay
  // readable at any width or OS font scale.
  sentWarn: { color: c.warning, fontSize: 13, marginTop: 8, textAlign: 'center', paddingHorizontal: 20 },
  resetBtn: { marginTop: 20, backgroundColor: c.accent, paddingHorizontal: 40, paddingVertical: 10, minHeight: 44, justifyContent: 'center', borderRadius: 8 },
  resetBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },

  // Shake
  shakeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.hairline },
  shakeTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  shakeSub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 8, minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: c.border },
  toggleBtnActive: { borderColor: c.primary, backgroundColor: brandAlpha(0.15) },
  toggleText: { color: c.textDim, fontSize: 13, fontWeight: '700' },
  toggleTextActive: { color: c.primary },

  // Contacts
  section: { marginTop: 20 },
  sectionTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  editLink: { color: c.accentOn, fontSize: 14, fontWeight: '600' },
  contactRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.hairline },
  contactSelected: { borderColor: tint(c.accent, 0.3), backgroundColor: tint(c.accent, 0.04) },
  contactCheck: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: c.border, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactCheckActive: { borderColor: c.accent, backgroundColor: tint(c.accent, 0.2) },
  contactInfo: { flex: 1 },
  contactName: { color: c.text, fontSize: 15, fontWeight: '600' },
  contactId: { color: c.textDim, fontSize: 12, marginTop: 2 },
  emptyCard: { alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 24, borderWidth: 1, borderColor: c.hairline },
  emptyText: { color: c.textDim, fontSize: 14, marginBottom: 14, textAlign: 'center' },
  refreshWarn: { color: c.textDim, fontSize: 12, marginBottom: 8 },
  setupBtn: { backgroundColor: c.accent, paddingHorizontal: 20, paddingVertical: 10, minHeight: 44, justifyContent: 'center', borderRadius: 8 },
  setupBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '700' },

  // History
  noHistory: { color: c.textDim, fontSize: 13, textAlign: 'center', marginTop: 8 },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.hairline },
  historyDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  historyInfo: { flex: 1 },
  historyType: { color: c.text, fontSize: 14, fontWeight: '600' },
  historyTime: { color: c.textDim, fontSize: 12, marginTop: 2 },
  historyContacts: { color: c.textDim, fontSize: 12 },
});
