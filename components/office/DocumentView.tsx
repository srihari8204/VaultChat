// components/office/DocumentView.tsx
// Native Word (.docx) reading — parsed and laid out on-device, never uploaded.

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { BRAND_ACCENT } from '../../constants/theme';
import type { DocBlock, DocRun, DocumentData } from '../../lib/office/types';

const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.62)',
  faint: 'rgba(255,255,255,0.30)',
  line: 'rgba(255,255,255,0.10)',
  accent: BRAND_ACCENT,
  panel: 'rgba(255,255,255,0.04)',
};

const H_SIZE: Record<number, number> = { 1: 25, 2: 21, 3: 18, 4: 16, 5: 15, 6: 14 };

function Runs({ runs, style }: { runs: DocRun[]; style?: any }) {
  return (
    <Text style={style}>
      {runs.map((r, i) => (
        <Text
          key={i}
          style={[
            r.bold ? s.bold : null,
            r.italic ? s.italic : null,
            r.underline ? s.underline : null,
          ]}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Runs
          runs={block.runs}
          style={[s.heading, { fontSize: H_SIZE[block.level] ?? 16 }]}
        />
      );

    case 'listItem':
      return (
        <View style={[s.listRow, { paddingLeft: 8 + block.level * 16 }]}>
          <View style={s.bullet} />
          <Runs runs={block.runs} style={s.body} />
        </View>
      );

    case 'table':
      return (
        <View style={s.table}>
          {block.rows.map((row, ri) => (
            <View key={ri} style={[s.tr, ri === 0 && s.trHead]}>
              {row.map((cell, ci) => (
                <View key={ci} style={s.td}>
                  <Text style={[s.tdText, ri === 0 && s.thText]} numberOfLines={4}>
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );

    case 'paragraph':
    default:
      return <Runs runs={block.runs} style={s.body} />;
  }
}

export default function DocumentView({ doc }: { doc: DocumentData }) {
  return (
    <ScrollView style={s.fill} contentContainerStyle={s.page}>
      <View style={s.meta}>
        <Text style={s.metaText}>
          {doc.wordCount.toLocaleString('en-US')} words · about {doc.approxPages}{' '}
          {doc.approxPages === 1 ? 'page' : 'pages'}
        </Text>
      </View>
      {doc.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
      <View style={s.endRule} />
      <Text style={s.endText}>End of document</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 60 },

  meta: { paddingBottom: 14, marginBottom: 14, borderBottomWidth: 1, borderBottomColor: C.line },
  metaText: { color: C.faint, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase' },

  heading: { color: C.text, fontWeight: '800', letterSpacing: -0.3, marginTop: 22, marginBottom: 8 },
  body: { color: C.dim, fontSize: 15, lineHeight: 24, marginBottom: 12 },
  bold: { fontWeight: '700', color: C.text },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },

  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10, paddingRight: 4 },
  bullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.accent, marginTop: 9 },

  table: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    overflow: 'hidden',
    marginVertical: 14,
  },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.line },
  trHead: { backgroundColor: C.panel },
  td: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRightWidth: 1, borderRightColor: C.line },
  tdText: { color: C.dim, fontSize: 13 },
  thText: { color: C.text, fontWeight: '700', fontSize: 12.5 },

  endRule: { height: 1, backgroundColor: C.line, marginTop: 28, marginBottom: 12 },
  endText: { color: C.faint, fontSize: 11, textAlign: 'center' },
});
