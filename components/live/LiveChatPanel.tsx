// components/live/LiveChatPanel.tsx — the folded-away live chat.
//
// Moved out of app/live-view.tsx. One change: the list follows new messages
// only while the reader is already at the bottom. It used to scroll to the end
// on every content change, so reading back through history while the chat was
// busy kept yanking you down.

import React, { useRef } from 'react';
import { View, TouchableOpacity, ScrollView, TextInput, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../ui/Text';
import type { BroadcastMessage } from '../../lib/broadcast';
import { LIVE, S } from './liveStyles';

/** How close to the end still counts as "at the bottom", in dp. */
const FOLLOW_SLACK = 24;

export function LiveChatPanel({
  messages, draft, setDraft, send, sendFailed, onClose, win, landscape,
}: {
  messages: BroadcastMessage[];
  draft: string;
  setDraft: (t: string) => void;
  send: () => void;
  sendFailed: boolean;
  onClose: () => void;
  win: { width: number; height: number };
  landscape: boolean;
}) {
  const chatScroll = useRef<ScrollView>(null);
  // Starts true: the panel opens on the newest messages.
  const atBottom = useRef(true);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
  };
  return (
    <View
      // CHAT MOVES TO THE RIGHT WHEN THE PANEL IS WIDE.
      //
      // A stream that has turned landscape is a game, and a game is
      // the case where a chat strip across the bottom covers the
      // part people are watching — the floor of the map, the
      // scoreboard, the health bar. Every live-streaming app puts
      // the chat in a right-hand column for exactly this, and the
      // room is only there in landscape.
      //
      // Portrait keeps the bottom sheet. A third of a 393dp phone is
      // 134dp, which fits about two words per line and turns a
      // conversation into a column of fragments.
      style={[
        S.chatWrap,
        landscape && {
          alignSelf: 'flex-end',
          width: Math.min(340, Math.round(win.width * 0.34)),
        },
      ]}
      pointerEvents="box-none"
    >
      <View style={S.chatHead}>
        <AppText style={S.chatHeadText} accessibilityRole="header">Live chat</AppText>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the live chat" hitSlop={10}>
          <Ionicons name="chevron-down" size={18} color={LIVE.textDim} />
        </TouchableOpacity>
      </View>
      <ScrollView
        ref={chatScroll}
        // New messages land at the bottom; follow them — but only when the
        // reader is already there, or reading back would keep jumping.
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => { if (atBottom.current) chatScroll.current?.scrollToEnd({ animated: true }); }}
        // Taller in landscape, because a right-hand column has the
        // height to spare and 28% of a short edge is three messages.
        style={[S.chatList, { maxHeight: Math.round(win.height * (landscape ? 0.5 : 0.28)) }]}
        contentContainerStyle={S.chatListInner}
        showsVerticalScrollIndicator={false}
      >
        {messages.map(m => (
          <AppText key={m.id} style={S.chatLine} numberOfLines={3}>
            <AppText style={S.chatName}>{m.name || 'Someone'} </AppText>
            {m.message}
          </AppText>
        ))}
      </ScrollView>
      {sendFailed && (
        <AppText style={S.chatFailed} accessibilityRole="alert">Not sent. Your message is back in the box.</AppText>
      )}
      <View style={S.chatInputRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Say something…"
          accessibilityLabel="Live chat message"
          placeholderTextColor={LIVE.textDim}
          style={S.chatInput}
          maxLength={500}
          onSubmitEditing={send}
          returnKeyType="send"
          autoFocus
        />
        <TouchableOpacity onPress={send} accessibilityRole="button" accessibilityLabel="Send" style={S.chatSend}>
          <Ionicons name="send" size={18} color={LIVE.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}
