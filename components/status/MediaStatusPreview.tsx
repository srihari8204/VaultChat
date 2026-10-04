// components/status/MediaStatusPreview.tsx — the media status preview and
// caption editor (WhatsApp): the picked photos/videos, a filmstrip to switch
// between them, the lock picker, a caption per item, and Post.
// Moved out of app/(tabs)/status.tsx; the screen keeps the batch and does the
// posting. Media editing is always dark (preview controls and gate labels are
// light ink), so this draws with the dark palette in both themes.
//
// One change in the move: a VIDEO used to be drawn by handing its file to
// <Image>, which shows nothing on most devices. It now shows the still the
// screen extracts for it (`poster`), or a video placeholder until one exists.

import { useMemo } from 'react';
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import GatePicker, { type GateDraft } from './GatePicker';
import { HEADER_TOP, SCREEN_BOTTOM } from '../../constants/layout';
import { AuroraDark } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';

export type PreviewAsset = {
  uri: string; type: 'image' | 'video'; filename: string; mime: string; caption: string;
  width?: number; height?: number;
  /** A still frame of a video, once extracted; never set for an image. */
  poster?: string;
};

const INK = AuroraDark.text;

/** A photo, or a video's still (with a play badge), or a placeholder while there is none. */
function AssetImage({ a, style, badge, S }: { a: PreviewAsset; style: object; badge?: boolean; S: ReturnType<typeof makeStyles> }) {
  const src = a.type === 'image' ? a.uri : a.poster;
  return (
    <View style={[style, S.centered]}>
      {src
        ? <Image source={{ uri: src }} style={StyleSheet.absoluteFill} resizeMode={badge ? 'contain' : 'cover'} />
        : <Ionicons name="videocam-outline" size={badge ? 48 : 20} color={AuroraDark.textDim} />}
      {badge && a.type === 'video' && <View style={S.previewPlay}><Ionicons name="play" size={34} color={INK} /></View>}
    </View>
  );
}

export default function MediaStatusPreview({
  assets, index, onIndex, gate, onGate, onCaption, posting, onPost, onClose,
}: {
  assets: PreviewAsset[]; index: number; onIndex: (i: number) => void;
  gate: GateDraft; onGate: (g: GateDraft) => void;
  onCaption: (text: string) => void;
  posting: boolean; onPost: () => void; onClose: () => void;
}) {
  const { colors } = useTheme();
  const { metrics: m } = useVisionComfort();
  const S = useMemo(() => makeStyles(m, colors.primary), [m, colors.primary]);
  const current = assets[index];

  return (
    <Modal visible={assets.length > 0} transparent={false} animationType="slide" onRequestClose={onClose}>
      <KeyboardSafe keyboardOnly>
      <View style={S.previewScreen}>
        <View style={S.previewBar}>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Discard" accessibilityState={{ disabled: posting }}>
            <Ionicons name="close" size={26} color={INK} />
          </TouchableOpacity>
          {assets.length > 1 && <Text style={S.previewCount}>{index + 1}/{assets.length}</Text>}
          <View style={{ width: 26 }} />
        </View>

        <View style={S.previewMain}>
          {current && <AssetImage a={current} style={S.previewImg} badge S={S} />}
        </View>

        {/* Filmstrip of all selected (tap to switch) */}
        {assets.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.filmstrip} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
            {assets.map((a, i) => (
              <TouchableOpacity key={a.uri} onPress={() => onIndex(i)} style={[S.thumb, i === index && S.thumbOn]}
                accessibilityRole="button" accessibilityLabel={`${a.type === 'video' ? 'Video' : 'Photo'} ${i + 1} of ${assets.length}`} accessibilityState={{ selected: i === index }}>
                <AssetImage a={a} style={S.thumbImg} S={S} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <ScrollView style={S.gateArea} contentContainerStyle={{ padding: 12 }} keyboardShouldPersistTaps="handled">
          <GatePicker
            value={gate}
            onChange={onGate}
            accent={colors.primary}
            text={INK}
            dim="rgba(255,255,255,0.6)"
            surface="rgba(255,255,255,0.08)"
          />
        </ScrollView>

        <View style={S.captionRow}>
          <TextInput
            style={S.captionInput}
            value={current?.caption ?? ''}
            onChangeText={onCaption}
            placeholder="Add a caption…"
            placeholderTextColor="rgba(255,255,255,0.6)"
            multiline
            maxLength={200}
            accessibilityLabel="Caption"
          />
          <TouchableOpacity style={[S.sendFab, posting && { opacity: 0.6 }]} onPress={onPost} disabled={posting} accessibilityRole="button" accessibilityLabel="Post status" accessibilityState={{ disabled: posting, busy: posting }}>
            {posting ? <ActivityIndicator color={colors.onPrimary} /> : <Ionicons name="send" size={22} color={colors.onPrimary} />}
          </TouchableOpacity>
        </View>
      </View>
      </KeyboardSafe>
    </Modal>
  );
}

const makeStyles = (m: ReturnType<typeof useVisionComfort>['metrics'], primary: string) => StyleSheet.create({
  previewScreen:    { flex: 1, backgroundColor: AuroraDark.bg, paddingTop: HEADER_TOP },
  previewBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  previewCount:     { color: INK, fontSize: 14, fontWeight: '700' },
  previewMain:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImg:       { width: '100%', height: '100%' },
  centered:         { alignItems: 'center', justifyContent: 'center' },
  previewPlay:      { position: 'absolute', width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  filmstrip:        { maxHeight: 64, paddingVertical: 8 },
  thumb:            { width: 48, height: 48, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  thumbOn:          { borderColor: AuroraDark.text },
  thumbImg:         { width: '100%', height: '100%' },
  gateArea:         { maxHeight: 260, backgroundColor: 'rgba(0,0,0,0.35)' },
  captionRow:       { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 12, paddingBottom: SCREEN_BOTTOM + 16, paddingTop: 8 },
  captionInput:     { flex: 1, color: INK, fontSize: 16 * m.textScale, maxHeight: 120 * m.textScale, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.12)' },
  sendFab:          { width: 50 * m.controlScale, height: 50 * m.controlScale, borderRadius: 25 * m.controlScale, backgroundColor: primary, alignItems: 'center', justifyContent: 'center' },
});
