// components/office/DeckView.tsx
// Native PowerPoint (.pptx) viewing — slides, thumbnails and speaker notes,
// parsed on-device. The deck never leaves the vault.

import React, { useRef, useState } from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_ACCENT } from '../../constants/theme';
import type { DeckData, SlideData } from '../../lib/office/types';

const { width: SW } = Dimensions.get('window');

const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.60)',
  faint: 'rgba(255,255,255,0.30)',
  line: 'rgba(255,255,255,0.10)',
  accent: BRAND_ACCENT,
  accentLine: 'rgba(124,77,255,0.45)',
  panel: 'rgba(255,255,255,0.04)',
};

function Slide({ slide, width }: { slide: SlideData; width: number }) {
  return (
    <LinearGradient
      colors={['#16142A', '#100E1D', '#0A0913']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[s.slide, { width, height: (width * 9) / 16 }]}
    >
      {slide.title ? (
        <Text style={s.slideTitle} numberOfLines={3}>
          {slide.title}
        </Text>
      ) : null}
      {slide.body.slice(0, 5).map((line, i) => (
        <Text key={i} style={s.slideBody} numberOfLines={2}>
          {line}
        </Text>
      ))}
      <View style={s.slideFoot}>
        {slide.hasMedia ? (
          <View style={s.mediaChip}>
            <Ionicons name="play" size={10} color={C.accent} />
            <Text style={s.mediaText}>media</Text>
          </View>
        ) : (
          <View />
        )}
        <Text style={s.slideNum}>{slide.index}</Text>
      </View>
    </LinearGradient>
  );
}

export default function DeckView({ deck }: { deck: DeckData }) {
  const [current, setCurrent] = useState(0);
  const railRef = useRef<ScrollView>(null);
  const slide = deck.slides[current];

  const stageW = SW - 32;

  return (
    <View style={s.fill}>
      <ScrollView contentContainerStyle={s.body}>
        <Slide slide={slide} width={stageW} />

        <View style={s.navRow}>
          <TouchableOpacity
            disabled={current === 0}
            onPress={() => setCurrent((i) => Math.max(0, i - 1))}
            style={[s.navBtn, current === 0 && s.navOff]}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-back" size={18} color={current === 0 ? C.faint : C.text} />
          </TouchableOpacity>
          <Text style={s.navText}>
            {current + 1} / {deck.slides.length}
          </Text>
          <TouchableOpacity
            disabled={current === deck.slides.length - 1}
            onPress={() => setCurrent((i) => Math.min(deck.slides.length - 1, i + 1))}
            style={[s.navBtn, current === deck.slides.length - 1 && s.navOff]}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-forward" size={18} color={current === deck.slides.length - 1 ? C.faint : C.text} />
          </TouchableOpacity>
        </View>

        {/* Thumbnail rail */}
        <ScrollView
          ref={railRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.rail}
        >
          {deck.slides.map((sl, i) => (
            <TouchableOpacity key={sl.index} onPress={() => setCurrent(i)} activeOpacity={0.85}>
              <View style={[s.thumbWrap, i === current && s.thumbOn]}>
                <Slide slide={sl} width={104} />
              </View>
              <Text style={[s.thumbNum, i === current && s.thumbNumOn]}>{sl.index}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Speaker notes */}
        <View style={s.notes}>
          <View style={s.notesHead}>
            <Ionicons name="document-text-outline" size={15} color={C.accent} />
            <Text style={s.notesTitle}>Speaker notes</Text>
            <Text style={s.notesSlide}>Slide {slide.index}</Text>
          </View>
          <Text style={s.notesBody}>
            {slide.notes ?? 'No notes on this slide.'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, paddingBottom: 48 },

  slide: {
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
    justifyContent: 'flex-start',
  },
  slideTitle: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.4, marginBottom: 10 },
  slideBody: { color: C.dim, fontSize: 12.5, lineHeight: 18, marginBottom: 4 },
  slideFoot: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  slideNum: { color: C.faint, fontSize: 10 },
  mediaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.accentLine,
  },
  mediaText: { color: C.accent, fontSize: 9, fontWeight: '700' },

  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 14 },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
  },
  navOff: { opacity: 0.4 },
  navText: { color: C.text, fontSize: 13.5, fontWeight: '700', fontVariant: ['tabular-nums'] },

  rail: { gap: 10, paddingVertical: 16, paddingHorizontal: 2 },
  thumbWrap: { borderRadius: 9, borderWidth: 2, borderColor: 'transparent', overflow: 'hidden' },
  thumbOn: { borderColor: C.accent },
  thumbNum: { color: C.faint, fontSize: 10, textAlign: 'center', marginTop: 4 },
  thumbNumOn: { color: C.accent, fontWeight: '700' },

  notes: {
    marginTop: 4,
    padding: 16,
    borderRadius: 14,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.line,
  },
  notesHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  notesTitle: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  notesSlide: { color: C.faint, fontSize: 11, marginLeft: 'auto' },
  notesBody: { color: C.dim, fontSize: 13.5, lineHeight: 21 },
});
