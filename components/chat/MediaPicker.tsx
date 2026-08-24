// components/chat/MediaPicker.tsx — one panel for stickers, emoji and GIFs.
//
// WHAT THIS REPLACES
// ------------------
// Three separate things reached three different ways:
//   * emoji   — an inline EmojiPanel toggled by the 😊 button
//   * GIFs    — a dimmed bottom sheet behind its own button
//   * stickers— app/stickers.tsx, a whole ROUTE that navigated AWAY from the
//               conversation, sent, and navigated back
//
// The sticker screen is the one that mattered: leaving the chat to send a
// sticker loses your scroll position and your draft, which is why nobody used
// it. All three now live in one panel behind one button, and the button is a
// sticker, opening on stickers — the fastest path to the thing that was
// previously the slowest.
//
// The emoji tab INSERTS into the draft; stickers and GIFs SEND immediately.
// That asymmetry is deliberate and matches every messenger: an emoji is part of
// a sentence, a sticker is the whole message.

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import GifPicker from '../GifPicker';

export type PickerTab = 'stickers' | 'emoji' | 'gif';

// Carried over verbatim from app/stickers.tsx. "Stickers" are Unicode glyphs
// rendered large, not image assets — which is why they can live in one array
// with no loader, and why the emoji tab below can share the same cell.
const PACKS: { id: string; name: string; stickers: string[] }[] = [
  { id: 'emotions',  name: 'Emotions',     stickers: ['😀','😂','🥰','😎','🤔','😱','🥳','😴','🤗','😤','🥺','😈','👻','💀','🤖','👽','🥹','😮‍💨','🫠','🫡'] },
  { id: 'reactions', name: 'Reactions',    stickers: ['👍','👎','❤️','🔥','💯','🎉','💪','🙏','👀','🤝','✅','❌','⚡','🚀','💎','🏆','🫶','🤌','👏','🫡'] },
  { id: 'animals',   name: 'Animals',      stickers: ['🐶','🐱','🦁','🐻','🐼','🦊','🐸','🦄','🐳','🦋','🐙','🦅','🐧','🐨','🦈','🐝','🦒','🐢','🦉','🦥'] },
  { id: 'food',      name: 'Food & Drink', stickers: ['🍕','🍔','🌮','🍣','🍩','☕','🍺','🧃','🍰','🍟','🥗','🍜','🍗','🍿','🧁','🥤','🥑','🍓','🍑','🥨'] },
  { id: 'travel',    name: 'Travel',       stickers: ['✈️','🏖️','🗻','🌍','🏕️','🚗','🚀','🏠','🌅','🎢','🗼','⛺','🚢','🏔️','🌴','🎡','🚆','🏨','🗽','🎫'] },
  { id: 'vault',     name: 'VaultChat',    stickers: ['🔐','🛡️','👁️‍🗨️','🔒','🕵️','💂','🔑','🧬','📡','🛰️','⚔️','🗡️','🏴‍☠️','🎯','🔮','💠','🔓','🪪','⚙️','🚨'] },
];

const EMOJIS: string[] = (
  '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 ' +
  '🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 ' +
  '😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 ' +
  '👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤝 🙏 ✌️ 🤞 🫶 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ 🖐️ ✋ 🖖 👋 🤙 💪 ' +
  '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 🔥 ✨ ⭐ 🌟 💫 ⚡ 💥 🎉 🎊 🎈 🎁'
).split(' ').filter(Boolean);

interface Props {
  /** Insert into the draft — emoji tab only. */
  onPickEmoji: (e: string) => void;
  /** Send as a standalone type='sticker' message. */
  onSendSticker: (glyph: string) => void;
  /** Send as a GIF message (same signature the old sheet used). */
  onSendGif: (url: string, preview: string) => void;
  onClose: () => void;
  /** Stickers first — the whole point of the merge. */
  initialTab?: PickerTab;
}

export default function MediaPicker({
  onPickEmoji, onSendSticker, onSendGif, onClose, initialTab = 'stickers',
}: Props) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [tab, setTab] = useState<PickerTab>(initialTab);

  // Tile size is derived from the ACTUAL window width, not a module-level
  // Dimensions.get() snapshot like the old sticker screen used. That snapshot is
  // taken once at import and never updates, so it was wrong on every rotation
  // and on every foldable — and on a narrow phone it produced tiles wide enough
  // to push the last column off-screen.
  const cols = width < 360 ? 6 : width < 420 ? 7 : 8;
  const tile = Math.floor((width - 24 - (cols - 1) * 6) / cols);

  const TABS: { id: PickerTab; label: string }[] = [
    { id: 'stickers', label: 'Stickers' },
    { id: 'emoji',    label: 'Emoji' },
    { id: 'gif',      label: 'GIF' },
  ];

  return (
    <View style={s.panel}>
      <View style={s.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[s.tab, tab === t.id && s.tabOn]}
            activeOpacity={0.7}
          >
            <Text style={[s.tabTxt, tab === t.id && s.tabTxtOn]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={onClose} style={s.closeBtn} activeOpacity={0.7} hitSlop={8}>
          <Ionicons name="chevron-down" size={20} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {tab === 'stickers' && (
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {PACKS.map(pack => (
            <View key={pack.id}>
              <Text style={s.packName}>{pack.name}</Text>
              <View style={s.grid}>
                {pack.stickers.map((g, i) => (
                  <TouchableOpacity
                    key={`${pack.id}-${i}`}
                    style={[s.cell, { width: tile, height: tile }]}
                    onPress={() => onSendSticker(g)}
                    activeOpacity={0.6}
                  >
                    <Text style={{ fontSize: Math.round(tile * 0.62) }}>{g}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {tab === 'emoji' && (
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={s.grid}>
            {EMOJIS.map((e, i) => (
              <TouchableOpacity
                key={`${e}-${i}`}
                style={[s.cell, { width: tile, height: tile }]}
                onPress={() => onPickEmoji(e)}
                activeOpacity={0.6}
              >
                <Text style={{ fontSize: Math.round(tile * 0.58) }}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Always mounted `visible` — the tab IS the visibility. Reusing the real
          GifPicker keeps one Klipy call site, including its attribution mark. */}
      {tab === 'gif' && (
        <GifPicker embedded visible onClose={onClose} onSelect={onSendGif} />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  // Fixed height, not flex: the panel stands in for the keyboard, so it must be
  // about a keyboard tall. Letting it flex made it swallow the message list.
  panel:     { height: 300, backgroundColor: c.surfaceSolid, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  tabBar:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  tab:       { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16 },
  tabOn:     { backgroundColor: c.primary },
  tabTxt:    { fontSize: 13, fontWeight: '700', color: c.textDim },
  tabTxtOn:  { color: '#fff' },
  closeBtn:  { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  scroll:    { paddingHorizontal: 12, paddingVertical: 8 },
  packName:  { fontSize: 12, fontWeight: '800', color: c.textDim, marginTop: 6, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell:      { alignItems: 'center', justifyContent: 'center' },
});

/** The composer button that opens this panel. Sticker, not a smiley. */
export function MediaPickerButton({ open, onPress, size = 24, color }: {
  open: boolean; onPress: () => void; size?: number; color: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} hitSlop={8}>
      <MaterialCommunityIcons name={open ? 'sticker' : 'sticker-emoji'} size={size} color={color} />
    </TouchableOpacity>
  );
}
