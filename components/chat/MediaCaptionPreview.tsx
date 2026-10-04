// components/chat/MediaCaptionPreview.tsx — the full-screen send preview for
// staged media (gallery multi-pick, camera, video note, edited photo, scan):
// per-item caption and view-once, thumbnail strip, add more, send. Moved out of
// app/chat.tsx unchanged; the staged items are the screen's state.

import { ActivityIndicator, Image, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ResizeMode, Video } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { brandAlpha } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { KeyboardSafe } from '../ui/KeyboardSafe';

export type PendingItem = {
  uri: string; mediaType: 'image' | 'video' | 'file'; filename: string; mime: string;
  viewOnce: boolean; metaExtra: Record<string, any>; caption: string;
};

export function MediaCaptionPreview({
  pendingItems, setPendingItems, currentIdx, setCurrentIdx, updateCurrentItem, removePendingAt,
  addMorePhotos, confirmSendPendingMedia, sending,
}: {
  pendingItems: PendingItem[];
  setPendingItems: (items: PendingItem[]) => void;
  currentIdx: number;
  setCurrentIdx: (i: number) => void;
  updateCurrentItem: (patch: Partial<{ caption: string; viewOnce: boolean }>) => void;
  removePendingAt: (idx: number) => void;
  addMorePhotos: () => void;
  confirmSendPendingMedia: () => void;
  sending: boolean;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // The dark scrims ('#00000088', '#000000aa') and white glyphs below sit ON
  // the media, which is shown edge to edge, so they stay fixed in both themes.
  return (
    <Modal
      visible={pendingItems.length > 0}
      transparent={false}
      animationType="slide"
      onRequestClose={() => setPendingItems([])}
    >
      {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-18): behavior
          'padding' is measured against the ACTIVITY, and a React Native
          <Modal> is its own Android window that never receives the
          manifest's adjustResize — so the keyboard covered the caption
          field and the send button outright. keyboardOnly: the send row
          below already applies its own bottom inset. */}
      <KeyboardSafe
        keyboardOnly
        style={{ flex: 1, backgroundColor: colors.bg }}
      >
        {(() => {
          const cur = pendingItems[currentIdx];
          if (!cur) return null;
          const multi = pendingItems.length > 1;
          return (
            <>
              <TouchableOpacity
                onPress={() => setPendingItems([])} accessibilityRole="button" accessibilityLabel="Discard all attachments"
                hitSlop={12}
                style={{ position: 'absolute', top: insets.top + 12, left: 16, zIndex: 2, width: 40, height: 40, borderRadius: 20, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="close" size={26} color="#fff" />
              </TouchableOpacity>
              {multi && (
                <View style={{ position: 'absolute', top: insets.top + 18, right: 16, zIndex: 2, backgroundColor: '#00000088', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 }}>
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{currentIdx + 1} / {pendingItems.length}</Text>
                </View>
              )}

              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                {cur.mediaType === 'file' ? (
                  <View style={{ alignItems: 'center', gap: 12, paddingHorizontal: 32 }}>
                    <View style={{ width: 96, height: 96, borderRadius: 24, backgroundColor: brandAlpha(0.13), alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="document-text" size={44} color={colors.primary} />
                    </View>
                    <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center' }} numberOfLines={2}>{cur.filename}</Text>
                    <Text style={{ color: colors.textDim, fontSize: 13 }}>Scanned document</Text>
                  </View>
                ) : cur.mediaType === 'image' ? (
                  <Image source={{ uri: cur.uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                ) : (
                  <Video
                    source={{ uri: cur.uri }}
                    style={{ width: '100%', height: '100%' }}
                    resizeMode={ResizeMode.CONTAIN}
                    useNativeControls
                    shouldPlay
                    isLooping
                  />
                )}
                {cur.viewOnce && (
                  <View style={{ position: 'absolute', top: insets.top + 64, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: brandAlpha(0.2), paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 }}>
                    <Ionicons name="eye" size={14} color={colors.primary} />
                    <Text style={{ color: colors.primary, fontWeight: '700' }}>View once</Text>
                  </View>
                )}
              </View>

              {/* Thumbnail strip (multi-select) */}
              {multi && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 76, backgroundColor: colors.bg }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 10, gap: 8, paddingVertical: 8 }}>
                  {pendingItems.map((it, i) => (
                    <TouchableOpacity key={`${it.uri}-${i}`} activeOpacity={0.8} onPress={() => setCurrentIdx(i)}
                      accessibilityRole="button"
                      accessibilityLabel={`Attachment ${i + 1} of ${pendingItems.length}`}
                      accessibilityState={{ selected: i === currentIdx }}
                      style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: i === currentIdx ? colors.primary : 'transparent' }}>
                      {it.mediaType === 'file'
                        ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceSolid }}>
                            <Ionicons name="document-text" size={22} color={colors.text} />
                          </View>
                        : <Image source={{ uri: it.uri }} style={{ width: '100%', height: '100%' }} />}
                      <TouchableOpacity onPress={() => removePendingAt(i)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Remove attachment ${i + 1}`}
                        style={{ position: 'absolute', top: 1, right: 1, width: 18, height: 18, borderRadius: 9, backgroundColor: '#000000aa', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="close" size={12} color="#fff" />
                      </TouchableOpacity>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={addMorePhotos} accessibilityRole="button" accessibilityLabel="Add more photos" style={{ width: 56, height: 56, borderRadius: 8, borderWidth: 1, borderColor: colors.glassStroke, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="add" size={26} color={colors.text} />
                  </TouchableOpacity>
                </ScrollView>
              )}

              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: Math.max(insets.bottom, 14), backgroundColor: colors.bg }}>
                {/* Per-item view-once toggle (WhatsApp "1-in-a-circle") */}
                <TouchableOpacity
                  onPress={() => updateCurrentItem({ viewOnce: !cur.viewOnce })}
                  disabled={cur.mediaType === 'file'}
                  accessibilityRole="switch"
                  accessibilityLabel="View once"
                  accessibilityState={{ checked: !!cur.viewOnce, disabled: cur.mediaType === 'file' }}
                  style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: cur.viewOnce ? colors.primary : colors.surfaceSolid, alignItems: 'center', justifyContent: 'center', opacity: cur.mediaType === 'file' ? 0.4 : 1 }}
                  hitSlop={6}
                >
                  <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.glassStroke, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: cur.viewOnce ? '#fff' : colors.text, fontSize: 12, fontWeight: '800' }}>1</Text>
                  </View>
                </TouchableOpacity>
                <TextInput
                  value={cur.caption}
                  onChangeText={(t) => updateCurrentItem({ caption: t })}
                  placeholder="Add a caption…"
                  accessibilityLabel={multi ? `Caption for attachment ${currentIdx + 1}` : 'Caption'}
                  placeholderTextColor={colors.textFaint}
                  multiline
                  style={{ flex: 1, color: colors.text, backgroundColor: colors.surfaceSolid, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 16 }}
                />
                <TouchableOpacity
                  onPress={confirmSendPendingMedia}
                  disabled={sending}
                  accessibilityRole="button"
                  accessibilityLabel={multi ? `Send ${pendingItems.length} attachments` : 'Send attachment'}
                  accessibilityState={{ disabled: sending, busy: sending }}
                  style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.6 : 1 }}
                >
                  {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={22} color="#fff" />}
                  {multi && !sending && (
                    <View style={{ position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: colors.glassStroke }}>
                      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{pendingItems.length}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>
            </>
          );
        })()}
      </KeyboardSafe>
    </Modal>
  );
}
