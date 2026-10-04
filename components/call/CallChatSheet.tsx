// components/call/CallChatSheet.tsx — in-call text chat.
//
// Deliberately a separate component, for the same reason <CallTimer> is: typing
// is a per-keystroke setState, and holding the draft in the call screen would
// re-render the video surfaces on every character. The draft lives here; the
// screen only learns that the sheet is open.
//
// WHAT THIS IS NOT
// ----------------
// It is not the chat thread. These lines exist for the duration of the call and
// are never persisted — not to the message store, not to AsyncStorage, not to
// the server (the relay forwards an encrypted envelope and keeps nothing). It's
// the channel for "you're on mute" and for pasting a link mid-call, and a user
// who assumed it was saved would be wrong in a way that matters, so the empty
// state says so outright.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CALL } from '../../constants/callTheme';
import {
  FlatList, Keyboard, Modal, Platform, Pressable, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CallChatMessage } from '../../lib/call/types';

export interface CallChatSheetProps {
  visible: boolean;
  onClose: () => void;
  messages: readonly CallChatMessage[];
  onSend: (text: string) => void;
}

const Line = memo(function Line({ m }: { m: CallChatMessage }) {
  return (
    <View style={[S.line, m.mine ? S.mine : S.theirs]}>
      {!m.mine && <Text style={S.who} numberOfLines={1}>{m.name}</Text>}
      <Text style={S.text}>{m.text}</Text>
    </View>
  );
});

function CallChatSheetImpl({ visible, onClose, messages, onSend }: CallChatSheetProps) {
  const [draft, setDraft] = useState('');

  // LIFT THE SHEET BY THE MEASURED KEYBOARD HEIGHT.
  //
  // This used to be a KeyboardAvoidingView with
  // `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` — and on
  // Android an undefined behavior makes the component a plain View that does
  // NOTHING. The usual Android fallback does not apply either: the manifest's
  // windowSoftInputMode=adjustResize resizes the ACTIVITY, and a React Native
  // <Modal> is its own window, which never gets resized. The sheet is pinned
  // bottom:0, so the keyboard simply covered the composer and the message you
  // were typing.
  //
  // Measuring the keyboard and offsetting `bottom` works the same way on both
  // platforms and does not depend on any window flag. `Will` events on iOS
  // move the sheet with the keyboard animation; Android only emits `Did`.
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKb(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  // A sheet that closes while the keyboard is up must not reopen still lifted.
  useEffect(() => { if (!visible) setKb(0); }, [visible]);
  const listRef = useRef<FlatList<CallChatMessage>>(null);

  const send = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft('');
  }, [draft, onSend]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* keyboard-exempt: handled, just not by KeyboardSafe. The keyboard
          listener that drives `bottom: kb` lives in the component body above,
          outside this block, so the source scan in
          lib/keyboardAvoidance.selftest.ts cannot see it. The sheet is pinned
          bottom:0 and lifts by the measured keyboard height — see the note on
          that effect for why a Modal needs its own measurement. */}
      <Pressable style={S.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close in-call chat" />
      <View style={[S.sheet, { bottom: kb }]}>
        <View style={S.grabber} />
        <View style={S.head}>
          <Text style={S.title} accessibilityRole="header">In-call chat</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close in-call chat" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={22} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
        </View>

        <FlatList
          ref={listRef}
          data={messages as CallChatMessage[]}
          keyExtractor={m => m.id}
          renderItem={({ item }) => <Line m={item} />}
          contentContainerStyle={S.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            <Text style={S.empty}>
              Messages here are only for this call. They aren&apos;t saved to the chat.
            </Text>
          }
        />

        <View style={S.composer}>
          <TextInput
            style={S.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            accessibilityLabel="In-call message"
            placeholderTextColor="rgba(255,255,255,0.4)"
            maxLength={500}
            multiline
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <TouchableOpacity
            accessibilityRole="button" accessibilityLabel="Send message"
            accessibilityState={{ disabled: !draft.trim() }}
            onPress={send} disabled={!draft.trim()} style={S.send} hitSlop={8}
          >
            <Ionicons name="send" size={20} color={draft.trim() ? CALL.text : 'rgba(255,255,255,0.3)'} />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export const CallChatSheet = memo(CallChatSheetImpl);

const S = StyleSheet.create({
  backdrop:  { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet:     { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%', minHeight: 280,
               backgroundColor: CALL.sheet, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  grabber:   { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, marginTop: 8,
               backgroundColor: 'rgba(255,255,255,0.25)' },
  head:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
               paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6 },
  title:     { color: CALL.text, fontSize: 16, fontWeight: '700' },
  list:      { paddingHorizontal: 14, paddingVertical: 8, flexGrow: 1 },
  empty:     { color: 'rgba(255,255,255,0.45)', fontSize: 13, textAlign: 'center',
               paddingHorizontal: 30, paddingTop: 40, lineHeight: 19 },
  line:      { maxWidth: '82%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 3 },
  mine:      { alignSelf: 'flex-end', backgroundColor: CALL.chatMine },
  theirs:    { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.10)' },
  who:       { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  text:      { color: CALL.text, fontSize: 15, lineHeight: 20 },
  composer:  { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 14,
               paddingTop: 8, paddingBottom: 26 },
  input:     { flex: 1, maxHeight: 110, color: CALL.text, fontSize: 15, paddingHorizontal: 14,
               paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.10)' },
  send:      { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
               backgroundColor: 'rgba(255,255,255,0.12)' },
});

export default CallChatSheet;
