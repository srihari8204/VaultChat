// components/fileviewer/styles.ts — palette and styles shared by
// app/file-viewer.tsx and its panes (components/fileviewer/Panes.tsx).

import { Platform, StyleSheet } from 'react-native';
import { AuroraDark, AuroraLight, BRAND_GRADIENT_CTA, brandAlpha, type Palette } from '../../constants/theme';

// ── Design tokens ────────────────────────────────────────────────
// The viewer chrome is a dark media surface in BOTH app themes (a photo sits on
// black, a document is framed by dark bars), so it takes the DARK palette's
// tokens rather than the active theme's — the same rule as media-viewer's `M`.
// It used to be a private navy palette with its own hex values; the one hex
// left is the photo stage.
export const C = {
  bg: AuroraDark.bg,
  bgPure: '#000000',                 // the photo stage: black in every theme
  accent: AuroraDark.accentOn,       // accent as text/icon on the dark chrome (9.5:1)
  accentFill: AuroraDark.accentDeep, // accent as a solid fill under onFill text
  secondary: AuroraDark.purple,
  warning: AuroraDark.warning,
  text: AuroraDark.text,
  onFill: AuroraDark.onPrimary,      // text/icon on accentFill or the CTA gradient
  textDim: AuroraDark.textDim,
  textFaint: AuroraDark.textFaint,
  border: brandAlpha(0.15),
  glass: 'rgba(2,11,24,0.72)',
  glassBorder: 'rgba(255,255,255,0.08)',
};

/** Behind white labels: blue → violet passes AA at both ends (constants/theme). */
export const CTA_GRADIENT = BRAND_GRADIENT_CTA;

/**
 * The document reader's palette: INK ON PAPER.
 *
 * The rest of this screen is a dark media surface, and the tokens above are all
 * written for it. But a document gets a WHITE page (only image and video get
 * the black one), so every one of those tokens was near-white on near-white:
 * the document text was there, correctly parsed, and effectively invisible.
 *
 * Paper is the right surface for the content (it is what a document looks like,
 * and it is what reads well over pages of text) so the fix is dark ink, not a
 * dark page. The chrome above and below stays dark, which is exactly how every
 * document reader frames a page. Built from the LIGHT palette — a page is light
 * in both app themes — with the white card as the page.
 */
