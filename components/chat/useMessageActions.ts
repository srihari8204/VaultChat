// components/chat/useMessageActions.ts — the long-press action sheet's tiles
// for one message (reply, pin, forward, copy, star, remind, info, edit,
// verify, revoke, delete). Moved out of app/chat.tsx unchanged; every handler
// still writes the screen's own state through the setters it is given.

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import type { Router } from 'expo-router';
import type { SheetAction } from '../MessageActionSheet';
import { copyAndAutoClear } from '../../lib/clipboardSafe';
import { markCachedDeleted } from '../../lib/localDb';
import { wipeRevokedMedia } from '../../lib/protectedMedia';
import { enqueueDelete } from '../../lib/messageQueue';
import { addBookmark, pinMessage, revokeAttachment } from '../../lib/chatService';
import type { DisplayMessage } from './chatStyles';

// Delete-for-everyone window — keep numerically identical to the server's
// REVOKE_WINDOW_MS (routes/chats.js). WhatsApp parity: 2 days 12 hours.
const REVOKE_WINDOW_MS = 60 * 60 * 60 * 1000;

// MUST MATCH chatsEditWindowMS IN THE SERVER (routes/chats.go).
//
// The PATCH enforces this in its WHERE clause — `created_at > NOW() - INTERVAL`
// — so past it the server returns 404 and there is nothing the client can do.
// Offering Edit anyway is what made editing look broken: the change applied
// optimistically, the PATCH 404'd, and the failure was swallowed (see the
// rollback in the queue's 'failed' handler), so the text silently reverted on
// the next sync with no error shown.
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function useMessageActions({
  meId, chatId, router, pinnedId, setPinnedId, openForward, setReplyTo, setInfoMsg, setEditingId, setInput, setMessages,
}: {
  meId: string | null;
  chatId: string;
  router: Router;
  pinnedId: string | null;
  setPinnedId: (id: string | null) => void;
  openForward: (msg: DisplayMessage) => void;
  setReplyTo: (msg: DisplayMessage | null) => void;
  setInfoMsg: (msg: DisplayMessage | null) => void;
  setEditingId: (id: number | null) => void;
  setInput: (text: string) => void;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
}) {
  // Build the action-sheet tiles for a message — reuses the existing handlers.
  const buildSheetActions = useCallback((msg: DisplayMessage, plain: string): SheetAction[] => {
    const isMine = msg.senderId === meId;
    const isPinned = pinnedId === String(msg.id);
    // View-once and Invisible Ink are meant to be seen in place only.
    const protectedMsg = !!(msg.meta?.viewOnce || msg.meta?.invisibleInk);
    const acts: SheetAction[] = [
      { key: 'reply',   label: 'Reply',   icon: 'arrow-undo', onPress: () => setReplyTo(msg) },
      { key: 'pin',     label: isPinned ? 'Unpin' : 'Pin', icon: 'pin', onPress: async () => {
          const next = isPinned ? null : msg.id;
          const prev = pinnedId;
          setPinnedId(next == null ? null : String(msg.id)); // optimistic
          // Restoring `prev` is the half this was missing: it told the user the
          // call failed and then left the optimistic value on screen, so the UI
          // disagreed with the server until the next sync corrected it silently.
          try { await pinMessage(chatId, next); }
          catch (e: any) { setPinnedId(prev); Alert.alert('Could not pin', e?.message ?? 'Try again'); }
        } },
      // View-once and Invisible Ink are meant to be seen in place only, so they
      // are never copied out or forwarded on.
      ...(protectedMsg ? [] : [
        { key: 'forward', label: 'Forward', icon: 'arrow-redo', onPress: () => openForward(msg) },
        { key: 'copy',    label: 'Copy',    icon: 'copy-outline', onPress: () => copyAndAutoClear(plain) },
      ] as SheetAction[]),
      { key: 'star',    label: 'Star',    icon: 'star-outline', onPress: async () => {
          // Pass the decrypted body so the bookmark keeps a LOCAL copy. The
          // server reclaims a bookmarked message's ciphertext like any other —
          // exempting it would make bookmarks a permanent server archive — so
          // this snapshot is what keeps the saved message readable afterwards.
          // View-once / Invisible Ink keep no readable copy outside the bubble.
          try { await addBookmark(msg.id, null, protectedMsg ? null : (plain || null)); }
          catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
        } },
      // No Remind for view-once / Invisible Ink: the Reminders list re-reads the
      // message from the local cache and would show it in plain view there.
      ...(protectedMsg ? [] : [
        { key: 'remind',  label: 'Remind',  icon: 'alarm-outline', onPress: () => router.push({
            pathname: '/message-reminder' as any,
            params: { chatId, messageId: String(msg.id), preview: (plain || msg.type).slice(0, 200) },
          }) },
      ] as SheetAction[]),
    ];
    if (isMine && msg.id > 0 && !msg.deletedAt) {
      acts.push({ key: 'info', label: 'Info', icon: 'information-circle-outline', onPress: () => setInfoMsg(msg) });
    }
    // Offer Edit only when the server will actually accept it.
    //
    //   msg.id > 0    a still-pending optimistic bubble has no server row yet
    //   plain         you cannot edit text you cannot see — for an own message
    //                 whose local plaintext is gone (reinstall), the composer
    //                 would open EMPTY and a stray send would overwrite the
    //                 message with whatever was typed
    //   EDIT_WINDOW   the PATCH's WHERE clause rejects anything older, and a
    //                 rejected edit used to revert silently
    const editable = isMine && !msg.deletedAt && msg.id > 0 && !!plain &&
      Date.now() - new Date(msg.createdAt).getTime() < EDIT_WINDOW_MS;
    if (editable) {
      acts.push({ key: 'edit', label: 'Edit', icon: 'create-outline', onPress: () => { setEditingId(msg.id); setInput(plain); } });
    }
    // VaultCheck — authenticity verification on received photos/video. Offered
    // on media you did NOT send (verifying your own file tells you nothing) and
    // only where there are pixels to analyse.
    if (!isMine && !msg.deletedAt && msg.meta?.attachmentId && !msg.meta?.revoked
        && (msg.type === 'image' || msg.type === 'video')) {
      acts.push({ key: 'verify', label: 'Verify', icon: 'shield-checkmark-outline', onPress: () => {
          router.push({
            pathname: '/vaultcheck' as any,
            params: {
              attachmentId: String(msg.meta!.attachmentId),
              msgType: msg.type,
              mime: String(msg.meta?.mime || ''),
              filename: String(msg.meta?.filename || ''),
              isMine: '',
            },
          });
        } });
    }
    // VaultView remote revoke — sender only, on media you still own. Distinct
    // from "Delete for everyone": that removes the MESSAGE inside a 2d12h
    // window, this destroys the MEDIA itself (server bytes + the recipient's
    // key and plaintext) with no time limit and no undo.
    const revokableAttachment = msg.meta?.attachmentId && !msg.meta?.revoked
      && ['image', 'video', 'audio', 'voice', 'file'].includes(String(msg.type));
    if (isMine && msg.id > 0 && !msg.deletedAt && revokableAttachment) {
      acts.push({ key: 'revoke', label: 'Revoke', icon: 'eye-off-outline', danger: true, onPress: () => {
          Alert.alert(
            'Revoke this media?',
            'It will be deleted from the server and from the other person\'s phone, even if they already downloaded it. This cannot be undone.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Revoke', style: 'destructive', onPress: async () => {
                  const attId = String(msg.meta!.attachmentId);
                  // Optimistic tombstone — the sender never receives the
                  // broadcast for their own revoke.
                  setMessages(prev => prev.map(x => x.id === msg.id
                    ? { ...x, meta: { ...(x.meta || {}), revoked: true } } : x));
                  try {
                    await revokeAttachment(attId);
                  } catch (e: any) {
                    setMessages(prev => prev.map(x => x.id === msg.id
                      ? { ...x, meta: { ...(x.meta || {}), revoked: false } } : x));
                    Alert.alert('Could not revoke', e?.message ?? 'Try again when you are back online.');
                    return;
                  }
                  // Wipe our own copies too — revoked means gone on both sides.
                  await wipeRevokedMedia(attId).catch(() => {});
                } },
            ],
          );
        } });
    }
    // Delete is available on EVERY message: "Delete for me" always (local-only
    // hide), plus "Delete for everyone" on your own messages (server revoke) —
    // matching WhatsApp.
    if (!msg.deletedAt) {
      acts.push({ key: 'delete', label: 'Delete', icon: 'trash-outline', danger: true, onPress: () => {
          const opts: any[] = [{
            text: 'Delete for me', style: 'destructive', onPress: async () => {
              try { await markCachedDeleted(chatId, msg.id); } catch {}
              setMessages(prev => prev.filter(x => x.id !== msg.id));
            },
          }];
          // Delete-for-everyone window (WhatsApp: 2d12h). Server enforces the
          // same window; this is only the UX hint. NaN-hardened: a missing
          // createdAt must not silently hide the option via NaN comparisons.
          const _t = new Date(msg.createdAt).getTime();
          const withinRevoke = Number.isFinite(_t) && (Date.now() - _t < REVOKE_WINDOW_MS);
          if (isMine && msg.id > 0 && withinRevoke) {
            opts.push({
              text: 'Delete for everyone', style: 'destructive', onPress: async () => {
                // Queue FIRST, then tombstone. enqueue() now throws when the
                // outbox write does not land, and the old order painted the
                // tombstone before that could happen: the bubble read "deleted",
                // the revoke was never queued, every recipient still had the
                // message, and no 'failed' event could reach it because the row
                // was not in the outbox. Silent, permanent, and the user
                // believed the opposite.
                try {
                  await enqueueDelete(chatId, msg.id);
                } catch (e: any) {
                  Alert.alert('Could not delete', e?.message ?? 'Try again');
                  return;   // leave the message visible — it was NOT revoked
                }
                setMessages(prev => prev.map(x => x.id === msg.id
                  ? { ...x, content: null, deletedAt: new Date().toISOString(), type: 'system' } : x));
              },
            });
          }
          opts.push({ text: 'Cancel', style: 'cancel' });
          Alert.alert('Delete message?', undefined, opts);
        } });
    }
    return acts;
  }, [meId, chatId, router, pinnedId, openForward, setEditingId, setInfoMsg, setInput, setMessages, setPinnedId, setReplyTo]);

  return buildSheetActions;
}
