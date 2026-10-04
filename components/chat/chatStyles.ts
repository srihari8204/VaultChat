// components/chat/chatStyles.ts — the chat screen's stylesheet and the two
// tiny helpers that both the screen and the message bubbles need.
//
// Extracted from app/chat.tsx when that file passed 4,500 lines. It is imported
// by BOTH app/chat.tsx and components/chat/MessageBubble.tsx, which is exactly
// why it has to live on its own: putting it in either one would make the other
// import a module it otherwise has no business depending on.

import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { type Palette, ELEVATION, brandAlpha } from '../../constants/theme';
import { type Message } from '../../lib/chatService';
import { chatCardMax } from '../../constants/layoutMath';
import { tint } from '../../lib/tintColor';


// Optimistic bubbles carry a few extra fields beyond a server Message.
export type DisplayMessage = Message & {
  _tempId?: string;
  _state?: 'pending' | 'failed';
  _error?: string;
  /**
   * Sender-side upload progress, 0→1 within `_phase`. In-memory only — never
   * persisted, so a restart shows the plain pending state until the next
   * sample arrives (the upload itself resumes from the parts already stored).
   * Absent means "no sample yet", which renders as the original clock.
   */
  _phase?: 'preparing' | 'uploading';
  _progress?: number;
  /**
   * Every message in this album, oldest-first, when several media were picked
   * in one action. Present only on the row that stands in for the group; the
   * members remain independent messages with their own ids and delivery state.
   */
  _album?: DisplayMessage[];
};

/**
 * Device metrics the chat stylesheet needs.
 *
 * WHY THIS EXISTS: the header used to hardcode `paddingTop: 56` to clear the
 * status bar. 56 is roughly right on a tall modern phone and badly wrong
 * everywhere else — on a short or small-density screen it ate a chunk of the
 * conversation for nothing, which is what "the header occupies more space"
 * reports. The status bar is a number the OS already knows; ask it.
 *
 * `narrow` drives the second half of the problem. The header packs an avatar,
 * a title block and up to five 40pt icon buttons; below ~360dp those stop
 * fitting and the trailing ones get pushed off-screen. Shrinking the touch
 * targets to 36pt there keeps every control reachable — still above the 32pt
 * floor where a target becomes genuinely hard to hit.
 */
export type ChatMetrics = { topInset: number; bottomInset: number; narrow: boolean; cardMax: number };

