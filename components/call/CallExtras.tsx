// components/call/CallExtras.tsx — in-call chat + reactions, as one drop-in.
//
// WHY A SINGLE COMPONENT
// ----------------------
// Three screens need this (voice, video, group) and the video control bar is
// already seven buttons wide — adding two more would overflow it on a narrow
// phone. So these live in their own compact row floating just above the bar,
// and everything they need (open/closed state, the draft, the picker, the
// animation) is owned here. A screen wires it in one line and re-renders for
// none of it.
//
// It self-positions: render it as a direct child of the screen's root View, and
// the overlay fills the screen while the row sits `bottom` points up from the
// bottom edge. The overlay is pointerEvents="none", so a floating emoji can
// never swallow a tap meant for the End button underneath it.

import { memo, useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CallChatSheet } from './CallChatSheet';
import { ReactionOverlay, ReactionPicker } from './CallReactions';
import { useCallChat, useCallChatUnread, useCallReactions } from '../../hooks/useCall';
import * as engine from '../../lib/call/engine';

export interface CallExtrasProps {
  /** Points from the bottom of the screen to the row — clears the control bar. */
  bottom: number;
}

function CallExtrasImpl({ bottom }: CallExtrasProps) {
  const messages  = useCallChat();
  const unread    = useCallChatUnread();
  const reactions = useCallReactions();

  const [chatOpen, setChatOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const openChat = useCallback(() => {
    setChatOpen(true);
    engine.markChatRead();
  }, []);
  const closeChat = useCallback(() => setChatOpen(false), []);
  const togglePicker = useCallback(() => setPickerOpen(v => !v), []);

  const send = useCallback((text: string) => engine.sendChat(text), []);
  const react = useCallback((emoji: string) => {
    engine.sendReaction(emoji);
    setPickerOpen(false);
  }, []);

  return (
    <>
      <ReactionOverlay reactions={reactions} />

      <View style={[S.wrap, { bottom }]} pointerEvents="box-none">
        {pickerOpen && <ReactionPicker onPick={react} />}
        <View style={S.row}>
          <TouchableOpacity onPress={openChat} style={S.btn} hitSlop={8} accessibilityLabel="In-call chat">
            <Ionicons name="chatbubble-ellipses" size={20} color="#fff" />
            {unread > 0 && (
              <View style={S.badge}>
                <Text style={S.badgeTxt}>{unread > 9 ? '9+' : unread}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={togglePicker}
            style={[S.btn, pickerOpen && S.btnActive]}
            hitSlop={8}
            accessibilityLabel="Send a reaction"
          >
            <Ionicons name="happy" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      <CallChatSheet visible={chatOpen} onClose={closeChat} messages={messages} onSend={send} />
    </>
  );
}

export const CallExtras = memo(CallExtrasImpl);

const S = StyleSheet.create({
  wrap:      { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  row:       { flexDirection: 'row', gap: 10 },
  btn:       { width: 40, minHeight: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
               backgroundColor: 'rgba(255,255,255,0.14)' },
  btnActive: { backgroundColor: 'rgba(255,255,255,0.30)' },
  badge:     { position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9,
               paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E5484D' },
  badgeTxt:  { color: '#fff', fontSize: 10, fontWeight: '800' },
});

export default CallExtras;
