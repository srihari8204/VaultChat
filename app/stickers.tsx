// app/stickers.tsx — Sticker picker (Postgres).
//
// Receives ?chatId in the route params. Tap a sticker → POST it as a
// type='sticker' message and pop back to the chat. The send goes through
// lib/chatService.sendMessage so the optimistic update / encryption seam
// / push notification path are all reused.
//
// "Stickers" today are just Unicode emoji — pre-defined 6 packs. The
// previous version managed Firestore-backed custom packs; that's been
// dropped for MVP (re-add as a Phase-2 user-content feature).

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View, useWindowDimensions } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { sendMessage } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';


interface Pack {
  id:       string;
  name:     string;
  stickers: string[];
}
const PACKS: Pack[] = [
  { id: 'emotions',  name: 'Emotions',  stickers: ['😀','😂','🥰','😎','🤔','😱','🥳','😴','🤗','😤','🥺','😈','👻','💀','🤖','👽','🥹','😮‍💨','🫠','🫡'] },
  { id: 'reactions', name: 'Reactions', stickers: ['👍','👎','❤️','🔥','💯','🎉','💪','🙏','👀','🤝','✅','❌','⚡','🚀','💎','🏆','🫶','🤌','👏','🫡'] },
  { id: 'animals',   name: 'Animals',   stickers: ['🐶','🐱','🦁','🐻','🐼','🦊','🐸','🦄','🐳','🦋','🐙','🦅','🐧','🐨','🦈','🐝','🦒','🐢','🦉','🦥'] },
  { id: 'food',      name: 'Food & Drink', stickers: ['🍕','🍔','🌮','🍣','🍩','☕','🍺','🧃','🍰','🍟','🥗','🍜','🍗','🍿','🧁','🥤','🥑','🍓','🍑','🥨'] },
  { id: 'travel',    name: 'Travel',    stickers: ['✈️','🏖️','🗻','🌍','🏕️','🚗','🚀','🏠','🌅','🎢','🗼','⛺','🚢','🏔️','🌴','🎡','🚆','🏨','🗽','🎫'] },
  { id: 'vault',     name: 'VaultChat', stickers: ['🔐','🛡️','👁️‍🗨️','🔒','🕵️','💂','🔑','🧬','📡','🛰️','⚔️','🗡️','🏴‍☠️','🎯','🔮','💠','🔓','🪪','⚙️','🚨'] },
];

function useS() {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const {width: SW} = useWindowDimensions();

  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors, SW), [colors, SW]);
}

export default function StickerPickerScreen() {
  // Live metrics owned by THIS component — the hook further up belongs to the
  // useS() style helper, a different scope. Follows rotation and folds.
  const { width: SW } = useWindowDimensions();
  // 8 stickers per row, with padding/gaps factored in.
  const TILE = Math.floor((SW - 32 - 8 * 6) / 8);

  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, peerName } = useLocalSearchParams<{ chatId?: string; peerName?: string }>();
  const [sending, setSending] = useState(false);

  const onPick = useCallback(async (emoji: string, packId: string) => {
    if (!chatId) {
      Alert.alert('No chat context', 'Open this picker from a chat.');
      return;
    }
    if (sending) return;
    setSending(true);
    try {
      await sendMessage(chatId, emoji, 'sticker', {
        meta: { stickerPack: packId },
      });
      router.back();
    } catch (e: any) {
      Alert.alert('Send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [chatId, router, sending]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title}>Stickers</Text>
          {peerName ? <Text style={S.sub}>to {peerName}</Text> : null}
        </View>
        {sending && <ActivityIndicator color={colors.primary} />}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {PACKS.map(pack => (
          <View key={pack.id} style={S.packBlock}>
            <Text numberOfLines={1} style={S.packName}>{pack.name}</Text>
            <View style={S.grid}>
              {pack.stickers.map(s => (
                <TouchableOpacity
                  key={s}
                  style={[S.tile, { width: TILE, height: TILE }]}
                  onPress={() => onPick(s, pack.id)}
                  disabled={sending}
                  activeOpacity={0.7}
                >
                  <Text style={S.tileEmoji}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}


// Width/height are threaded in from useWindowDimensions() rather than read
// from a module-level Dimensions.get(): orientation is 'default', so a frozen
// value survived rotation, folds and split-screen resizes.
const makeStyles = (c: Palette, SW: number) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:      { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:      { color: c.text, fontSize: 26, fontWeight: '600' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },
  sub:          { color: c.textDim, fontSize: 12 },

  packBlock:    { marginBottom: 24 },
  packName:     { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 10 },
  grid:         { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile:         { backgroundColor: c.glassSoft, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.glassStroke },
  tileEmoji:    { fontSize: 28 },
});
