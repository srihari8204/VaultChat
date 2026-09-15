// components/games/InviteSheet.tsx — pick a chat and put the table in it.
//
// The invite used to leave through the OS share sheet and hope it came back.
// crazzychat is the app it was going to be pasted into, so this sheet posts the
// invite straight into a chat as a 'game_invite' card (migration 124), and
// keeps the share sheet as the row for someone who is not on crazzychat yet.
//
// Mounted ONCE by app/games.tsx. All four boards keep their existing single
// call and reach it through registerInvitePicker/openInvite in lib/games/invite
// — threading a modal through four board layouts to show the same list would be
// four places to get it wrong.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { Sheet, SettingRow } from './feedback';
import { C, S } from '../../lib/games/theme';
import { listChats, type ChatSummary } from '../../lib/chatService';
import { gameName, inviteToTable, registerInvitePicker, sendGameInvite } from '../../lib/games/invite';
import type { GameKind } from '../../lib/gamesSocket';

/** What a chat is called in the picker. Direct chats carry the peer's name. */
function chatLabel(c: ChatSummary): string {
  return c.name || c.peerName || (c.type === 'group' ? 'Group' : 'Chat');
}

export default function InviteSheet() {
  const [target, setTarget] = useState<{ game: GameKind; room: string } | null>(null);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);

  useEffect(() => registerInvitePicker((game, room) => {
    setTarget({ game, room });
    setChats(null);
  }), []);

  // Loaded per open rather than held: the list is small, and a stale one would
  // offer a chat that has since been archived or left.
  useEffect(() => {
    if (!target) return;
    let live = true;
    listChats()
      .then(rows => { if (live) setChats(rows.filter(c => !c.archived)); })
      .catch(() => { if (live) setChats([]); });
    return () => { live = false; };
  }, [target]);

  const close = useCallback(() => setTarget(null), []);

  const post = useCallback(async (chat: ChatSummary) => {
    if (!target) return;
    setTarget(null);
    try {
      const ok = await sendGameInvite(chat.id, target.game, target.room);
      if (!ok) Alert.alert('No table to share', 'This table has no code to send yet.');
      else Alert.alert('Invite sent', `The card is in your chat with ${chatLabel(chat)}.`);
    } catch (e: any) {
      // THE INVITE STILL HAS TO REACH THEM.
      //
      // A server that will not carry the card is not a reason to leave the
      // player with nothing: the link says the same thing, and every phone can
      // send a link. This is also the exact state of production right now — the
      // card's message type is refused with "invalid type" until its migration
      // is applied — so without this fallback the button is simply broken.
      const msg = String(e?.message ?? '');
      Alert.alert(
        'Card could not be sent',
        `${msg || 'The server refused it.'}

Send the link instead?`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Share link', onPress: () => { void inviteToTable(target.game, target.room); } },
        ],
      );
    }
  }, [target]);

  if (!target) return null;

  return (
    <Sheet visible title={`Invite to ${gameName(target.game)}`} onClose={close}>
      <Text style={{ color: C.muted, fontSize: 13, marginBottom: S[1] }}>
        They tap the card and land at this table.
      </Text>

      {/* The way out of the app, ABOVE the list rather than below it. A player
          with a dozen chats had to scroll past all of them to find the only
          option that reaches someone who does not have crazzychat yet — which is
          the one they need most often when a table is empty. */}
      <SettingRow
        label="Share a link instead"
        hint="WhatsApp, SMS, anywhere — works even if they don't have crazzychat"
        value="Share"
        onPress={() => { const t = target; close(); if (t) void inviteToTable(t.game, t.room); }}
      />

      {chats === null ? (
        <View style={{ paddingVertical: S[4], alignItems: 'center' }}>
          <ActivityIndicator color={C.text} />
        </View>
      ) : chats.length === 0 ? (
        <Text style={{ color: C.muted, fontSize: 13, paddingVertical: S[2] }}>
          No chats yet.
        </Text>
      ) : (
        chats.map(c => (
          <SettingRow
            key={c.id}
            label={chatLabel(c)}
            hint={c.type === 'group' ? 'Group' : undefined}
            value="Send"
            onPress={() => { void post(c); }}
          />
        ))
      )}

    </Sheet>
  );
}
