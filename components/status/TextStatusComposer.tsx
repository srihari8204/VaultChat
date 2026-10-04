// components/status/TextStatusComposer.tsx — the full-screen text status
// composer (WhatsApp): coloured background, emoji panel, post button.
// Moved out of app/(tabs)/status.tsx unchanged; the screen keeps the text, the
// background and the posting state, and decides what Close means.
//
// The backgrounds are the story's own artwork with white text on top in every
// theme, so the ink here is the always-dark palette's text, not the app theme's.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { HEADER_TOP, SCREEN_BOTTOM } from '../../constants/layout';
import { AuroraDark } from '../../constants/theme';
import { useVisionComfort } from '../../lib/visionComfort';

const INK = AuroraDark.text;
const QUICK_EMOJIS = ['😀','😂','🥰','😍','😎','🤔','😅','😭','😡','👍','🙏','👏','🔥','✨','🎉','❤️','💔','💯','🙌','😴','🥳','😇','🤩','😱','😬','🤗','😉','😏','🤨','😌','💪','👀','🌟','⚡','🌈','☀️','🌙','⭐','💜','💙'];

export default function TextStatusComposer({
  visible, text, onChangeText, bg, onChangeBg, swatches, recentEmojis, onEmoji, posting, onPost, onClose,
}: {
  visible: boolean;
  text: string; onChangeText: (t: string) => void;
  bg: string; onChangeBg: (b: string) => void;
  /** The background choices: the artwork colour and its spoken name. */
  swatches: readonly { color: string; name: string }[];
  recentEmojis: string[]; onEmoji: (e: string) => void;
  posting: boolean; onPost: () => void; onClose: () => void;
}) {
  const { metrics: m } = useVisionComfort();
  const S = useMemo(() => makeStyles(m), [m]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const canPost = !!text.trim() && !posting;

  return (
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onClose}>
      <KeyboardSafe keyboardOnly>
      <View style={[S.textCompose, { backgroundColor: bg }]}>
        <View style={S.textComposeBar}>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel"><Ionicons name="close" size={26} color={INK} /></TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => setEmojiOpen(o => !o)} hitSlop={10} accessibilityRole="button" accessibilityLabel={emojiOpen ? 'Hide emoji' : 'Show emoji'} accessibilityState={{ expanded: emojiOpen }}>
              <Ionicons name={emojiOpen ? 'happy' : 'happy-outline'} size={24} color={INK} />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="radiogroup">
              {swatches.map(({ color: b, name }) => (
                <TouchableOpacity hitSlop={11} key={b} onPress={() => onChangeBg(b)} style={[S.bgSwatch, { backgroundColor: b }, bg === b && S.bgSwatchOn]}
                  accessibilityRole="radio" accessibilityLabel={`${name} background`} accessibilityState={{ checked: bg === b }} />
              ))}
            </View>
          </View>
        </View>
        <TextInput
          style={S.textComposeInput}
          value={text}
          onChangeText={onChangeText}
          placeholder="Type a status"
          placeholderTextColor="rgba(255,255,255,0.6)"
          multiline
          autoFocus={!emojiOpen}
          maxLength={700}
          textAlign="center"
          accessibilityLabel="Status text"
        />

        {/* Emoji picker — recently-used first (WhatsApp), then the full set. */}
        {emojiOpen && (
          <View style={S.emojiPanel}>
            <ScrollView contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
              {recentEmojis.length > 0 && (
                <>
                  <Text style={S.emojiSection}>RECENTLY USED</Text>
                  <View style={S.emojiGrid}>
                    {recentEmojis.map(e => (
                      <TouchableOpacity key={`r-${e}`} onPress={() => onEmoji(e)} style={S.emojiBtn} accessibilityRole="button" accessibilityLabel={`Insert ${e}`}>
                        <Text style={S.emojiTxt}>{e}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={S.emojiSection}>ALL</Text>
                </>
              )}
              <View style={S.emojiGrid}>
                {QUICK_EMOJIS.map(e => (
                  <TouchableOpacity key={e} onPress={() => onEmoji(e)} style={S.emojiBtn} accessibilityRole="button" accessibilityLabel={`Insert ${e}`}>
                    <Text style={S.emojiTxt}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}

        <TouchableOpacity style={[S.textPostBtn, !canPost && { opacity: 0.5 }]} onPress={onPost} disabled={!canPost} accessibilityRole="button" accessibilityLabel="Post status" accessibilityState={{ disabled: !canPost, busy: posting }}>
          {posting ? <ActivityIndicator color={INK} /> : <Ionicons name="send" size={24} color={INK} />}
        </TouchableOpacity>
      </View>
      </KeyboardSafe>
    </Modal>
  );
}

const makeStyles = (m: ReturnType<typeof useVisionComfort>['metrics']) => StyleSheet.create({
  textCompose:      { flex: 1, paddingTop: HEADER_TOP },
  textComposeBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  bgSwatch:         { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  bgSwatchOn:       { borderWidth: 3, borderColor: AuroraDark.text },
  textComposeInput: { flex: 1, color: INK, fontSize: 26 * m.textScale, fontWeight: '700', paddingHorizontal: 24, textAlignVertical: 'center' },
  textPostBtn:      { position: 'absolute', right: 20, bottom: SCREEN_BOTTOM + 20, width: 56 * m.controlScale, height: 56 * m.controlScale, borderRadius: 28 * m.controlScale, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  emojiPanel:       { maxHeight: 200, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 8 },
  emojiGrid:        { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 8 },
  emojiSection:     { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 2 },
  emojiBtn:         { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  emojiTxt:         { fontSize: 28 },
});
