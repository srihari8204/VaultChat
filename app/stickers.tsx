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

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { sendMessage } from '../lib/chatService';

const { width: SW } = Dimensions.get('window');
// 8 stickers per row, with padding/gaps factored in
const TILE = Math.floor((SW - 32 - 8 * 6) / 8);

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

export default function StickerPickerScreen() {
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
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.title}>Stickers</Text>
          {peerName ? <Text style={S.sub}>to {peerName}</Text> : null}
        </View>
        {sending && <ActivityIndicator color={ACCENT} />}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {PACKS.map(pack => (
          <View key={pack.id} style={S.packBlock}>
            <Text style={S.packName}>{pack.name}</Text>
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

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';

const S = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: DARK_BG },
  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  backBtn:      { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:      { color: TEXT, fontSize: 26, fontWeight: '600' },
  title:        { color: TEXT, fontSize: 22, fontWeight: '800' },
  sub:          { color: SUBTLE, fontSize: 12 },

  packBlock:    { marginBottom: 24 },
  packName:     { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 10 },
  grid:         { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile:         { backgroundColor: CARD_BG, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER },
  tileEmoji:    { fontSize: 28 },
});