export const paperColors: Palette = {
  ...AuroraLight,
  bg: AuroraLight.card, surfaceSolid: AuroraLight.card, chatBg: AuroraLight.card,
  headerBar: AuroraLight.card, groundDisc: AuroraLight.card,
  // Grid rules on paper: the light palette's glass stroke is drawn for glass
  // over the blue ground and is too heavy between table cells.
  glassStroke: 'rgba(17,24,39,0.12)', glass: 'rgba(17,24,39,0.06)',
};

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export const s = StyleSheet.create({
  root: { flex: 1 },
  contentFill: { flex: 1, width: '100%', height: '100%' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },

  // ── Header ──────────────────────────────────────────────────
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    paddingBottom: 12, paddingHorizontal: 8,   // paddingTop: safe-area inset, set inline
    overflow: 'hidden',
  },
  headerInner: { flexDirection: 'row', alignItems: 'center' },
  headerBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerCenter: { flex: 1, marginHorizontal: 10 },
  headerFilenameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIcon: { fontSize: 16 },
  headerFilename: { color: C.text, fontSize: 15, fontWeight: '600', flex: 1 },
  headerSize: { color: C.textDim, fontSize: 12, marginTop: 2, marginLeft: 22 },

  // ── Content ─────────────────────────────────────────────────
  // paddingTop: inset + measured header height, set inline.
  content: { flex: 1, paddingBottom: 80 },

  // ── Image overlay ───────────────────────────────────────────
  imageOverlay: { position: 'absolute', bottom: 24, left: 0, right: 0, alignItems: 'center' },
  glassChip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: 'rgba(2,11,24,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  glassChipText: { color: C.text, fontSize: 13, fontWeight: '500' },

  // ── Loading ─────────────────────────────────────────────────
  loadingText: { color: C.textDim, fontSize: 14 },
  loadingPane: { flex: 1, gap: 16 },
  loadingCaption: { marginTop: 12 },
  // Document (pdf/office) hand-off card.
  fileIcon: { fontSize: 64, marginBottom: 12 },
  cardNote: { fontSize: 12, opacity: 0.7, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
  openBtn: {
    marginTop: 22, minWidth: 160, paddingVertical: 14, paddingHorizontal: 28,
    borderRadius: 14, backgroundColor: C.accentFill, alignItems: 'center', justifyContent: 'center',
  },
  openBtnTxt: { color: C.onFill, fontSize: 15, fontWeight: '700' },

  // ── Document action bar: read here, or hand off — both always available ──
  docActionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.glassBorder,
    backgroundColor: C.glass,
  },
  docActionHint: { color: C.textDim, fontSize: 12, flexShrink: 1 },
  docActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12,
    borderWidth: 1, borderColor: C.border,
  },
  docActionTxt: { color: C.accent, fontSize: 13, fontWeight: '700' },
  paperScroll: { padding: 18, paddingBottom: 24 },
  paperText: { color: paperColors.text, fontSize: 16, lineHeight: 25 },

  // ── Code / Text viewer ──────────────────────────────────────
  codeContainer: { padding: 16, paddingBottom: 40 },
  codeHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  codeLangBadge: { backgroundColor: brandAlpha(0.12), paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  codeLangText: { color: C.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  codeLineCount: { color: C.textDim, fontSize: 12 },
  footerNote: { marginVertical: 16, textAlign: 'center' },
  footerSpinner: { marginVertical: 16 },
  codeLine: { flexDirection: 'row', minHeight: 22 },
  lineNumber: {
    width: 40, textAlign: 'right', marginRight: 14,
    fontFamily: MONO, fontSize: 12, color: C.textFaint, lineHeight: 22,
  },
  lineText: { flex: 1, fontFamily: MONO, fontSize: 13, color: C.textDim, lineHeight: 22 },

  // ── Audio player ────────────────────────────────────────────
  audioPane: { flex: 1, paddingHorizontal: 24 },
  audioArtCircle: { width: 160, height: 160, borderRadius: 80, overflow: 'hidden', marginBottom: 28 },
  audioGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  audioTitle: { color: C.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  audioMeta: { color: C.textDim, fontSize: 13, marginTop: 6 },
  waveWrap: { marginTop: 32, width: '100%' },
  waveContainer: {
    // layout-exempt: draws fixed-width bars, no text — height is the drawing.
    flexDirection: 'row', alignItems: 'flex-end',
    height: 56, gap: 2, justifyContent: 'center',
  },
  waveBar: { width: 3, borderRadius: 1.5 },
  seekTouchArea: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  audioTimeRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 8 },
  audioTime: { color: C.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
  audioControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 28, gap: 28 },
  audioBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  audioBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  audioBtnText: { color: C.textDim, fontSize: 14 },
  audioPlayBtn: { width: 68, height: 68, borderRadius: 34, overflow: 'hidden' },
  audioPlayGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ── Unknown / error ─────────────────────────────────────────
  unknownPane: { flex: 1, paddingHorizontal: 32 },
  unknownTitle: { marginTop: 16 },
  unknownBody: { marginTop: 12, textAlign: 'center' },
  errorCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(239,68,68,0.12)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  errorTitle: { color: C.text, fontSize: 18, fontWeight: '700' },
  errorDesc: { color: C.textDim, fontSize: 14, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
  retryBtn: { marginTop: 24, borderRadius: 12, overflow: 'hidden' },
  retryGradient: { paddingHorizontal: 32, paddingVertical: 12, borderRadius: 12 },
  retryText: { color: C.onFill, fontSize: 15, fontWeight: '600' },

  // ── Bottom bar ──────────────────────────────────────────────
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(2,11,24,0.92)',   // paddingBottom: safe-area inset, set inline
    borderTopWidth: 1, borderTopColor: C.glassBorder,
  },
  bottomBtn: { borderRadius: 14, overflow: 'hidden' },
  bottomBtnGradient: { paddingVertical: 15, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  bottomBtnText: { color: C.onFill, fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
});
