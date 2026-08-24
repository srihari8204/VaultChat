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

import React, { useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import type { Block, Run } from '../lib/docBlocks';
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
function columnWidths(rows: string[][], cols: number): number[] {
  const w: number[] = new Array(cols).fill(0);
  for (const r of rows) {
    for (let c = 0; c < cols; c++) {
      const len = (r[c] ?? '').length;
      if (len > w[c]) w[c] = len;
    }
  }
  return w.map(len => Math.max(64, Math.min(220, 12 + len * 8)));
}

function Grid({
  rows, header, s, colors, maxWidth,
}: { rows: string[][]; header: boolean; s: any; colors: Palette; maxWidth: number }) {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const widths = useMemo(() => columnWidths(rows, cols), [rows, cols]);
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
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const maxWidth = width - 36;   // the page padding below, both sides

  return (
    <ScrollView
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
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} colors={colors} maxWidth={maxWidth} />
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
                <Grid rows={b.rows} header={looksLikeHeader(b.rows)} s={s} colors={colors} maxWidth={maxWidth} />
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
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  page: { padding: 18, paddingBottom: 8 },

  h:   { color: c.text, fontWeight: '800', marginTop: 18, marginBottom: 6 },
  h1:  { fontSize: 22, lineHeight: 29 },
  h2:  { fontSize: 18, lineHeight: 25 },
  h3:  { fontSize: 16, lineHeight: 22 },
  p:   { color: c.text, fontSize: 15, lineHeight: 23, marginBottom: 9 },

  liRow:  { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 5 },
  bullet: { color: c.textDim, fontSize: 15, lineHeight: 23, width: 18 },
  liTxt:  { flex: 1, marginBottom: 0 },

  blockGap: { marginTop: 8, marginBottom: 16 },

  grid:     { borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: 'hidden' },
  gridRow:  { flexDirection: 'row' },
  gridHead: { backgroundColor: c.surface },
  gridAlt:  { backgroundColor: c.surface + '55' },
  gridCell: { paddingHorizontal: 9, paddingVertical: 7,
              borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.border,
              borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  gridTxt:      { color: c.text, fontSize: 13, lineHeight: 18 },
  gridHeadTxt:  { fontWeight: '800', color: c.text },

  sheetTab:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
               gap: 10, marginBottom: 7 },
  sheetName: { color: c.text, fontSize: 14, fontWeight: '800', flexShrink: 1 },
  sheetMeta: { color: c.textFaint, fontSize: 12 },

  slide:      { borderWidth: 1, borderColor: c.border, borderRadius: 12,
                padding: 14, marginBottom: 14, backgroundColor: c.card },
  slideHead:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  slideNum:   { width: 24, height: 24, borderRadius: 12, backgroundColor: c.surface,
                alignItems: 'center', justifyContent: 'center' },
  slideNumTxt:{ color: c.textDim, fontSize: 12, fontWeight: '800' },
  slideTitle: { color: c.text, fontSize: 17, fontWeight: '800', flex: 1, lineHeight: 23 },

  pageBreak: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20, marginBottom: 14 },
  pageRule:  { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  pageTxt:   { color: c.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
});

export default DocView;
