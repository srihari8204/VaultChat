// components/notes/notesStyles.ts — styles for app/encrypted-notes.tsx and its
// pieces in components/notes (moved out of the screen file in the round-4 split).

import { useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { type Palette } from '../../constants/theme';
import { HEADER_TOP } from '../../constants/layout';
import { useTheme } from '../../lib/theme';

// Markdown render theme — maps react-native-markdown-display element keys to the
// active palette so previews look right in both light and dark.
export const mdStyles = (c: Palette) => ({
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  heading1: { color: c.text, fontSize: 22, fontWeight: '800' as const, marginTop: 8, marginBottom: 4 },
  heading2: { color: c.text, fontSize: 19, fontWeight: '800' as const, marginTop: 8, marginBottom: 4 },
  heading3: { color: c.text, fontSize: 16, fontWeight: '700' as const, marginTop: 6, marginBottom: 4 },
  strong: { fontWeight: '800' as const, color: c.text },
  em: { fontStyle: 'italic' as const },
  link: { color: c.primary, textDecorationLine: 'underline' as const },
  blockquote: { backgroundColor: c.glassSoft, borderLeftColor: c.primary, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 6, marginVertical: 4 },
  code_inline: { backgroundColor: c.glassSoft, color: c.accent, paddingHorizontal: 5, borderRadius: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  code_block: { backgroundColor: c.glassSoft, color: c.text, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fence: { backgroundColor: c.glassSoft, color: c.text, padding: 10, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  hr: { backgroundColor: c.border, height: 1 },
});

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: HEADER_TOP, paddingBottom: 14, paddingHorizontal: 16, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },
  textBtn: { minHeight: 44, minWidth: 44, justifyContent: 'center', marginTop: 8 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 10, color: c.textDim, marginTop: 1 },
  trashBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },

  loadFail: { marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.danger, backgroundColor: c.glassSoft },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: 12, backgroundColor: c.glassSoft, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.glassStroke },
  searchIcon: { fontSize: 16 },
  searchInput: { flex: 1, color: c.text, fontSize: 14 },

  catRow: { paddingHorizontal: 12, gap: 8, paddingBottom: 8 },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.glassStroke },
  catChipActive: { backgroundColor: c.purple + '20', borderColor: c.purple },
  catIcon: { fontSize: 14 },
  catTxt: { fontSize: 12, color: c.textDim, fontWeight: '500' },
  catTxtActive: { color: c.purple },
  catCount: { fontSize: 10, fontWeight: '700' },

  notesList: { padding: 12, paddingBottom: 100 },
  noteCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.glassStroke },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  noteIcon: { fontSize: 18 },
  noteTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text },
  notePreview: { fontSize: 13, color: c.textDim, lineHeight: 18, marginBottom: 8 },
  noteFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noteDate: { fontSize: 11, color: c.textDim },
  tagRow: { flexDirection: 'row', gap: 4 },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  tagTxt: { fontSize: 10, fontWeight: '600' },
  tagChip: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10 },

  sensToggle: { position: 'absolute', bottom: 90, left: 16, minHeight: 44, justifyContent: 'center', backgroundColor: c.glassSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.glassStroke },
  sensToggleTxt: { color: c.textDim, fontSize: 12, fontWeight: '600' },

  fab: { position: 'absolute', bottom: 24, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: c.purple, alignItems: 'center', justifyContent: 'center', elevation: 6 },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTxt: { fontSize: 16, fontWeight: '600', color: c.text },
  emptySub: { fontSize: 13, color: c.textDim, marginTop: 4 },

  // Editor
  editorScreen: { flex: 1, backgroundColor: c.bg },
  editorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 16, backgroundColor: c.glassSoft, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  editorCancel: { color: c.textDim, fontSize: 14 },
  editorTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  editorSave: { color: c.purple, fontSize: 14, fontWeight: '700' },
  editorBody: { flex: 1, padding: 16 },
  editorTitleInput: { color: c.text, fontSize: 22, fontWeight: '700', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: c.glassStroke, paddingBottom: 8 },
  editorContent: { color: c.text, fontSize: 15, lineHeight: 22, minHeight: 150, backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: c.glassStroke },

  edCatChip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  edCatTxt: { fontSize: 11, color: c.textDim },

  edSection: { marginTop: 16 },
  edLabel: { color: c.purple, fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  attachBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: c.glassStroke, minWidth: 72, alignItems: 'center' },
  attachBtnTxt: { color: c.primary, fontSize: 13, fontWeight: '700' },
  attachHint: { color: c.textDim, fontSize: 11, marginBottom: 8 },
  bkBody: { color: c.textDim, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  bkBtn: { backgroundColor: c.primary, borderRadius: 10, minHeight: 44, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  bkBtnTxt: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.glassSoft, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6 },
  attachName: { color: c.text, fontSize: 14, fontWeight: '600' },
  attachMeta: { color: c.textDim, fontSize: 11, marginTop: 2 },
  mdBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 8 },
  mdBtn: { minHeight: 40, minWidth: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  mdBtnTxt: { color: c.text, fontSize: 13, fontWeight: '700' },
  mdPreview: { minHeight: 180, paddingVertical: 8 },
  imgViewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  imgViewerImg: { width: '100%', height: '80%' },
  imgViewerClose: { position: 'absolute', bottom: 50, paddingHorizontal: 28, paddingVertical: 12, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 24 },
  colorDot: { width: 28, height: 28, borderRadius: 14 },
  colorDotActive: { borderWidth: 3, borderColor: c.glassStroke },
  tagInput: { backgroundColor: c.glassSoft, borderRadius: 10, padding: 10, color: c.text, fontSize: 13, marginTop: 8, borderWidth: 1, borderColor: c.glassStroke },

  edToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  edToggleTxt: { color: c.text, fontSize: 14, fontWeight: '500' },

  copyBtn: { backgroundColor: c.primary + '20', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 16, borderWidth: 1, borderColor: c.primary + '40' },
  copyBtnTxt: { color: c.primary, fontSize: 14, fontWeight: '600' },

  // Password generator
  // Modal scrim: a translucent black dims whatever is behind in either theme.
  passModal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.67)', justifyContent: 'center', padding: 24 },
  passCard: { backgroundColor: c.glassSoft, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: c.glassStroke },
  passTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 16, textAlign: 'center' },
  passDisplay: { backgroundColor: c.bg, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke },
  passText: { color: c.primary, fontSize: 16, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', textAlign: 'center' },
  passActions: { flexDirection: 'row', gap: 10 },
  passBtn: { flex: 1, backgroundColor: c.purple, borderRadius: 12, minHeight: 44, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  passBtnTxt: { color: c.bubbleOutText, fontSize: 14, fontWeight: '600' },  // white-on-accent ink

  // Trash
  trashCard: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: c.danger + '30' },
  trashTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  trashDate: { color: c.textDim, fontSize: 12, marginTop: 2 },
  trashRestore: { backgroundColor: c.primary + '15', borderRadius: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 6 },
  trashDelete: { backgroundColor: c.danger + '15', borderRadius: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 6 },
});

export type NotesStyles = ReturnType<typeof makeStyles>;

export function useNotesStyles(): NotesStyles {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}
