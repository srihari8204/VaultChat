// components/vault/vaultStyles.ts — styles for app/vault.tsx and its parts
// (moved out of the screen unchanged).

import { StyleSheet } from 'react-native';
import type { Palette } from '../../constants/theme';
import { HEADER_TOP } from '../../constants/layout';


export const makePinStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1, backgroundColor: c.glassSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  lockIcon:  { marginBottom: 12 },
  title:     { fontSize: 26, fontWeight: 'bold', color: c.text, marginBottom: 4 },
  sub:       { fontSize: 13, color: c.textDim, marginBottom: 24 },
  error:     { color: c.danger, fontSize: 13, marginTop: 12, textAlign: 'center', paddingHorizontal: 24 },
  note:      { marginTop: 28, color: c.textDim, fontSize: 11 },
  setBtn:    { marginTop: 8, minHeight: 48, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  setBtnText:{ color: c.onPrimary, fontWeight: 'bold', fontSize: 15 },
});

export const makeStyles = (c: Palette) => StyleSheet.create({
  container:    { flex: 1, backgroundColor: c.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
    gap: 12,
  },
  backBtn:      { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 18, fontWeight: 'bold', color: c.text },
  headerSub:    { fontSize: 12, color: c.primary, marginTop: 1 },
  backupBtn: {
    width: 44, height: 44, backgroundColor: c.glassSoft,
    borderRadius: 9, borderWidth: 0.5, borderColor: c.glassStroke,
    justifyContent: 'center', alignItems: 'center',
  },

  // Stats
  statsBar: {
    flexDirection: 'row', backgroundColor: c.bg,
    paddingVertical: 12, paddingHorizontal: 20,
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  statItem:    { flex: 1, alignItems: 'center' },
  statNum:     { fontSize: 15, fontWeight: 'bold', color: c.text },
  statLabel:   { fontSize: 12, color: c.textDim, marginTop: 2 },
  statDivider: { width: 0.5, backgroundColor: c.surfaceSolid, marginVertical: 4 },

  keyNotice: { color: c.danger, fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingVertical: 8 },
  unlistedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  unlistedText: { color: c.text, fontSize: 12, lineHeight: 17 },
  unlistedBtn: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, justifyContent: 'center' },
  unlistedBtnText: { color: c.primary, fontWeight: '700', fontSize: 13 },
  cancelOpBtn: { minHeight: 44, paddingHorizontal: 24, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, justifyContent: 'center' },
  cancelOpText: { color: c.text, fontWeight: 'bold', fontSize: 14 },

  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5, borderBottomColor: c.glassStroke,
  },
  tab: {
    flex: 1, alignItems: 'center', paddingVertical: 10, gap: 3,
  },
  tabActive: {
    borderBottomWidth: 2, borderBottomColor: c.primary,
  },
  tabText:       { fontSize: 12, color: c.textDim },
  tabTextActive: { color: c.primary, fontWeight: 'bold' },
  tabCount: {
    borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: c.glass,
  },
  tabCountText:  { fontSize: 12, fontWeight: 'bold', color: c.primary },

  // Loading
  loadingWrap: {
    flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12,
  },
  loadingText: { fontSize: 13, color: c.textDim },

  // List
  listContent: { padding: 14, paddingBottom: 100, flexGrow: 1 },

  // Empty
  emptyWrap: {
    flex: 1, alignItems: 'center', paddingTop: 64, gap: 10,
  },
  emptyTitle: { fontSize: 16, fontWeight: 'bold', color: c.textDim },
  emptyHint:  { fontSize: 12, color: c.textDim, textAlign: 'center' },

  // File row
  fileRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.bg,
    borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 0.5, borderColor: c.glassStroke,
  },
  fileIcon: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: c.glassSoft,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  fileInfo:      { flex: 1 },
  fileName:      { fontSize: 14, fontWeight: 'bold', color: c.text, marginBottom: 3 },
  fileMeta:      { fontSize: 12, color: c.textDim },
  fileActions:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: c.glassSoft, borderRadius: 6,
    borderWidth: 0.5, borderColor: c.primary,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  encBadgeText:  { fontSize: 12, color: c.primary, fontWeight: 'bold' },
  deleteBtn:     { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  // FAB
  fab: {
    position: 'absolute', right: 18, bottom: 74,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: c.primary,
    justifyContent: 'center', alignItems: 'center',
    elevation: 6,
  },
  fabDisabled: { opacity: 0.4 },
  retryBtn: { minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  retryText: { color: c.onPrimary, fontWeight: 'bold', fontSize: 15 },

  // Backup modal
  // Modal scrim: a translucent black dims whatever is behind in either theme.
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.53)', justifyContent: 'flex-end',
  },
  backupPanel: {
    backgroundColor: c.bg,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  backupHandle: {
    width: 40, height: 4, backgroundColor: c.surfaceSolid,
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  backupTitle: {
    fontSize: 17, fontWeight: 'bold', color: c.text,
    textAlign: 'center', marginBottom: 8,
  },
  backupDesc: {
    fontSize: 13, color: c.textDim, lineHeight: 20,
    textAlign: 'center', marginBottom: 20,
  },
  backupBtnRow:  { flexDirection: 'row', gap: 10, marginBottom: 12 },
  backupCancelBtn: {
    flex: 1, backgroundColor: c.surfaceSolid,
    borderRadius: 10, borderWidth: 0.5, borderColor: c.glassStroke,
    paddingVertical: 13, alignItems: 'center',
  },
  backupCancelText:  { color: c.textDim, fontWeight: 'bold' },
  backupConfirmBtn: {
    flex: 1, backgroundColor: c.primary,
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  backupConfirmText: { color: c.onPrimary, fontWeight: 'bold', fontSize: 15 },
  backupLastText:    { fontSize: 12, color: c.textDim, textAlign: 'center' },
  backupNote:        { fontSize: 12, color: c.text, textAlign: 'center', marginTop: 6 },
});

// components/vault/VaultKeyPanel.tsx
export const makeKeyPanelStyles = (c: Palette) => StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  notice: { color: c.danger, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btn: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft, justifyContent: 'center' },
  btnText: { color: c.primary, fontWeight: '700', fontSize: 13 },
  // Modal scrim: a translucent black dims whatever is behind in either theme.
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.53)', justifyContent: 'flex-end' },
  panel: { backgroundColor: c.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, alignItems: 'center' },
  title: { fontSize: 17, fontWeight: 'bold', color: c.text, marginBottom: 6 },
  sub: { fontSize: 13, color: c.textDim, lineHeight: 19, textAlign: 'center', marginBottom: 16 },
  error: { color: c.danger, fontSize: 13, marginTop: 10, textAlign: 'center' },
  cancel: { marginTop: 12, minHeight: 44, paddingHorizontal: 24, justifyContent: 'center' },
  cancelText: { color: c.textDim, fontWeight: 'bold' },
});