let shared: { key: unknown[]; sheet: ReturnType<typeof makeStyles> } | null = null;
export function useS() {
  const { colors } = useTheme();
  const { metrics, profile } = useVisionComfort();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const m: ChatMetrics = {
    topInset: insets.top,
    bottomInset: insets.bottom,
    narrow: width < 360,
    // Widest a card may be INSIDE A BUBBLE. The bubble is maxWidth:'78%' with
    // 14dp of padding each side, and 78% resolves against `bubbleRow` inside a
    // list padded 12dp each side - not against the window. So the usable slot
    // is 0.78*(W-24) - 28, and file cards, previews, polls and the video player
    // were all hardcoded to 240. That slot only reaches 240 at ~368dp, so every
    // phone below it (320dp is the floor we support) had ~38dp of card pushed
    // outside the bubble (2026-09-17; gutter and video corrected 2026-09-18).
    cardMax: chatCardMax(width),
  };
  return useMemo(() => {
    // ONE sheet for every caller with the same inputs. Each bubble (and each
    // poll/file/audio card inside it) calls this hook, and a per-instance memo
    // rebuilt the whole stylesheet for every row that mounted.
    const key = [colors, m.topInset, m.bottomInset, m.narrow, m.cardMax, metrics, profile.highContrast];
    if (shared && shared.key.every((k, i) => k === key[i])) return shared.sheet;
    const sheet = makeStyles(colors, m, metrics, profile.highContrast);
    shared = { key, sheet };
    return sheet;
  // m is rebuilt every render; its four fields are the real inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, m.topInset, m.bottomInset, m.narrow, m.cardMax, metrics, profile.highContrast]);
}

// Pick black or white text for legibility on an arbitrary bubble color.
export function idealText(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#fff';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0e0e14' : '#ffffff';
}

// The search-hit mark (renderWithHighlight). Deliberately fixed: yellow under
// near-black reads on every bubble colour. Link and mention colours are themed
// per bubble (bubbleText.tsx BubbleInk).
export const HL = StyleSheet.create({
  highlight: { backgroundColor: 'rgba(252, 211, 77, 0.45)', color: '#111' },
});

/**
 * White on an always-dark media scrim (video play button, download overlay):
 * the plate under it is #000 / rgba(0,0,0,·) in both themes, so the ink is
 * fixed on purpose, like the plates themselves (theme-exempt below).
 */
export const ON_MEDIA_SCRIM = '#fff';

// `m` is optional so the one other caller (MessageBubble's direct makeStyles
// import) keeps working unchanged; it renders bubbles, not the header, so the
// fallback never reaches a visible edge. The fallback mirrors a typical status
// bar rather than the old 56 — an unmeasured guess should not be the tall one.
export const makeStyles = (
  c: Palette,
  m: ChatMetrics = { topInset: 24, bottomInset: 0, narrow: false, cardMax: 240 },
  v = { textScale: 1, lineScale: 1, spacingScale: 1, controlScale: 1, bold: false },
  highContrast = false,
) => StyleSheet.create({
  screen:        { flex: 1, backgroundColor: c.chatBg },
  lockGate:      { ...StyleSheet.absoluteFillObject, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32, zIndex: 50 },
  lockGateTitle: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 16 },
  lockGateSub:   { color: c.textDim, fontSize: 14, marginTop: 6, textAlign: 'center' },
  lockGateBtn:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: c.primary, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 24, marginTop: 20, minWidth: 200 },
  lockGateBtnTxt:{ color: c.onPrimary, fontSize: 15, fontWeight: '800' },
  lockGateInput: { backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 18, textAlign: 'center', letterSpacing: 6, paddingVertical: 12 },
  lockGateErr:   { color: c.danger, fontSize: 13, textAlign: 'center', marginTop: 8 },
  lockGateBack:  { color: c.textDim, fontSize: 14, fontWeight: '600' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  // paddingTop is the REAL status-bar height plus a small breathing gap, not a
  // fixed 56. Vertical padding tightens on narrow devices, where the header was
  // costing more of the conversation than the conversation could spare.
  // Glass wrappers for the floating chrome. The inner header/composer stay
  // transparent — these own the blur, the tint and the edge.
  headerGlass:   { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  composerGlass: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.glassStroke },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: m.narrow ? 10 : 14, paddingTop: m.topInset + (m.narrow ? 4 : 6), paddingBottom: m.narrow ? 8 : 12, gap: m.narrow ? 6 : 10, backgroundColor: 'transparent' },
  headerIconBtn: { width: (m.narrow ? 36 : 40) * v.controlScale, height: (m.narrow ? 36 : 40) * v.controlScale, alignItems: 'center', justifyContent: 'center' },
  headerIcon:    { fontSize: m.narrow ? 18 : 20 },
  headerAvatarWrap:  { width: m.narrow ? 32 : 36, height: m.narrow ? 32 : 36 },
  // Scroll-to-bottom FAB
  scrollDownBtn:     { position: 'absolute', right: 14, bottom: 92, width: 44, height: 44, borderRadius: 22, backgroundColor: c.surfaceSolid, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, alignItems: 'center', justifyContent: 'center', ...ELEVATION.md, shadowColor: '#000' },
  scrollDownBadge:   { position: 'absolute', top: -5, right: -5, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, borderWidth: 2, borderColor: c.bg },
  scrollDownBadgeTxt:{ color: c.onPrimary, fontSize: 11, fontWeight: '800' },
  // Message Info sheet
  infoBackdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  infoSheet:         { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28 },
  sheetGrip:         { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 10 },
  infoTitle:         { color: c.text, fontSize: 17, fontWeight: '800', marginBottom: 4 },
  infoSecHdr:        { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  infoSecTitle:      { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  infoRow:           { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  infoName:          { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  infoDetail:        { color: c.textDim, fontSize: 12, marginTop: 1 },
  infoEmpty:         { color: c.textDim, fontSize: 13, paddingVertical: 16, textAlign: 'center' },
  // Profile-photo popup (avatar tap)
  photoBackdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  photoCard:         { width: '100%', maxWidth: 360, borderRadius: 16, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  photoImgWrap:      { width: '100%', aspectRatio: 1, backgroundColor: c.primary },
  photoImg:          { width: '100%', height: '100%' },
  photoInitialsWrap: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  photoInitials:     { color: '#fff', fontSize: 84, fontWeight: '800' },
  photoNameBar:      { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
  photoNameTxt:      { color: '#fff', fontSize: 19, fontWeight: '700' },
  photoActions:      { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: c.surfaceSolid },
  photoActionBtn:    { alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  photoActionTxt:    { color: c.primary, fontSize: 12, fontWeight: '600' },
  // Must track headerAvatarWrap exactly — a 36pt avatar inside a 32pt wrapper
  // overflows into the title on the devices this change is for.
  headerAvatar:      { width: m.narrow ? 32 : 36, height: m.narrow ? 32 : 36, borderRadius: m.narrow ? 16 : 18, backgroundColor: c.groundDisc, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  headerAvatarImg:   { width: '100%', height: '100%' },
  headerAvatarTxt:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  headerPresenceDot: { position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 5, backgroundColor: c.online, borderWidth: 2, borderColor: c.bg },

  // Day 13 — in-chat search
  inChatSearchBar:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  inChatSearchInput:  { flex: 1, color: c.text, backgroundColor: c.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  inChatSearchCount:  { color: c.textDim, fontSize: 11, fontWeight: '600' },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 24 },
  // 17/20, not 18/700. The WhatsApp spec puts the chat-header name at 17/20
  // (§2.2) and the Figma header matches; 18 at weight 700 was both larger and
  // heavier than anything else in the app calls a name — the chat LIST row is
  // 17 — and every extra point came straight off the width available before the
  // name ellipsises. lineHeight pinned so the two-line title block does not
  // shift when the presence line changes.
  title:         { color: c.text, fontSize: 17 * v.textScale, lineHeight: Math.ceil(20 * v.textScale * v.lineScale), fontWeight: v.bold ? '700' : '600' },
  sub:           { color: c.accentLight, fontSize: 12 * v.textScale, lineHeight: Math.ceil(16 * v.textScale * v.lineScale) },
  e2eBadge:      { color: c.success, fontSize: 11, fontWeight: '600' },
  // Self-destruct countdown for a chat opened by a 1h/3h code (migration 120).
  // Sits directly under the header subtitle; goes red under ten minutes.
  expiryRow:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  expiryTxt:     { color: c.textDim, fontSize: 11, fontWeight: '700' },

  errorBar:      { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  errorTxt:      { color: c.danger, fontSize: 12 },
  // A transient status line ("Forwarding to …"), neutral so it never reads as an error.
  noticeBar:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surfaceSolid, borderColor: c.border, borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  noticeTxt:     { color: c.text, fontSize: 12 },
  screenshotBanner:    { backgroundColor: tint(c.warning, 0.14), borderColor: tint(c.warning, 0.5), borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  // Memory Bubble — anniversary banner under the chat header. Distinct
  // from screenshot/error banners (purple) so the user reads it as a
  // "nostalgia" moment rather than an alert.
  memoryBubble:        { backgroundColor: tint(c.purple, 0.10), borderColor: tint(c.purple, 0.35), borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 10 },
  memoryBubbleTitle:   { color: c.accentOn, fontSize: 12, fontWeight: '700' },
  memoryBubbleBody:    { color: c.text, fontSize: 13, marginTop: 4, fontStyle: 'italic' },
  memoryBubbleDismiss: { color: c.textDim, fontSize: 10, marginTop: 6 },
  screenshotBannerTxt: { color: c.text, fontSize: 12, fontWeight: '600' },

  // Security-code change. Amber, not red: a changed key usually means the peer
  // reinstalled, and colouring an ordinary event as an attack teaches people to
  // ignore the one time it is not.
  keyChangeBanner: {
    backgroundColor: tint(c.warning, 0.12), borderColor: tint(c.warning, 0.35),
    borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 10,
  },
  keyChangeTxt:     { color: c.text, fontSize: 12, lineHeight: 18 },
  keyChangeRow:     { flexDirection: 'row', gap: 20, marginTop: 8 },
  keyChangeVerify:  { color: c.accentOn, fontSize: 12, fontWeight: '800' },
  keyChangeDismiss: { color: c.textDim, fontSize: 12, fontWeight: '600' },

  // A peer is sharing live location — tinted from the theme's primary.
  liveLocBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 12, backgroundColor: tint(c.primary, 0.12), borderWidth: 1, borderColor: tint(c.primary, 0.4) },
  liveLocTitle:  { color: c.primary, fontSize: 13, fontWeight: '700' },
  liveLocSub:    { color: c.textDim, fontSize: 11, marginTop: 1 },

  mentionBar:    { backgroundColor: c.surfaceSolid, borderTopWidth: 1, borderTopColor: c.border, maxHeight: 220 },
  mentionRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  mentionName:   { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },

  // The tappable part of a banner whose dismiss ✕ is its sibling.
  bannerMain:    { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pinnedBar:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderBottomWidth: 1, borderBottomColor: c.border },
  pinnedBarTitle:{ color: c.primary, fontSize: 11, fontWeight: '700' },
  pinnedBarSub:  { color: c.textDim, fontSize: 12.5, marginTop: 1 },

  dateChipRow:   { alignItems: 'center', marginVertical: 10 },
  dateChip:      { backgroundColor: c.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  dateChipTxt:   { color: c.textDim, fontSize: 11.5, fontWeight: '700' },
  unreadDivRow:  { alignItems: 'center', marginVertical: 8 },
  unreadDivTxt:  { color: c.primary, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.3, backgroundColor: brandAlpha(0.14), borderRadius: 999, paddingHorizontal: 14, paddingVertical: 4, overflow: 'hidden' },

  // Emoji insertion panel above the composer
  emojiPanel:    { height: 240, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  emojiWrap:     { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 6, paddingVertical: 8 },
  emojiCell:     { width: `${100 / 8}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  emojiGlyph:    { fontSize: 26 },

  bubbleRow:     { marginVertical: 4 * v.spacingScale, flexDirection: 'row' },
  bubbleRowGrouped: { marginTop: 1 * v.spacingScale }, // tighter spacing for consecutive same-sender msgs
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs:{ justifyContent: 'flex-start' },
  bubble:        { maxWidth: v.textScale > 1.2 ? '90%' : '78%', paddingVertical: 9 * v.spacingScale, paddingHorizontal: 14, borderRadius: 20, gap: 3 * v.spacingScale },
  bubbleMine:    { backgroundColor: c.bubbleOut, borderTopRightRadius: 6 },   // Aurora "sent"
  bubbleTheirs:  { backgroundColor: c.bubbleIn, borderTopLeftRadius: 6 },     // Aurora "received"
  bubblePending: { opacity: 0.6 },
  bubbleFailed:  { borderWidth: 1, borderColor: c.danger, opacity: 0.85 },
  bubbleSystem:  { alignSelf: 'center', backgroundColor: 'transparent', paddingVertical: 4 },
  bubbleSystemTxt:{ color: c.textDim, fontSize: 11, fontStyle: 'italic' },
  senderTag:     { color: c.textDim, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  bubbleTxt:     { color: c.bubbleInText, fontSize: 15 * v.textScale, lineHeight: Math.ceil(20 * v.textScale * v.lineScale), fontWeight: v.bold ? '600' : undefined },
  // Chat Reader hand-off, shown only under a long message (see ReaderAffordance).
  readerChip:    {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    marginTop: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth, borderColor: brandAlpha(0.45),
    backgroundColor: brandAlpha(0.10),
  },
  readerChipTxt: { color: c.text, fontSize: 12, fontWeight: '600' },
  bubbleTxtMine: { color: c.bubbleOutText },
  bubbleMeta:    { color: highContrast ? c.bubbleOutText : c.bubbleMetaOut, fontSize: 10 * v.textScale, alignSelf: 'flex-end', marginTop: 2 * v.spacingScale },
  // No colour: inherits the bubble's meta ink, which is chosen for the bubble it sits on.
  ttlBadge:      { fontSize: 10, fontWeight: '700' },
  tick:          { color: c.bubbleMetaOut, fontSize: 11, fontWeight: '700' },
  tickRead:      { color: c.tickRead,      fontSize: 11, fontWeight: '700' },

  typingBar:     { paddingHorizontal: 16, paddingBottom: 4 },
  typingTxt:     { color: c.textDim, fontSize: 12, fontStyle: 'italic' },

  editBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: brandAlpha(0.12), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  // Vanish-Mode banner above the composer when chat.vanishMode is ON.
  vanishBar:     { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: tint(c.warning, 0.10), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tint(c.warning, 0.40) },
  vanishBarTxt:  { color: c.text, fontSize: 12, fontWeight: '600' },
  // 💨 badge inside the bubble meta line for messages stamped vanish_after_read.
  vanishBadge:   { fontSize: 10, fontWeight: '700' },
  // Invisible Ink obscured text: bullets render slightly tighter and a
  // touch dimmer than normal text so the bubble visibly reads as "covered".
  invisibleInk:  { letterSpacing: 1, opacity: 0.75 },
  // Composer banner when Invisible Ink is armed (matches vanishBar shape).
  inkBar:        { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: tint(c.purple, 0.12), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tint(c.purple, 0.45) },
  inkBarTxt:     { color: c.text, fontSize: 12, fontWeight: '600' },
  editTxt:       { flex: 1, color: c.primary, fontSize: 12, fontWeight: '600' },
  editCancelTxt: { color: c.textDim, fontSize: 12 },

  composer:      { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 14, paddingVertical: 12 * v.spacingScale, gap: 10, backgroundColor: 'transparent' },
  inputPill:     { flex: 1, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: highContrast ? c.surfaceSolid : c.glassSoft, borderRadius: 26, minHeight: 50 * v.controlScale, paddingLeft: 18, paddingRight: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  pillIconBtn:   { width: 38 * v.controlScale, height: 46 * v.controlScale, alignItems: 'center', justifyContent: 'center' },
  camWrap:       { width: 38, height: 46, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  camRing:       { position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: c.primary, backgroundColor: 'rgba(0,0,0,0)' },
  camDragHint:   { position: 'absolute', bottom: 50, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, ...ELEVATION.sm, shadowColor: c.primary },
  camDragHintTxt:{ color: c.onPrimary, fontSize: 12, fontWeight: '800' },
  camHintChevron:{ position: 'absolute', bottom: 42, alignSelf: 'center' },
  sendFab:       { width: 50 * v.controlScale, height: 50 * v.controlScale, borderRadius: 25 * v.controlScale, backgroundColor: c.accentDeep, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, elevation: 6, shadowColor: c.accentDeep, shadowOpacity: 0.55, shadowOffset: { width: 0, height: 6 }, shadowRadius: 18 },
  attachBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  attachTxt:     { fontSize: 18 },

  // Attach menu — WhatsApp-style grid
  attachBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  attachSheet:    { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 10, paddingBottom: 32, paddingHorizontal: 8 },
  attachHandle:   { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 14 },
  attachGrid:     { flexDirection: 'row', flexWrap: 'wrap' },
  attachCell:     { width: '25%', alignItems: 'center', paddingVertical: 12, gap: 8 },
  attachIcon:     { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  attachLabel:    { color: c.text, fontSize: 12, textAlign: 'center' },

  // Recording-mode composer: pulse dot + timer + hint + cancel/send buttons
  recordingComposer: { alignItems: 'center', gap: 8 },
  recordingDot:    { width: 10, height: 10, borderRadius: 5, backgroundColor: c.danger },
  recordingTimer:  { color: c.text, fontSize: 16, fontWeight: '700', minWidth: 52, textAlign: 'center' },
  recordingHint:   { flex: 1, color: c.textDim, fontSize: 12 },
  recCancelBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  recCancelTxt:    { color: c.danger, fontSize: 18, fontWeight: '700' },
  recSendBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  recSendTxt:      { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Voice-message bubble (playback): play/pause button + track + duration
  audioRow:           { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: Math.min(200, m.cardMax), maxWidth: Math.min(260, m.cardMax) },
  audioPlayBtn:       { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  audioPlayBtnMine:   { backgroundColor: c.primary },
  audioPlayBtnTheirs: { backgroundColor: c.primary },
  audioPlayIcon:      { color: '#fff', fontSize: 14, fontWeight: '700' },
  audioMeter:         { flex: 1, gap: 4 },
  audioTrack:         { height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.30)', overflow: 'hidden' },
  audioFill:          { height: 4, backgroundColor: c.primary, borderRadius: 2 },

  // Waveform bars (Day 7 polish): 32 vertical bars sized by amplitude.
  // Played bars use the accent color; unplayed are dim so the playhead
  // is implicit. flex-end alignItems so all bars sit on the baseline.
  waveBars:               { flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 2 },
  waveBar:                { width: 3, borderRadius: 1.5 },
  waveBarPlayedMine:      { backgroundColor: c.bubbleOutText },
  waveBarUnplayedMine:    { backgroundColor: c.bubbleMetaOut },
  waveBarPlayedTheirs:    { backgroundColor: c.primary },
  waveBarUnplayedTheirs:  { backgroundColor: 'rgba(128,128,128,0.35)' },
  audioFillMine:      { backgroundColor: c.bubbleOutText },
  audioTime:          { color: c.bubbleMetaIn, fontSize: 11 },
  audioTimeMine:      { color: c.bubbleMetaOut },

  input:         { flex: 1, color: c.text, paddingVertical: 11, paddingRight: 4, maxHeight: 120 * v.textScale, fontSize: 16 * v.textScale, lineHeight: Math.ceil(21 * v.textScale * v.lineScale) },
  sendBtn:       { backgroundColor: c.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, justifyContent: 'center' },
  sendBtnOff:    { backgroundColor: c.textFaint, elevation: 0, shadowOpacity: 0 },
  sendTxt:       { color: '#fff', fontWeight: '700' },

  imageBubble:   { padding: 4, borderRadius: 12 },
  // Media (image/video/gif) bubbles: no fill, just a thin frame so the media
  // sits nearly edge-to-edge (the orange fill looked awkward around photos).
  mediaBubble:   { backgroundColor: 'transparent', padding: 3, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  // Sticker: WhatsApp-style — transparent backdrop, no padding, just a
  // big emoji glyph. The bubble component still wraps it so long-press
  // (forward/reply/delete) works the same as any other message.
  stickerBubble: { backgroundColor: 'transparent', padding: 0 },
  stickerEmoji:  { fontSize: 72, lineHeight: 84 },

  // Poll bubble: question on top, options as rows with a horizontal fill
  // bar proportional to vote count, footer with totals + mode hint.
  pollWrap:               { minWidth: Math.min(240, m.cardMax), maxWidth: Math.min(300, m.cardMax), gap: 8 },
  pollQuestion:           { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 6 },
  pollQuestionMine:       { color: c.bubbleOutText },
  pollOptionRow:          { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  pollOptionMark:         { color: c.textDim, fontSize: 16, width: 18, textAlign: 'center' },
  pollOptionMarkOn:       { color: c.primary },
  pollOptionLine:         { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  pollOptionLabel:        { color: c.text, fontSize: 13, flex: 1 },
  pollOptionLabelMine:    { color: c.bubbleOutText },
  pollOptionCount:        { color: c.textDim, fontSize: 11, fontWeight: '700' },
  pollOptionCountMine:    { color: c.bubbleMetaOut },
  pollBarTrack:           { height: 4, backgroundColor: 'rgba(128,128,128,0.25)', borderRadius: 2, marginTop: 4, overflow: 'hidden' },
  pollBarFill:            { height: 4, backgroundColor: c.primary, borderRadius: 2 },
  pollBarFillMine:        { backgroundColor: c.bubbleOutText },
  pollFooter:             { color: c.textDim, fontSize: 11, marginTop: 6 },
  pollFooterMine:         { color: c.bubbleMetaOut },
  attachedImage: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#0F1217' },   // theme-exempt: neutral plate behind media
  // KLIPY watermark on a sent GIF/sticker/emoji card. Bottom-left and
  // semi-transparent, per their brand guideline: visible enough to attribute,
  // faint enough not to compete with the content it sits on.
  // The KLIPY mark on a sent card: bottom-left, per their guideline.
  //
  // A SCRIM, not a shadow. The first attempt used shadowColor/shadowRadius,
  // which Android ignores outright — it only honours `elevation` — so a WHITE
  // outlined wordmark on a pale or busy GIF was drawn correctly and was
  // effectively invisible. That is indistinguishable from "no watermark", which
  // is how it was reported. A soft dark pill behind the mark guarantees
  // contrast on any content and leaves KLIPY's artwork untouched, which matters:
  // the mark itself must not be recoloured or altered.
  //
  // Sized to the SVG's viewBox (389.2 x 133.2 = 2.92) plus the pill's padding.
  klipyWatermark: {
    position: 'absolute', left: 8, bottom: 8,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  dlOverlay:     { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.25)' },
  dlOverlayTxt:  { color: '#fff', fontSize: 12, fontWeight: '700' },
  // Sender-side UPLOAD overlay (the download twin above is the receiver's).
  // pointerEvents:'none' at the call site keeps long-press-to-cancel working
  // through it — the bubble, not this scrim, owns the gesture.
  upOverlay:     { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 14 },
  upOverlayTxt:  { color: '#fff', fontSize: 11, fontWeight: '700' },
  imageError:    { width: 180, padding: 16, alignItems: 'center', gap: 4 },
  mediaUnavailableTxt: { color: c.textDim, fontSize: 12, textAlign: 'center' },
  imageErrorTxt: { color: c.textDim, fontSize: 12 },

  // Video bubble — inline player with native controls + duration pill
  // 2026-09-18: was a flat 240x240. A media bubble's slot is only 224dp at the
  // 320dp floor, so the player overhung it by 16dp and the duration pill in its
  // bottom-right corner was the part that went off-screen. Capped by the same
  // m.cardMax as every other card: that is the TEXT-bubble slot, so it is a few
  // dp tighter than a media bubble strictly allows, and one number beats a
  // second metric threaded through ChatMetrics for a difference nobody can see.
  // Unchanged at 368dp and above, which includes both reference devices.
  videoWrap:     { width: Math.min(240, m.cardMax), height: Math.min(240, m.cardMax), borderRadius: 8, overflow: 'hidden', backgroundColor: '#000', position: 'relative' },   // theme-exempt: neutral plate behind media
  videoView:     { width: '100%', height: '100%' },
  videoDuration: { position: 'absolute', right: 8, bottom: 8, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  videoLoading:  { width: Math.min(240, m.cardMax), height: Math.min(240, m.cardMax), borderRadius: 8, backgroundColor: '#0F1217', alignItems: 'center', justifyContent: 'center' },   // theme-exempt: neutral plate behind media
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#10141B' },   // theme-exempt: neutral plate behind media
  // Round "video note" (Telegram/WhatsApp style) — distinct from a rectangular video.
  videoNoteWrap: { width: 200, height: 200, borderRadius: 100, overflow: 'hidden', backgroundColor: '#000', position: 'relative', alignSelf: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' },   // theme-exempt: neutral plate behind media
  videoNoteView: { width: '100%', height: '100%' },
  videoNoteDuration: { right: undefined, bottom: 10, alignSelf: 'center', left: 0, textAlign: 'center', width: '100%', backgroundColor: 'transparent' },
  videoPlayOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  videoPlayBtn:  { width: 54, height: 54, borderRadius: 27, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)' },
  videoPlayIcon: { color: '#fff', fontSize: 22, marginLeft: 4 },

  // View-once shield (before tap) + tombstone (after view)
  viewOnceShield:        { width: 220, padding: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: brandAlpha(0.15), borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed' },
  viewOnceShieldIcon:    { fontSize: 28 },
  viewOnceShieldTxt:     { color: c.text, fontSize: 14, fontWeight: '700' },
  viewOnceShieldHint:    { color: c.textDim, fontSize: 11, textAlign: 'center' },
  viewOnceTombstone:     { width: 220, padding: 16, borderRadius: 12, alignItems: 'center', backgroundColor: c.surfaceSolid, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  viewOnceTombstoneTxt:  { color: c.textDim, fontSize: 12, fontStyle: 'italic' },

  // Day 9 — file bubble (documents)
  fileRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: Math.min(220, m.cardMax), maxWidth: Math.min(280, m.cardMax) },
  fileCard:       { width: Math.min(240, m.cardMax), borderRadius: 8, overflow: 'hidden' },
  filePreview:    { width: Math.min(240, m.cardMax), height: 170, backgroundColor: 'rgba(0,0,0,0.06)' },
  fileCardRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
  fileIcon:       { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fileIconMine:   { backgroundColor: c.primary },
  fileIconTheirs: { backgroundColor: c.primary },
  fileIconTxt:    { fontSize: 18 },
  fileMeta:       { flex: 1, gap: 2 },
  fileName:       { color: c.bubbleInText, fontSize: 14, fontWeight: '600' },
  fileNameMine:   { color: c.bubbleOutText },
  fileSize:       { color: c.bubbleMetaIn, fontSize: 11 },
  fileSizeMine:   { color: c.bubbleMetaOut },

  // Day 8 — reply bar above composer
  replyBar:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  lpBar:           { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  lpBarImg:        { width: 36, height: 36, borderRadius: 6, backgroundColor: c.border },
  lpBarTitle:      { color: c.text, fontSize: 12, fontWeight: '700' },
  lpBarDesc:       { color: c.textDim, fontSize: 11, marginTop: 1 },
  replyBarLine:    { width: 3, alignSelf: 'stretch', backgroundColor: c.primary, borderRadius: 1.5 },
  replyBarTitle:   { color: c.primary, fontSize: 12, fontWeight: '700' },
  replyBarBody:    { color: c.text, fontSize: 13 },

  // Day 8 — inline reply preview inside a bubble
  replyPreview:        { flexDirection: 'row', alignItems: 'stretch', gap: 8, marginBottom: 6, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: 'rgba(0,0,0,0.16)', borderRadius: 6 },
  replyPreviewLine:    { width: 2, backgroundColor: c.primary, borderRadius: 1 },
  replyPreviewWho:     { color: c.primary, fontSize: 11, fontWeight: '700' },
  replyPreviewBody:    { color: c.bubbleInText, fontSize: 12 },

  // Day 8 — "↪ Forwarded" tag at top of bubble
  forwardedTag:        { color: c.textDim, fontSize: 11, fontStyle: 'italic', marginBottom: 2 },
  // Audit F10, second tier. Weight rather than colour: this is a caution, not
  // an error, and a red label on a friend's message reads as an accusation
  // against the friend rather than information about the message.
  forwardedTagMany:    { fontStyle: 'italic', fontWeight: '700' },

  // Day 8 — reaction chips under a bubble
  reactionRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: -6, marginBottom: 6, paddingHorizontal: 4 },
  reactionRowMine:     { justifyContent: 'flex-end' },
  reactionRowTheirs:   { justifyContent: 'flex-start' },
  reactionChip:        { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, backgroundColor: c.surfaceSolid, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  reactionChipMine:    { backgroundColor: brandAlpha(0.25), borderColor: c.primary },
  reactionChipEmoji:   { fontSize: 14 },
  reactionChipCount:   { color: c.textDim, fontSize: 11, fontWeight: '600' },
  reactionChipCountMine: { color: c.primary },

  // Centred-sheet backdrop (forward picker)
  modalBackdrop:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },

  // Day 8 — forward chat picker
  forwardSheet:        { width: '100%', maxHeight: '70%', backgroundColor: c.card, borderRadius: 16, padding: 16, gap: 8 },
  forwardTitle:        { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  // Audit F10. minHeight, not height: this string grows with the system font
  // scale and a fixed height would clip it (see the test:layout guard).
  forwardManyNotice:   { color: c.textDim, fontSize: 12.5, lineHeight: 18, minHeight: 18, marginBottom: 10 },
  forwardPreview:      { flexDirection: 'row', gap: 8, backgroundColor: c.card, borderRadius: 10, padding: 10, marginBottom: 8 },
  forwardPreviewWho:   { color: c.primary, fontSize: 13, fontWeight: '700' },
  forwardPreviewBody:  { color: c.textDim, fontSize: 13, marginTop: 2 },
  forwardEmpty:        { color: c.textDim, textAlign: 'center', marginTop: 24 },
  forwardRow:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  forwardRowTxt:       { color: c.text, fontSize: 15, flex: 1 },
  forwardRowSub:       { color: c.textDim, fontSize: 11 },
});
