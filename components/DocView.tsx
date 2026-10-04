// components/DocView.tsx — render a parsed document as a document.
//
// The viewer used to show one `<Text>{blob}</Text>`: a spreadsheet arrived as
// tab-separated soup that wrapped mid-row, a report lost every heading, and a
// deck's slides ran together with no boundary. All the structure needed to do
// better is already in the file — lib/docBlocks.ts pulls it out, and this draws
// it.
//
// Deliberately plain React Native: Views, Texts and scroll views. No renderer,
// no WebView, no native module. It is a READER, not an editor — fonts, colours,
// images and charts stay the "open in another app" button's job.
//
// Pinch zooms by RESIZING THE TEXT rather than scaling the view, so the page
// re-wraps to the screen and the glyphs stay sharp — see lib/docs/zoom.ts.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, useWindowDimensions,
  type StyleProp, type TextStyle,
} from 'react-native';
import {
  Gesture, GestureDetector, FlatList as GHFlatList,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import type { Block, Run } from '../lib/docBlocks';
import { pinchZoom, zoomLabel } from '../lib/docs/zoom';
import { columnWidths, gridCols, gridPlan, longestCells, rowPaneHeight, sumWidths } from '../lib/media/sheetGrid';
import { type Palette } from '../constants/theme';

// ─── Inline runs ─────────────────────────────────────────────────────

function Runs({ runs, style }: { runs: Run[]; style?: StyleProp<TextStyle> }) {
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

// lib/docBlocks.ts emits ONE block per worksheet, so the outer FlatList cannot
// window a 50k-row sheet. A sheet over VIRTUAL_MIN_ROWS rows therefore gets its
// own bounded row pane: a vertical FlatList of rows inside the grid's single
// horizontal scroller, every row laid out on the same fixed column widths so the
// columns line up while scrolling either way. The header row is drawn above the
// pane in that same scroller, so it stays put vertically and moves with the
// columns horizontally. Smaller grids flow into the page as before. Layout maths:
// lib/media/sheetGrid.ts.
//
// The pane must NOT join the page list's virtualisation. A VirtualizedList that
// finds a same-orientation VirtualizedList above it in context treats itself as
// part of that list (VirtualizedList._isNestedWithSameOrientation): it takes its
// window from the PAGE's scroll metrics, shifted by its own offset on the page,
// and runs even its own scroll events through that shift. The window then
// tracks the wrong offset (worse the lower the sheet sits on the page), so rows
// scroll into the pane blank. (Without GHFlatList's scroll component it would
// not scroll at all: a nested list renders a plain View.) PaneRoot cuts both
// contexts, exactly as RN's own Modal does for content it portals
// (react-native/Libraries/Modal/Modal.js), so the pane is a root list that
// windows over its own bounded viewport. Pinned by
// lib/media/sheetPaneNesting.selftest.ts.

// ponytail: VirtualizedListContextResetter is exported by the installed
// @react-native/virtualized-lists (react-native's own pinned dependency, the
// copy RN's lists use) but is missing from its .d.ts, and ScrollView.Context is
// untyped; hence the typed require and cast. Replace with a typed import if RN
// publishes either; the selftest fails if the installed export disappears.
type Passthrough = React.ComponentType<{ children: React.ReactNode }>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const VirtualizedListContextResetter: Passthrough = require('@react-native/virtualized-lists').default
  .VirtualizedListContextResetter;
const ScrollViewContext = (ScrollView as unknown as { Context: React.Context<unknown> }).Context;

/** Makes its children a ROOT list: no parent list context, no parent scroller orientation. */
function PaneRoot({ children }: { children: React.ReactNode }) {
  return (
    <VirtualizedListContextResetter>
      {/* Nulled too, as Modal does: the pane bounds and scrolls itself, so RN's
          dev-only "VirtualizedList nested in a plain ScrollView" check (the
          only reader of this context) would be a false alarm here. */}
      <ScrollViewContext.Provider value={null}>{children}</ScrollViewContext.Provider>
    </VirtualizedListContextResetter>
  );
}

type DocStyles = ReturnType<typeof makeStyles>;

/** One grid row. Shared by both layouts so a cell renders identically in each. */
const GridRow = React.memo(function GridRow({
  row, ri, cols, widths, head, s,
}: { row: string[]; ri: number; cols: number; widths: number[]; head: boolean; s: DocStyles }) {
  return (
    <View style={[s.gridRow, head && s.gridHead, !head && ri % 2 === 1 && s.gridAlt]}>
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
});

function Grid({
  rows, header, s, maxWidth, zoom, paneHeight,
}: { rows: string[][]; header: boolean; s: DocStyles; maxWidth: number; zoom: number; paneHeight: number }) {
  const cols = useMemo(() => gridCols(rows), [rows]);
  // Lengths are measured once per sheet; a pinch only rescales them.
  const longest = useMemo(() => longestCells(rows, cols), [rows, cols]);
  const widths = useMemo(() => columnWidths(longest, zoom), [longest, zoom]);
  const total = sumWidths(widths);
  const plan = gridPlan(rows.length, header, total, maxWidth);
  const body = useMemo(() => rows.slice(plan.pinned), [rows, plan.pinned]);

  const renderRow = useCallback(
    ({ item, index }: { item: string[]; index: number }) => {
      const ri = index + plan.pinned;
      return <GridRow row={item} ri={ri} cols={cols} widths={widths} head={header && ri === 0} s={s} />;
    },
    [plan.pinned, cols, widths, header, s],
  );

  const grid = (
    <View style={[s.grid, { minWidth: Math.min(total, maxWidth) }]}>
      {plan.virtual ? (
        <>
          {plan.pinned === 1 && <GridRow row={rows[0]} ri={0} cols={cols} widths={widths} head s={s} />}
          <PaneRoot>
            <GHFlatList
              data={body}
              renderItem={renderRow}
              keyExtractor={rowKey}
              // Fixed width = the column sum, so the pane never relies on the
              // horizontal scroller's content to size a vertical list.
              style={{ width: total, maxHeight: paneHeight }}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              initialNumToRender={30}
              maxToRenderPerBatch={30}
              windowSize={7}
            />
          </PaneRoot>
        </>
      ) : (
        rows.map((row, ri) => (
          <GridRow key={ri} row={row} ri={ri} cols={cols} widths={widths} head={header && ri === 0} s={s} />
        ))
      )}
    </View>
  );

  if (!plan.wide) return grid;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator directionalLockEnabled nestedScrollEnabled>
      {grid}
    </ScrollView>
  );
}

const rowKey = (_: string[], i: number) => String(i);

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

/** Scroll past the last block. Hoisted: inline, it was a new element every render. */
const PAGE_TAIL = <View style={{ height: 28 }} />;

export function DocView({ blocks, colors }: { blocks: Block[]; colors: Palette }) {
  const [zoom, setZoom] = useState(1);
  const s = useMemo(() => makeStyles(colors, zoom), [colors, zoom]);
  const { width, height } = useWindowDimensions();
  const maxWidth = width - 36;   // the page padding below, both sides
  const paneHeight = rowPaneHeight(height);

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
    <GHFlatList
      // Paint the page explicitly. Inheriting whatever surface the host happens
      // to have is how this shipped as near-white text on a white background —
      // present, correct, and unreadable.
      style={[{ flex: 1 }, { backgroundColor: colors.bg }]}
      contentContainerStyle={s.page}
      showsVerticalScrollIndicator
      data={blocks}
      keyExtractor={(_, i) => String(i)}
      // Nothing here is memoised — renderItem is a fresh arrow every render, so
      // CellRenderer's PureComponent check already fails. extraData is kept
      // because it is the documented way to say "the rows depend on this" and
      // costs nothing; it is not what makes a pinch repaint.
      extraData={zoom}
      // No removeClippedSubviews: it blanks the horizontal Grid scrollers on
      // Android. No getItemLayout either — block heights vary wildly.
      windowSize={5}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      ListFooterComponent={PAGE_TAIL}
      renderItem={({ item: b }) => {
        switch (b.t) {
          case 'h':
            return <Runs runs={b.runs} style={[s.h, b.level === 1 ? s.h1 : b.level === 2 ? s.h2 : s.h3]} />;

          case 'p':
            return <Runs runs={b.runs} style={s.p} />;

          case 'li':
            return (
              <View style={[s.liRow, { marginLeft: 4 + Math.min(b.level, 4) * 16 }]}>
                <Text style={s.bullet}>{b.level % 2 === 0 ? '•' : '◦'}</Text>
                <Runs runs={b.runs} style={[s.p, s.liTxt]} />
              </View>
            );

          case 'table':
            return (
              <View style={s.blockGap}>
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} maxWidth={maxWidth} zoom={zoom} paneHeight={paneHeight} />
              </View>
            );

          case 'sheet':
            return (
              <View style={s.blockGap}>
                <View style={s.sheetTab}>
                  <Text style={s.sheetName} numberOfLines={1}>{b.name}</Text>
                  <Text style={s.sheetMeta}>
                    {b.rows.length} row{b.rows.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} maxWidth={maxWidth} zoom={zoom} paneHeight={paneHeight} />
              </View>
            );

          case 'slide':
            return (
              <View style={s.slide}>
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
              <View style={s.pageBreak}>
                <View style={s.pageRule} />
                <Text style={s.pageTxt}>Page {b.n}</Text>
                <View style={s.pageRule} />
              </View>
            );

          default:
            return null;
        }
      }}
    />
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
  // Faint ink stripe. It was `c.glassSoft + '55'`, which on an rgba() token is
  // not a colour at all, so the stripes never drew.
  gridAlt:  { backgroundColor: c.glass },
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
