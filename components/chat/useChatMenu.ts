// components/chat/useChatMenu.ts — the chat screen's ⋮ overflow menu and the
// three pickers it opens (screenshots, notification sound, disappearing
// messages). Moved out of app/chat.tsx unchanged: the screen owns `chat`, the
// sheet state and the router; this builds the actions and opens the sheet.

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import type { Router } from 'expo-router';
import type { SheetAction as MenuAction } from '../ui';
import { NOTIF_CHANNELS } from '../../lib/push';
import { clearChatMessages, setCachedChatHidden } from '../../lib/localDb';
import type { VisionProfileKey } from '../../lib/visionComfortModel';
import {
  blockUser,
  getChat,
  muteChat,
  removeChatMember,
  resetChatSession,
  saveContact,
  setChatNotifSound,
  setDisappearing,
  setHidden,
  setScreenshotMode,
  setVanishMode,
  type ChatDetail,
  type ScreenshotMode,
} from '../../lib/chatService';
import { DISAPPEARING_PRESETS, formatDisappearing, formatScreenshotMode } from './chatFormat';
import type { DisplayMessage } from './chatStyles';

export type OverflowMenu = { title: string; actions: MenuAction[] };

export function useChatMenu({
  chat, setChat, chatId, meId, router, compactHeader, embedded, activeProfile, setActiveProfile,
  setOverflowMenu, setSearchOpen, setMessages, onPaneEnded,
}: {
  chat: ChatDetail | null;
  setChat: Dispatch<SetStateAction<ChatDetail | null>>;
  chatId: string;
  meId: string | null;
  router: Router;
  compactHeader?: boolean;
  embedded?: boolean;
  activeProfile: VisionProfileKey;
  setActiveProfile: (key: VisionProfileKey) => Promise<unknown>;
  setOverflowMenu: (menu: OverflowMenu | null) => void;
  setSearchOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  /**
   * Embedded (split-view pane) only. A pane cannot navigate away from itself —
   * back/replace would pop or replace the whole split screen, the other chat
   * included — so an action that ends this chat for the user (leave, hide,
   * clear) reports it here and the pane shows that instead of the chat.
   */
  onPaneEnded?: (notice: string) => void;
}) {
  // Screenshot-mode picker (header menu entry)
  const openScreenshotPicker = useCallback(() => {
    if (!chat) return;
    const current = (chat.screenshotMode as ScreenshotMode) || 'block';
    const opts: { label: string; mode: ScreenshotMode }[] = [
      { label: 'Allow screenshots',          mode: 'allow' },
      { label: 'Allow & notify chat',        mode: 'allow_notify' },
      { label: 'Block screenshots',          mode: 'block' },
      { label: 'Block silently (no alert)',  mode: 'block_silent' },
    ];
    setOverflowMenu({
      title: 'Screenshots in this chat',
      actions: opts.map(o => ({
        label: o.label,
        icon: current === o.mode ? 'radio-button-on' : 'radio-button-off',
        onPress: async () => {
          if (current === o.mode) return;
          setChat(prev => prev ? { ...prev, screenshotMode: o.mode } : prev);
          try {
            await setScreenshotMode(chatId, o.mode);
          } catch (e: any) {
            setChat(prev => prev ? { ...prev, screenshotMode: current } : prev);
            Alert.alert('Save failed', e?.message ?? 'Try again');
          }
        },
      })),
    });
  }, [chat, chatId, setChat, setOverflowMenu]);

  // Per-chat notification sound picker (themed sheet). Sets the Android channel
  // the server will address for this chat's pushes.
  //
  // The current sound is marked only when the server says what it is:
  // `notifSound` on GET /chats/:id (written, not yet deployed — SP R4BE C2).
  // Until then the field is absent and no option claims to be current, rather
  // than guessing "Default".
  const openNotifSoundPicker = useCallback(() => {
    if (!chat) return;
    const current = chat.notifSound;
    const known = NOTIF_CHANNELS.some(ch => ch.id === current);
    setOverflowMenu({
      title: 'Notification sound',
      actions: NOTIF_CHANNELS.map(ch => ({
        label: ch.name,
        icon: !known ? 'musical-note-outline' as const
          : current === ch.id ? 'radio-button-on' as const : 'radio-button-off' as const,
        onPress: async () => {
          if (current === ch.id) return;
          try {
            await setChatNotifSound(chatId, ch.id);
            // Mark it locally too, so reopening the picker agrees with what was saved.
            setChat(prev => prev ? { ...prev, notifSound: ch.id as ChatDetail['notifSound'] } : prev);
          } catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again'); }
        },
      })),
    });
  }, [chat, chatId, setChat, setOverflowMenu]);

  // Disappearing-messages picker — Alert sheet, Off / 24h / 7d / 90d.
  // Any member can change the timer (privacy is shared, not admin-gated).
  // Existing messages keep whatever expires_at they got at insert time —
  // the new timer only affects future messages.
  const openDisappearingPicker = useCallback(() => {
    if (!chat) return;
    const current = chat.disappearingSeconds ?? null;
    setOverflowMenu({
      title: 'Disappearing messages',
      actions: DISAPPEARING_PRESETS.map(opt => ({
        label: opt.label,
        icon: current === opt.seconds ? 'radio-button-on' : 'radio-button-off',
        onPress: async () => {
          if (current === opt.seconds) return;
          // Optimistic update; rollback on failure.
          setChat(prev => prev ? { ...prev, disappearingSeconds: opt.seconds } : prev);
          try {
            await setDisappearing(chatId, opt.seconds);
          } catch (e: any) {
            setChat(prev => prev ? { ...prev, disappearingSeconds: current } : prev);
            Alert.alert('Could not update', e?.message ?? 'Try again');
          }
        },
      })),
    });
  }, [chat, chatId, setChat, setOverflowMenu]);

  // ── Chat-level overflow menu — a themed bottom sheet (not Alert.alert, which
  // caps at 3 buttons on Android and looks like a system dialog). ──
  const onPressMenu = useCallback(() => {
    if (!chat) return;
    const peer = chat.type === 'direct' && meId
      ? chat.members.find(m => m.userId !== meId)
      : null;
    const isMuted = chat.muted;

    const actions: MenuAction[] = [
      ...(compactHeader ? [{
        label: 'Voice call', icon: 'call-outline' as const,
        onPress: () => chat.type === 'group'
          ? router.push({ pathname: '/group-calls', params: { chatId, groupName: chat.name ?? 'Group', mode: 'voice' } })
          : peer && router.push({ pathname: '/voicecall', params: { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' } }),
      }, {
        label: 'Video call', icon: 'videocam-outline' as const,
        onPress: () => chat.type === 'group'
          ? router.push({ pathname: '/group-calls', params: { chatId, groupName: chat.name ?? 'Group', mode: 'video' } })
          : peer && router.push({ pathname: '/videocall', params: { chatId, peerUid: peer.userId, peerName: peer.name || peer.email || 'crazzychat user' } }),
      }] : []),
      // The header's fourth trailing icon, relocated. Tap-to-switch survives —
      // it is one press deeper, which is the trade the three-action header
      // costs, and the same trade Search already pays two entries down.
      {
        label: activeProfile === 'with-glasses' ? 'Vision Comfort: without glasses' : 'Vision Comfort: with glasses',
        icon: 'eye-outline',
        onPress: () => { setActiveProfile(activeProfile === 'with-glasses' ? 'without-glasses' : 'with-glasses')
          .catch(() => Alert.alert('Could not switch Vision Profile', 'Try again.')); },
      },
      {
        label: 'Vision Comfort settings',
        icon: 'options-outline',
        onPress: () => router.push('/vision-comfort'),
      },
      // Search lives here, not in the header.
      //
      // The header had FOUR trailing actions where WhatsApp has three (spec
      // 6.7: video, call, overflow). Four 44pt targets plus the back arrow and
      // the avatar left roughly 160dp for the name on a 411dp screen — about
      // thirteen characters at 18pt — so ordinary names were arriving
      // ellipsised. Search is the one of the four that is not a per-message
      // action, and the one WhatsApp also files under the menu.
      {
        label: 'Search in chat',
        icon: 'search-outline',
        onPress: () => setSearchOpen(true),
      },
      {
        // The only in-app entry to /chat-export. That screen re-checks this
        // chat's own lock (PIN/biometric) before writing anything.
        label: 'Export chat',
        icon: 'share-outline',
        onPress: () => router.push({
          pathname: '/chat-export',
          params: { chatId, peerName: peer?.name || peer?.email || chat.name || '' },
        }),
      },
      {
        label: isMuted ? 'Unmute notifications' : 'Mute notifications',
        icon: isMuted ? 'notifications-outline' : 'notifications-off-outline',
        onPress: async () => {
          try {
            await muteChat(chatId, !isMuted);
            setChat(prev => prev ? { ...prev, muted: !isMuted } : prev);
          } catch (e: any) { Alert.alert('Mute failed', e?.message ?? 'Try again'); }
        },
      },
      {
        label: 'Notification sound',
        icon: 'musical-notes-outline',
        onPress: () => openNotifSoundPicker(),
      },
      {
        label: chat.disappearingSeconds
          ? `Disappearing: ${formatDisappearing(chat.disappearingSeconds)}`
          : 'Disappearing messages',
        icon: 'timer-outline',
        onPress: () => openDisappearingPicker(),
      },
      {
        label: chat.vanishMode ? 'Vanish Mode: On' : 'Vanish Mode: Off',
        icon: 'flame-outline',
        onPress: async () => {
          const next = !chat.vanishMode;
          setChat(prev => prev ? { ...prev, vanishMode: next } : prev);
          try {
            await setVanishMode(chatId, next);
          } catch (e: any) {
            setChat(prev => prev ? { ...prev, vanishMode: !next } : prev);
            Alert.alert('Could not update Vanish Mode', e?.message ?? 'Try again');
          }
        },
      },
      {
        label: `Screenshots: ${formatScreenshotMode((chat.screenshotMode as ScreenshotMode) || 'block')}`,
        icon: 'camera-outline',
        onPress: () => openScreenshotPicker(),
      },
      {
        label: chat.hidden ? 'Unhide chat' : 'Hide chat',
        icon: chat.hidden ? 'eye-outline' : 'eye-off-outline',
        onPress: async () => {
          const next = !chat.hidden;
          try {
            await setHidden(chatId, next);
            // This device's cached row too, so global search and the Bookshelf
            // follow at once even if the next list refresh fails.
            await setCachedChatHidden(chatId, next).catch(() => {});
            // From a pane, replace would swap out the whole split screen.
            if (next) { if (embedded) onPaneEnded?.('Chat hidden.'); else router.replace('/(tabs)/chats'); }
            else setChat(prev => prev ? { ...prev, hidden: next } : prev);
          } catch (e: any) { Alert.alert('Could not update', e?.message ?? 'Try again'); }
        },
      },
      {
        // The only in-app way to create a per-chat lock (the gate below
        // enforces it). chatId is passed so the lock screen can open this
        // chat's settings directly.
        label: 'Chat lock',
        icon: 'lock-closed-outline',
        onPress: () => router.push({ pathname: '/app-lock-chats', params: { chatId, chatName: chat.name || peer?.name || peer?.email || '' } }),
      },
      {
        label: 'Schedule a message',
        icon: 'calendar-outline',
        onPress: () => router.push({
          pathname: '/schedule-message',
          params: { chatId, peerName: peer?.name ?? chat.name ?? '' },
        }),
      },
      {
        label: 'Wallpaper',
        icon: 'image-outline',
        onPress: () => router.push({ pathname: '/chat-wallpaper', params: { chatId } }),
      },
      {
        label: 'Bubble theme',
        icon: 'color-palette-outline',
        onPress: () => router.push({ pathname: '/chat-themes', params: { chatId } }),
      },
    ];

    // Clear is per-device for 1:1 and groups alike: local rows go and the chat
    // is hidden server-side, so sync does not pull the history back.
    const clearAction: MenuAction = {
      label: 'Clear chat',
      icon: 'trash-bin-outline',
      destructive: true,
      onPress: () => Alert.alert(
        'Clear this chat?',
        `Removes the chat and all its messages from THIS device. ${chat.type === 'group' ? 'Other members keep' : 'The other person keeps'} their copy. This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Clear', style: 'destructive', onPress: async () => {
              try {
                await clearChatMessages(chatId);
                // Hide it server-side too. Local deletion alone is not enough:
                // listChats() would return the chat on the next refresh and
                // sync would pull the whole history back — which is exactly
                // what happened when this only deleted local rows. Same call
                // the chat list's own Delete uses — and like it, this failure
                // is now SHOWN (2026-09-22). Swallowed, the screen popped back
                // looking cleared and the history returned on the next
                // refresh, which is the exact regression the lines above
                // describe. The outer catch reports it and skips the
                // success-looking pop; every local delete is DELETE..WHERE and
                // setHidden is an absolute SET, so Clear again is a safe retry.
                await setHidden(chatId, true);
                setMessages([]);
                // A split-view pane has no screen of its own: back would pop
                // the whole split screen (same reason as the hidden Back).
                if (embedded) onPaneEnded?.('Chat cleared from this device.');
                else router.back();
              } catch (e: any) { Alert.alert('Could not clear', e?.message ?? 'Try again'); }
            } },
        ],
      ),
    };

    if (chat.type === 'group') {
      actions.push({
        label: 'Group info',
        icon: 'people-outline',
        onPress: () => router.push({ pathname: '/group-info', params: { id: chatId } }),
      });
      actions.push(clearAction);
      // Same call and wording as Leave in group-info.
      if (meId) {
        actions.push({
          label: 'Leave group',
          icon: 'exit-outline',
          destructive: true,
          onPress: () => Alert.alert('Leave group?', 'You will lose access to future messages.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Leave', style: 'destructive', onPress: async () => {
                try {
                  await removeChatMember(chatId, meId);
                  // Not from a split-view pane: that would replace the whole split
                  // screen. The pane stops showing the group instead of stranding
                  // you in a chat you no longer belong to.
                  if (embedded) onPaneEnded?.('You left this group.');
                  else router.replace('/(tabs)/chats');
                } catch (e: any) { Alert.alert('Leave failed', e?.message ?? 'Try again'); }
              } },
          ]),
        });
      }
    }

    if (peer) {
      // Exit Kit is 1:1 only, and deliberately so: a group export contains third
      // parties' messages, and there is no honest way to place those in a
      // two-person conversation. `peer` being non-null IS the direct-chat test.
      actions.push({
        label: 'Exit Kit',
        icon: 'download-outline',
        onPress: () => router.push({
          pathname: '/import-chats',
          params: { chatId, peerName: peer.name || peer.email || '' },
        }),
      });
      // Chat opened by code, still anonymous (migration 119). This is the ONLY
      // way out of the mask, so it goes first — without it the two people stay
      // ghosts to each other forever and the feature looks broken rather than
      // private.
      //
      // The alert is explicit that one save is not enough. Someone who taps it
      // and sees nothing change would otherwise reasonably conclude it failed.
      if (chat?.anonMasked) {
        actions.push({
          label: 'Save contact',
          icon: 'person-add-outline',
          onPress: async () => {
            try {
              const res = await saveContact(chatId);
              Alert.alert(
                res.revealed ? 'Saved — you can see each other now' : 'Saved',
                res.revealed
                  ? 'You both saved each other, so your names and photos are now visible.'
                  : 'You will both stay hidden until they save you too.',
              );
              getChat(chatId).then(setChat).catch(() => {});
            } catch (e: any) {
              Alert.alert('Could not save', e?.message ?? 'Try again.');
            }
          },
        });
      }
      actions.push({
        label: 'Ghost Mode',
        icon: 'eye-off-outline',
        onPress: () => router.push({
          pathname: '/ghost-mode',
          params: { targetId: peer.userId, targetName: peer.name || peer.email || '' },
        }),
      });
      actions.push({
        label: 'Reset secure session',
        icon: 'refresh-outline',
        onPress: () => Alert.alert(
          'Reset secure session?',
          'Use this if messages show "unable to decrypt". It re-establishes encryption keys with this contact on your next message. Past undecryptable messages stay unreadable.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Reset', onPress: async () => {
                try {
                  await resetChatSession(chatId);
                  Alert.alert('Session reset', 'Send a message to re-establish encryption.');
                } catch (e: any) { Alert.alert('Reset failed', e?.message ?? 'Try again'); }
              } },
          ],
        ),
      });
      actions.push(clearAction);
      actions.push({
        label: 'Block user',
        icon: 'ban-outline',
        destructive: true,
        onPress: () => Alert.alert(
          'Block this user?',
          'They will no longer be able to message you. Existing chat history is preserved.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Block', style: 'destructive', onPress: async () => {
                try {
                  await blockUser(peer.userId);
                  Alert.alert('Blocked', `${peer.name || peer.email || 'User'} can no longer message you.`);
                  if (!embedded) router.back();
                } catch (e: any) { Alert.alert('Block failed', e?.message ?? 'Try again'); }
              } },
          ],
        ),
      });
    }

    setOverflowMenu({ title: chat.name || (peer?.name ?? 'Chat'), actions });
  }, [chat, meId, chatId, router, compactHeader, embedded, activeProfile, setActiveProfile,
    openNotifSoundPicker, openDisappearingPicker, openScreenshotPicker, setChat, setMessages, setOverflowMenu, setSearchOpen,
    onPaneEnded]);

  return onPressMenu;
}
