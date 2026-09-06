// components/DocView.tsx — render a parsed document as a document.
//
// The viewer used to show one `<Text>{blob}</Text>`: a spreadsheet arrived as
// tab-separated soup that wrapped mid-row, a report lost every heading, and a
// deck's slides ran together with no boundary. All the structure needed to do
// better is already in the file — lib/docBlocks.ts pulls it out, and this draws
// it.
//
// Deliberately plain React Native: Views, Texts and two ScrollViews. No renderer,
// no WebView, no native module. It is a READER, not an editor — fonts, colours,
// images and charts stay the "open in another app" button's job.
//
// Pinch zooms by RESIZING THE TEXT rather than scaling the view, so the page
// re-wraps to the screen and the glyphs stay sharp — see lib/docs/zoom.ts.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import {
  Gesture, GestureDetector, ScrollView as GHScrollView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { Block, Run } from '../lib/docBlocks';
import { columnWidth, pinchZoom, zoomLabel } from '../lib/docs/zoom';
import { type Palette } from '../constants/theme';

// ─── Inline runs ─────────────────────────────────────────────────────

function Runs({ runs, style }: { runs: Run[]; style?: any }) {
  return (
    <Text selectable style={style}>
      {runs.map((r, i) => (
        <Text
          key={i}
          style={[
            r.b ? { fontWeight: '700' as const } : null,
            r.i ? { fontStyle: 'italic' as const } : null,
          ]}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

// ─── Grid (Word tables and Excel sheets) ─────────────────────────────

/**
 * Column widths from the CONTENT, not equal shares.
 *
 * An equal split makes a sheet of one long note and six short numbers unreadable
 * — the note wraps to eight lines while the numbers sit in acres of space. Width
 * tracks the longest cell, clamped so one enormous cell cannot push the rest off
 * the screen.
 */
function columnWidths(rows: string[][], cols: number, zoom: number): number[] {
  const w: number[] = new Array(cols).fill(0);
  for (const r of rows) {
    for (let c = 0; c < cols; c++) {
      const len = (r[c] ?? '').length;
      if (len > w[c]) w[c] = len;
    }
  }
  return w.map(len => columnWidth(len, zoom));
}

function Grid({
  rows, header, s, colors, maxWidth, zoom,
}: { rows: string[][]; header: boolean; s: any; colors: Palette; maxWidth: number; zoom: number }) {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const widths = useMemo(() => columnWidths(rows, cols, zoom), [rows, cols, zoom]);
  const total = widths.reduce((a, b) => a + b, 0);

  // Only scroll horizontally when the grid genuinely does not fit. Wrapping every
  // grid in a horizontal scroller steals the vertical pan near the edges.
  const body = (
    <View style={[s.grid, { minWidth: Math.min(total, maxWidth) }]}>
      {rows.map((row, ri) => {
        const head = header && ri === 0;
        return (
          <View key={ri} style={[s.gridRow, head && s.gridHead, !head && ri % 2 === 1 && s.gridAlt]}>
            {Array.from({ length: cols }).map((_, ci) => (
              <View key={ci} style={[s.gridCell, { width: widths[ci] }]}>
                <Text
                  selectable
                  numberOfLines={4}
                  style={[s.gridTxt, head && s.gridHeadTxt,
                          // Numbers right-align, as they do in every spreadsheet.
                          !head && isNumeric(row[ci]) && { textAlign: 'right' as const }]}
                >
                  {row[ci] ?? ''}
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );

  if (total <= maxWidth) return body;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator directionalLockEnabled>
      {body}
    </ScrollView>
  );
}

function isNumeric(v: string | undefined): boolean {
  if (!v) return false;
  return /^-?[\d,]*\.?\d+%?$/.test(v.trim());
}

/** A header row is one whose cells are all non-empty and none of them numeric. */
function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  return first.every(c => c.trim() !== '') && !first.some(isNumeric);
}

// ─── Document ────────────────────────────────────────────────────────

export function DocView({ blocks, colors }: { blocks: Block[]; colors: Palette }) {
  const [zoom, setZoom] = useState(1);
  const s = useMemo(() => makeStyles(colors, zoom), [colors, zoom]);
  const { width } = useWindowDimensions();
  const maxWidth = width - 36;   // the page padding below, both sides

  // A pinch reports a multiplier measured from where the fingers STARTED, so it
  // must be applied to the zoom the gesture began at. Multiplying it against the
  // live zoom compounds every frame and one slow pinch runs away to the maximum.
  const zoomRef = useRef(1);
  const baseRef = useRef(1);
  const applyScale = useCallback((scale: number) => {
    const next = pinchZoom(baseRef.current, scale);
    if (next === zoomRef.current) return;   // quantised: skip the re-layout
    zoomRef.current = next;
    setZoom(next);
  }, []);
  const endPinch = useCallback(() => { baseRef.current = zoomRef.current; }, []);
  const resetZoom = useCallback(() => {
    baseRef.current = 1; zoomRef.current = 1; setZoom(1);
  }, []);

  const pinch = useMemo(
    () => Gesture.Pinch()
      .onUpdate(e => { runOnJS(applyScale)(e.scale); })
      .onEnd(() => { runOnJS(endPinch)(); }),
    [applyScale, endPinch],
  );

  return (
    <View style={{ flex: 1 }}>
    <GestureDetector gesture={pinch}>
    <GHScrollView
      // Paint the page explicitly. Inheriting whatever surface the host happens
      // to have is how this shipped as near-white text on a white background —
      // present, correct, and unreadable.
      style={[{ flex: 1 }, { backgroundColor: colors.bg }]}
      contentContainerStyle={s.page}
      showsVerticalScrollIndicator
    >
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return <Runs key={i} runs={b.runs} style={[s.h, b.level === 1 ? s.h1 : b.level === 2 ? s.h2 : s.h3]} />;

          case 'p':
            return <Runs key={i} runs={b.runs} style={s.p} />;

          case 'li':
            return (
              <View key={i} style={[s.liRow, { marginLeft: 4 + Math.min(b.level, 4) * 16 }]}>
                <Text style={s.bullet}>{b.level % 2 === 0 ? '•' : '◦'}</Text>
                <Runs runs={b.runs} style={[s.p, s.liTxt]} />
              </View>
            );

          case 'table':
            return (
              <View key={i} style={s.blockGap}>
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} colors={colors} maxWidth={maxWidth} zoom={zoom} />
              </View>
            );

          case 'sheet':
            return (
              <View key={i} style={s.blockGap}>
                <View style={s.sheetTab}>
                  <Text style={s.sheetName} numberOfLines={1}>{b.name}</Text>
                  <Text style={s.sheetMeta}>
                    {b.rows.length} row{b.rows.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} colors={colors} maxWidth={maxWidth} zoom={zoom} />
              </View>
            );

          case 'slide':
            return (
              <View key={i} style={s.slide}>
                <View style={s.slideHead}>
                  <View style={s.slideNum}><Text style={s.slideNumTxt}>{b.n}</Text></View>
                  {!!b.title && <Text style={s.slideTitle} numberOfLines={3}>{b.title}</Text>}
                </View>
                {b.lines.map((l, li) => (
                  <View key={li} style={s.liRow}>
                    <Text style={s.bullet}>•</Text>
                    <Text selectable style={[s.p, s.liTxt]}>{l}</Text>
                  </View>
                ))}
              </View>
            );

          case 'page':
            return (
              <View key={i} style={s.pageBreak}>
                <View style={s.pageRule} />
                <Text style={s.pageTxt}>Page {b.n}</Text>
                <View style={s.pageRule} />
              </View>
            );

          default:
            return null;
        }
      })}
      <View style={{ height: 28 }} />
    </GHScrollView>
    </GestureDetector>

    {/* Only present once zoomed, and it is the way back to 100% — a pinch can
        strand someone at 40% with no obvious undo. */}
    {zoom !== 1 && (
      <Pressable
        onPress={resetZoom}
        style={[s.zoomPill, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}
        accessibilityRole="button"
        accessibilityLabel={`Zoom ${zoomLabel(zoom)}. Tap to reset.`}
      >
        <Text style={[s.zoomTxt, { color: colors.textDim }]}>{zoomLabel(zoom)}</Text>
      </Pressable>
    )}
    </View>
  );
}

// Every type size runs through z(), so a pinch re-lays the page out at a bigger
// size instead of scaling a bitmap of it. Paddings and rules stay put: zooming
// the margins as well just wastes the screen someone zoomed in to use.
const makeStyles = (c: Palette, zoom: number) => {
  const z = (n: number) => Math.round(n * zoom);
  return StyleSheet.create({
  page: { padding: 18, paddingBottom: 8 },

  h:   { color: c.text, fontWeight: '800', marginTop: 18, marginBottom: 6 },
  h1:  { fontSize: z(22), lineHeight: z(29) },
  h2:  { fontSize: z(18), lineHeight: z(25) },
  h3:  { fontSize: z(16), lineHeight: z(22) },
  p:   { color: c.text, fontSize: z(15), lineHeight: z(23), marginBottom: 9 },

  liRow:  { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 5 },
  bullet: { color: c.textDim, fontSize: z(15), lineHeight: z(23), width: z(18) },
  liTxt:  { flex: 1, marginBottom: 0 },

  blockGap: { marginTop: 8, marginBottom: 16 },

  grid:     { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 8, overflow: 'hidden' },
  gridRow:  { flexDirection: 'row' },
  gridHead: { backgroundColor: c.glassSoft },
  gridAlt:  { backgroundColor: c.glassSoft + '55' },
  gridCell: { paddingHorizontal: 9, paddingVertical: 7,
              borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.glassStroke,
              borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  gridTxt:      { color: c.text, fontSize: z(13), lineHeight: z(18) },
  gridHeadTxt:  { fontWeight: '800', color: c.text },

  sheetTab:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
               gap: 10, marginBottom: 7 },
  sheetName: { color: c.text, fontSize: z(14), fontWeight: '800', flexShrink: 1 },
  sheetMeta: { color: c.textFaint, fontSize: z(12) },

  slide:      { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 12,
                padding: 14, marginBottom: 14, backgroundColor: c.glassSoft },
  slideHead:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  slideNum:   { width: z(24), height: z(24), borderRadius: z(12), backgroundColor: c.glassSoft,
                alignItems: 'center', justifyContent: 'center' },
  slideNumTxt:{ color: c.textDim, fontSize: z(12), fontWeight: '800' },
  slideTitle: { color: c.text, fontSize: z(17), fontWeight: '800', flex: 1, lineHeight: z(23) },

  pageBreak: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20, marginBottom: 14 },
  pageRule:  { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  pageTxt:   { color: c.textFaint, fontSize: z(11), fontWeight: '700', letterSpacing: 0.6 },

  // Fixed size — the zoom readout must not itself zoom.
  zoomPill: { position: 'absolute', right: 14, bottom: 14, paddingHorizontal: 12,
              paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  zoomTxt:  { fontSize: 12, fontWeight: '800' },
});
};
