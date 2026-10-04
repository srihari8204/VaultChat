// components/live/liveStyles.ts — the Go Live stage's fixed palette and styles.
//
// Moved out of app/live-view.tsx unchanged. The stage is video on black in every
// theme, so these colours are fixed on purpose — the same rule, and the same
// shape, as constants/callTheme.ts for the call screens.

import { StyleSheet } from 'react-native';
import { SPACING, RADIUS } from '../../constants/theme';

/** Always-dark stage colours. Named once so the screen and its panels agree. */
export const LIVE = {
  black:        '#000',
  text:         '#fff',
  textSoft:     '#E2E8F0',
  textMuted:    '#CBD5E1',
  textDim:      '#94A3B8',
  placeholder:  '#64748B',
  panel:        '#0F172A',
  button:       '#1E293B',
  /** "On air" red, and its deep variant for an active (muted) control. */
  live:         '#EF4444',
  liveDeep:     '#B91C1C',
  /** Amber while the SDK reconnects — not red (live), not grey (ended). */
  reconnecting: '#F59E0B',
  highlight:    '#FCD34D',
  link:         '#93C5FD',
  dangerText:   '#F87171',
  errorText:    '#FCA5A5',
} as const;

// The stage is video on black in every theme, so these chrome colours are
// fixed on purpose (the same rule as the call screens).
export const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: LIVE.black },
  video: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.lg, padding: SPACING.xl },
  centerText: { color: LIVE.textMuted, fontSize: 15, textAlign: 'center' },
  backBtn: { paddingHorizontal: SPACING.xl, paddingVertical: SPACING.md, borderRadius: RADIUS.pill, backgroundColor: LIVE.button },
  backText: { color: LIVE.text, fontWeight: '600' },

  // ── ADAPTIVE CHROME ───────────────────────────────────────────────
  //
  // No `top:`, no `bottom:`, no magic numbers. The layer fills the screen and
  // its children flex within it; the only offsets are the safe-area insets,
  // supplied at render time by the device. That is the whole of what makes this
  // fit a 5" phone and a 6.9" one without either being measured.
  chrome: {
    ...StyleSheet.absoluteFillObject,
    // No paddingHorizontal here: the render supplies left and right from the
    // real insets, and a static value would win over them on the notch side.
  },
  /** Eats the leftover space. Used both as a row spacer and a column spacer. */
  grow: { flex: 1 },
  topRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    // Wraps rather than squeezing: a host on a narrow phone has status plus
    // four icons, and a squeezed row is how a control ends up unhittable.
    flexWrap: 'wrap',
  },
  /** Every top-row action. One size, so the row reads as a set. */
  icon: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.85)',
  },
  iconOn: { backgroundColor: 'rgba(59,130,246,0.9)' },
  /** "Show controls", parked where the top row's last icon sits. */
  showChrome: { position: 'absolute', opacity: 0.7 },
  iconDanger: { backgroundColor: 'rgba(185,28,28,0.92)' },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 17, height: 17,
    borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center', backgroundColor: LIVE.live,
  },
  badgeText: { color: LIVE.text, fontSize: 10, fontWeight: '800' },

  /** Camera picture-in-picture. Width and height come from the window. */
  pip: {
    position: 'absolute', borderRadius: RADIUS.md, overflow: 'hidden',
    backgroundColor: LIVE.panel,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
  },
  pipVideo: { flex: 1 },

  /** Bottom stack: polls, invite, chat, controls — in that order, in one flow. */
  bottom: { gap: SPACING.sm },
  /** Host-only "a share is running" chip. `top` is supplied from the insets. */
  sharingChip: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    backgroundColor: 'rgba(185,28,28,0.9)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs, borderRadius: RADIUS.pill,
  },
  sharingText: { color: LIVE.text, fontSize: 11, fontWeight: '700' },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.pill,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: LIVE.live },
  /** Amber while the SDK reconnects — not red (live), not grey (ended). */
  reconnectDot: { backgroundColor: LIVE.reconnecting },
  barText: { color: LIVE.text, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  barDim: { color: LIVE.textDim, fontSize: 11 },
  inviteSheet: {
    backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: RADIUS.lg,
    padding: SPACING.md, gap: 6,
  },
  inviteHead:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  inviteTitle: { flex: 1, color: LIVE.text, fontSize: 13, fontWeight: '700' },
  inviteHint:  { color: LIVE.textDim, fontSize: 11 },
  pcRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)',
  },
  pcLabel: { color: LIVE.textDim, fontSize: 11, fontWeight: '600' },
  pcValue: { color: LIVE.text, fontSize: 18, fontWeight: '700', letterSpacing: 2 },
  inviteUrl: {
    color: LIVE.textSoft, fontSize: 11, backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: RADIUS.sm, padding: SPACING.sm, marginTop: 2,
  },
  inviteRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: 4 },
  inviteBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: SPACING.sm, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(51,65,85,0.9)',
  },
  inviteBtnText: { color: LIVE.text, fontSize: 12, fontWeight: '600' },
  poll: {
    backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: RADIUS.lg, padding: SPACING.md, gap: 6,
  },
  pollHead:    { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginBottom: 2 },
  pollQ:       { flex: 1, color: LIVE.text, fontSize: 13, fontWeight: '700' },
  pollClose:   { color: LIVE.dangerText, fontSize: 11, fontWeight: '700' },
  pollOpt: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 7,
    paddingHorizontal: SPACING.sm, borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden',
  },
  // The bar sits BEHIND the label, so a long option is never clipped by it.
  pollBar:     { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(148,163,184,0.35)' },
  pollBarMine: { backgroundColor: 'rgba(239,68,68,0.45)' },
  pollOptText: { flex: 1, color: LIVE.textSoft, fontSize: 12 },
  pollOptMine: { color: LIVE.text, fontWeight: '700' },
  pollPct:     { color: LIVE.textMuted, fontSize: 11, fontWeight: '700' },
  pollTotal:   { color: LIVE.textDim, fontSize: 10, marginTop: 2 },
  pollCompose: {
    backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: RADIUS.lg, padding: SPACING.md, gap: 6,
  },
  pollInput: {
    color: LIVE.text, backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: RADIUS.sm, paddingHorizontal: SPACING.sm, paddingVertical: 7, fontSize: 13,
  },
  pollBtnRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.lg, marginTop: 4 },
  pollAdd:     { color: LIVE.link, fontSize: 12, fontWeight: '600' },
  pollCancelBtn: { marginLeft: 'auto' },
  pollCancel:  { color: LIVE.textDim, fontSize: 12 },
  pollGo:      { color: LIVE.highlight, fontSize: 12, fontWeight: '800' },
  // Directly under the top row, in flow: the stage is context, the stream is
  // the subject.
  stageStrip:      { flexGrow: 0, marginTop: SPACING.sm, maxHeight: 96 },
  stageStripInner: { gap: SPACING.sm },
  stageTile:       { width: 72, height: 96, borderRadius: RADIUS.md, backgroundColor: LIVE.panel, overflow: 'hidden' },
  controls: {
    flexDirection: 'row', alignSelf: 'center', gap: SPACING.md, marginTop: SPACING.xs,
  },
  ctrl: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,41,59,0.85)',
  },
  ctrlActive: { backgroundColor: LIVE.liveDeep },
  // Opened on demand, and only as tall as the window allows — the maxHeight is
  // computed from the live window at render time, not guessed at here.
  chatWrap:      { backgroundColor: 'rgba(2,6,23,0.72)', borderRadius: RADIUS.lg, paddingVertical: SPACING.sm },
  chatHead:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingBottom: 4 },
  chatHeadText:  { flex: 1, color: LIVE.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  chatList:      {},
  chatListInner: { paddingHorizontal: SPACING.md, gap: 4 },
  chatLine:      { color: LIVE.textSoft, fontSize: 13, textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3 },
  chatName:      { color: LIVE.highlight, fontWeight: '700' },
  chatFailed:    { color: LIVE.errorText, fontSize: 12, paddingHorizontal: SPACING.md, marginTop: 4 },
  chatInputRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
                   paddingHorizontal: SPACING.md, marginTop: SPACING.sm },
  chatInput:     { flex: 1, color: LIVE.text, backgroundColor: 'rgba(0,0,0,0.55)',
                   borderRadius: RADIUS.pill, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm },
  chatSend:      { backgroundColor: 'rgba(0,0,0,0.55)', padding: SPACING.md, borderRadius: RADIUS.pill },
});
