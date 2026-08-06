// components/office/SpreadsheetView.tsx
// Native spreadsheet rendering for .xlsx/.xls — parsed and drawn on-device.
// Nothing is uploaded: the workbook is decoded from the local file in memory.

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BRAND_ACCENT } from '../../constants/theme';
import { cellRef, columnLabel, formatCell, isNumeric } from '../../lib/office/xlsx';
import type { SheetData, WorkbookData } from '../../lib/office/types';

const ROW_H = 34;
const ROW_HEAD_W = 46;
const COL_W = 118;

const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.28)',
  line: 'rgba(255,255,255,0.08)',
  head: 'rgba(255,255,255,0.05)',
  accent: BRAND_ACCENT,
  accentSoft: 'rgba(124,77,255,0.16)',
  accentLine: 'rgba(124,77,255,0.45)',
  panel: 'rgba(255,255,255,0.04)',
};

interface Props {
  workbook: WorkbookData;
}

export default function SpreadsheetView({ workbook }: Props) {
  const visible = useMemo(() => workbook.sheets.filter((s) => !s.hidden), [workbook.sheets]);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);

  const sheet: SheetData | undefined = visible[active];
  if (!sheet) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyText}>This workbook has no visible sheets.</Text>
      </View>
    );
  }

  const headerRow = sheet.rows[0] ?? [];
  const bodyRows = sheet.rows.slice(1);
  const selectedRef = selected ? cellRef(selected.r, selected.c) : null;
  const selectedValue = selected ? sheet.rows[selected.r]?.[selected.c] ?? null : null;
  const selectedFormula = selectedRef ? sheet.formulas[selectedRef] : undefined;

  return (
    <View style={s.fill}>
      {/* Formula bar — shows the real formula behind the selected cell */}
      <View style={s.formulaBar}>
        <View style={s.refBox}>
          <Text style={s.refText}>{selectedRef ?? '—'}</Text>
        </View>
        <Text style={s.fx}>fx</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.formulaScroll}>
          <Text style={s.formulaText} numberOfLines={1}>
            {selectedFormula
              ? `=${selectedFormula}`
              : selectedValue !== null
                ? formatCell(selectedValue)
                : 'Tap a cell'}
          </Text>
        </ScrollView>
      </View>

      {/* Grid: vertical scroll outside, horizontal inside, so the row header
          column and the frozen header row stay where the user expects. */}
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator>
        <View>
          {/* Column letters */}
          <View style={s.row}>
            <View style={[s.cell, s.colHead, { width: ROW_HEAD_W }]} />
            {headerRow.map((_, c) => (
              <View
                key={`col-${c}`}
                style={[s.cell, s.colHead, { width: COL_W }, selected?.c === c && s.headOn]}
              >
                <Text style={[s.colHeadText, selected?.c === c && s.headOnText]}>{columnLabel(c)}</Text>
              </View>
            ))}
          </View>

          {/* Frozen header row */}
          <View style={s.row}>
            <View style={[s.cell, s.rowHead, { width: ROW_HEAD_W }]}>
              <Text style={s.rowHeadText}>1</Text>
            </View>
            {headerRow.map((v, c) => (
              <View key={`h-${c}`} style={[s.cell, s.frozenHead, { width: COL_W }]}>
                <Text style={s.frozenHeadText} numberOfLines={1}>
                  {formatCell(v)}
                </Text>
              </View>
            ))}
          </View>

          <ScrollView bounces={false} showsVerticalScrollIndicator style={s.bodyScroll}>
            {bodyRows.map((row, ri) => {
              const rowIndex = ri + 1; // header consumed row 0
              return (
                <View key={`r-${rowIndex}`} style={s.row}>
                  <View
                    style={[s.cell, s.rowHead, { width: ROW_HEAD_W }, selected?.r === rowIndex && s.headOn]}
                  >
                    <Text style={[s.rowHeadText, selected?.r === rowIndex && s.headOnText]}>
                      {rowIndex + 1}
                    </Text>
                  </View>
                  {row.map((v, c) => {
                    const on = selected?.r === rowIndex && selected?.c === c;
                    const frozenCol = c < sheet.frozenCols;
                    return (
                      <TouchableOpacity
                        key={`c-${rowIndex}-${c}`}
                        activeOpacity={0.7}
                        onPress={() => setSelected({ r: rowIndex, c })}
                        style={[s.cell, { width: COL_W }, frozenCol && s.frozenCol, on && s.selected]}
                      >
                        <Text
                          style={[s.cellText, isNumeric(v) && s.numeric, frozenCol && s.frozenColText]}
                          numberOfLines={1}
                        >
                          {formatCell(v)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </ScrollView>

      {/* Sheet tabs, including a count of anything hidden in the workbook */}
      <View style={s.tabBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabs}>
          {visible.map((sh, i) => (
            <TouchableOpacity
              key={sh.name}
              onPress={() => {
                setActive(i);
                setSelected(null);
              }}
              style={[s.tab, i === active && s.tabOn]}
              activeOpacity={0.8}
            >
              <Text style={[s.tabText, i === active && s.tabTextOn]} numberOfLines={1}>
                {sh.name}
              </Text>
            </TouchableOpacity>
          ))}
          {workbook.hiddenSheetNames.length > 0 && (
            <View style={s.hiddenChip}>
              <Ionicons name="eye-off-outline" size={12} color={C.faint} />
              <Text style={s.hiddenText}>
                {workbook.hiddenSheetNames.length} hidden
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: C.dim, fontSize: 14 },

  formulaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  refBox: {
    minWidth: 64,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.accentLine,
    backgroundColor: C.panel,
  },
  refText: { color: C.text, fontSize: 12, fontVariant: ['tabular-nums'], textAlign: 'center' },
  fx: { color: C.accent, fontSize: 13, fontStyle: 'italic', fontWeight: '700' },
  formulaScroll: { flex: 1 },
  formulaText: { color: C.text, fontSize: 13, fontFamily: Platform_mono() },

  row: { flexDirection: 'row' },
  bodyScroll: { maxHeight: undefined },
  cell: {
    height: ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  cellText: { color: C.text, fontSize: 12.5 },
  numeric: { textAlign: 'right', fontVariant: ['tabular-nums'] },

  colHead: { backgroundColor: C.head, alignItems: 'center' },
  colHeadText: { color: C.faint, fontSize: 11, fontWeight: '700' },
  rowHead: { backgroundColor: C.head, alignItems: 'center' },
  rowHeadText: { color: C.faint, fontSize: 11, fontWeight: '600' },
  headOn: { backgroundColor: C.accentSoft },
  headOnText: { color: C.accent },

  frozenHead: { backgroundColor: 'rgba(124,77,255,0.10)', borderBottomWidth: 2, borderBottomColor: C.accentLine },
  frozenHeadText: { color: C.text, fontSize: 12, fontWeight: '700' },
  frozenCol: { backgroundColor: 'rgba(124,77,255,0.05)' },
  frozenColText: { fontWeight: '600' },

  selected: {
    backgroundColor: C.accentSoft,
    borderWidth: 2,
    borderColor: C.accent,
  },

  tabBar: { borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8 },
  tabs: { paddingHorizontal: 10, gap: 6, alignItems: 'center' },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: C.panel,
    maxWidth: 160,
  },
  tabOn: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine },
  tabText: { color: C.dim, fontSize: 12.5 },
  tabTextOn: { color: C.accent, fontWeight: '700' },
  hiddenChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.line,
  },
  hiddenText: { color: C.faint, fontSize: 11 },
});

// Monospace family differs per platform; keep the formula bar aligned.
function Platform_mono() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Platform } = require('react-native');
  return Platform.OS === 'ios' ? 'Menlo' : 'monospace';
}
