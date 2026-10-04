// components/chat/useChatSocket.ts — the chat screen's live socket events:
// join the chat's room, then new / edited / deleted messages, delivery and read
// receipts, typing, presence, screenshot notices, poll votes, VaultView
// revokes, live location and pins. Moved out of app/chat.tsx unchanged: one
// subscription per chatId, every handler reads the screen's refs at call time
// (see meIdRef there) and writes through its state setters.
//
// lib/receiptEvents, decryptReplayCost, messageDeletion, chatUnreadCursor and
// outboxRecovery selftests read this file with app/chat.tsx as one source, and
// receiptEvents EXECUTES onMemberDelivered / onMemberRead from it — keep their
// names and the `chatId` / `setChat` / `queueNoteDelivered` identifiers.
// Since the move, the live-location and pin payloads are typed and checked
// (./socketPayloads) instead of being taken as `any`.

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { applyMessage } from '../../lib/localDb';
import { playReceived } from '../../lib/sounds';
import { wipeRevokedMedia } from '../../lib/protectedMedia';
import { getLiveKey, clearLiveKey, decryptPosition } from '../../lib/liveLocationCrypto';
import {
  hydrateMessages,
  looksEncrypted,
  persistMessageDeletion,
  normalizeMsgIds,
  type ChatDetail,
  type Message,
  type PollVoteSummary,
} from '../../lib/chatService';
import { markDeliveredDurable } from '../../lib/receipts';
import { noteDelivered as queueNoteDelivered } from '../../lib/messageQueue';
import { getSocket, joinChatRoom, leaveChatRoom } from '../../lib/socket';
import type { DisplayMessage } from './chatStyles';
import { bumpPollVote } from './chatFormat';
import { legacyLivePosition, pinnedIdOf, type LiveLocationEvent, type LiveLocationStopEvent, type PinnedEvent } from './socketPayloads';

type SetS<T> = Dispatch<SetStateAction<T>>;
export type LiveLoc = { userId: string; latitude: number; longitude: number; address?: string };

export function useChatSocket({
  chatId, chatIdRef, meIdRef, messagesRef, atBottomRef,
  setMessages, setChat, setNewSinceUp, setTypingUids, setScreenshotBanner, setPollVotes, setLiveLoc, setPinnedId,
}: {
  chatId: string;
  chatIdRef: MutableRefObject<string>;
  meIdRef: MutableRefObject<string | null>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  atBottomRef: MutableRefObject<boolean>;
  setMessages: SetS<DisplayMessage[]>;
  setChat: SetS<ChatDetail | null>;
  setNewSinceUp: SetS<number>;
  setTypingUids: SetS<Set<string>>;
  setScreenshotBanner: SetS<{ by: string; at: string } | null>;
  setPollVotes: SetS<Record<number, PollVoteSummary>>;
  setLiveLoc: SetS<LiveLoc | null>;
  setPinnedId: SetS<string | null>;
}): void {
  useEffect(() => {
    if (!chatId) return;
    let off: (() => void)[] = [];
    let cancelled = false;

    (async () => {
      try {
        const s = await getSocket();
        await joinChatRoom(chatId);
        if (cancelled) return;

        const onNew = (m: Message) => {

          const me = meIdRef.current;
          if (m.chatId !== chatId) return;
          // Socket payloads deliver `id` AND `replyToId` as STRINGS, but the HTTP
          // ack / cache use NUMBERs. Normalize so `x.id === m.id` dedup works —
          // otherwise the socket echo of our own just-sent message survives
          // alongside the ack'd row and both collide on the same React key — and
          // so the reply-target lookup (a Map<number,…>) can find the quoted row.
          normalizeMsgIds(m);
          // Tone immediately; the DELIVERY ACK deliberately does not fire here.
          if (m.senderId !== me) {
            playReceived();   // in-app "received" tone (respects sound prefs)
          }
          // Decrypt-on-arrival (WhatsApp-style): decrypt ONCE, then show + cache
          // the PLAINTEXT so re-opens never decrypt it again.
          (async () => {
            // `live`: this message arrived seconds ago, so a missing session is
            // the out-of-order race worth retrying — not history whose keys are
            // simply gone. Everything else hydrated on this screen is history.
            // A DECRYPT FAILURE MUST NOT COST THE ACK.
            //
            // hydrateMessages is try/FINALLY with no catch, so it can throw —
            // and on a session hitting 'aes/gcm: invalid ghash tag' it does.
            // Before the ack moved below the persist that did not matter, because
            // the ack had already fired. Now an exception here would skip it, and
            // the sender would sit on a single tick for a message the recipient
            // actually holds.
            //
            // The contract is "this device HAS the message", not "can read it":
            // an undecryptable blob is stashed and retried after the next key
            // harvest, so the row on disk is what the ack is about. Keep the
            // ciphertext and carry on.
            let fin = m;
            if (looksEncrypted(m.content)) {
              try { fin = (await hydrateMessages(chatId, [m], undefined, { live: true }))[0] ?? m; }
              catch { fin = m; }
            }
            // OUR OWN ECHO WITH NO PLAINTEXT YET — do not insert it.
            //
            // The server echoes our own send back to us. hydrateMessages takes the
            // own-message path and looks up readOwnPlaintext, but that row is only
            // written by postOnce AFTER the HTTP POST resolves — and a push on an
            // already-open socket routinely beats the round trip. The lookup misses
            // and we get a row with the real id and content === null.
            //
            // Inserting it is what breaks the send: the queue's 'sent' handler
            // below then sees `prev.some(x => x.id === real.id)`, concludes the
            // real row is already on screen, and DELETES the optimistic bubble that
            // is holding the only plaintext. The survivor renders as "Message not
            // available on this device" — the message appears, then goes blank.
            //
            // The sender already has a strictly better bubble, so the degraded echo
            // has nothing to add. Guard only the insert: the persist + ack below
            // must still run, because the ack means "this device HAS the message".
            const ownBlankEcho = fin.senderId === me && fin.content == null;
            // RE-CHECK THE CHAT AFTER THE DECRYPT.
            //
            // The `m.chatId !== chatId` test at the top of this handler ran
            // BEFORE the await above, and a decrypt takes 0.5–0.9 s on a real
            // handset. chatId can change on a mounted instance (app/split.tsx
            // pane swap), so a message for the chat we just left was prepended
            // to the thread now on screen. Only the two VISIBLE writes are
            // gated: the persist and the delivery ack below use the captured
            // chatId, are correct regardless of what is on screen, and must
            // still run — an un-acked message is re-delivered forever.
            const stillHere = chatIdRef.current === chatId;
            if (!ownBlankEcho && stillHere) {
              setMessages(prev => prev.some(x => x.id === fin.id) ? prev : [fin, ...prev]);
            }
            // ORDERING IS THE CONTRACT — same rule as lib/syncBackground.ts.
            //
            // The ack must mean "this device HAS the message", never "this device
            // was told about a message". The server reclaims a body once every
            // recipient has acked, so an ack that outruns the local write leaves
            // a window where the message exists NOWHERE: not on the server, not
            // on disk. This previously acked before the persist below, on the
            // reasoning that the tick should not wait on decrypt — but only the
            // TONE needs to be instant, and it still is.
            //
            // Persist first, and ack only if the write actually succeeded. A
            // failed write leaves the pointer un-advanced, so the sync cursor
            // re-fetches the message on the next reconnect.
            try {
              await applyMessage(chatId, fin);   // persist plaintext to local cache
              if (me && fin.senderId !== me) markDeliveredDurable(chatId, fin.id, me).catch(() => {});
            } catch { /* not on disk → do NOT ack; catch-up re-delivers it */ }
            // Bump the "↓ N new" counter when a message lands while scrolled up.
            if (chatIdRef.current === chatId && !atBottomRef.current && fin.senderId !== me) setNewSinceUp(n => n + 1);
          })();
        };
        const onMemberDelivered = (e: { userId: string; lastDeliveredMessageId: number }) => {
          const cursor = Number(e?.lastDeliveredMessageId);
          if (!e?.userId || !Number.isSafeInteger(cursor) || cursor <= 0) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastDeliveredMessageId: Math.max(Number(mem.lastDeliveredMessageId) || 0, cursor) }
              : mem),
          } : prev);
          // Release the sender's recovery copies now that the recipient
          // demonstrably holds these messages. The outbox keeps an accepted row
          // (and its plaintext) precisely until this moment, because the server
          // body may already have been reclaimed and this is the only copy that
          // could re-deliver. Best-effort: the queue's age cap reaps anything
          // this misses, e.g. delivery that happened while the chat was closed.
          void queueNoteDelivered(chatId, cursor);
        };
        const onMemberRead = (e: { userId: string; lastReadMessageId: number }) => {
          const cursor = Number(e?.lastReadMessageId);
          if (!e?.userId || !Number.isSafeInteger(cursor) || cursor <= 0) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, lastReadMessageId: Math.max(Number(mem.lastReadMessageId) || 0, cursor) }
              : mem),
          } : prev);
        };
        const onEdit = (e: { id: number; content: string; editedAt: string }) => {
          const me = meIdRef.current;
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          // The server broadcasts an edit back to its author. `content` is the
          // replacement E2EE envelope, which its author cannot decrypt: a
          // double-ratchet sender only has the plaintext it just entered.
          // The optimistic edit already holds that text while editMessage()
          // persists it in the own-message store. Replacing it here turned the
          // sender's bubble into "unable to decrypt" before that write landed.
          // Keep the local plaintext and accept only the authoritative edit
          // timestamp for an edit of our own message.
          const current = messagesRef.current.find(x => x.id === eid);
          if (current && me && current.senderId === me) {
            setMessages(prev => prev.map(x =>
              x.id === eid ? { ...x, editedAt: e.editedAt } : x
            ));
            return;
          }
          // The edit event deliberately contains just the changed wire fields.
          // Merge them with the existing row, decrypt before painting, and
          // persist the result. The old direct replacement painted ciphertext
          // for recipients too until a later delta pull happened to repair it.
          if (!current) return; // global delta sync fetches rows not on screen
          void (async () => {
            const raw: Message = { ...current, content: e.content, editedAt: e.editedAt };
            let fin = raw;
            if (looksEncrypted(raw.content)) {
              try { fin = (await hydrateMessages(chatId, [raw], undefined, { live: true }))[0] ?? raw; }
              catch { /* retain the envelope for a later secure retry */ }
            }
            try { await applyMessage(chatId, fin); } catch { /* delta sync retries persistence */ }
            if (chatIdRef.current !== chatId) return;
            setMessages(prev => prev.map(x => x.id === eid ? fin : x));
          })();
        };
        const onDelete = (e: { id: number; deletedAt: string }) => {
          const eid = Number(e.id); // socket delivers id as string; rows hold numbers
          void persistMessageDeletion(chatId, eid, e.deletedAt);
          setMessages(prev => prev.map(x =>
            x.id === eid ? { ...x, content: null, deletedAt: e.deletedAt, type: 'system' } : x
          ));
        };
        const onTypingStart = (e: { uid: string; chatId?: string }) => {
          const me = meIdRef.current;
          // Fail closed while our own id is unknown — see the same guard in
          // (tabs)/chats.tsx. `e.uid === null` is false for every real id, so
          // without this the self-check silently stops guarding and the banner
          // reads "… is typing" back at the person doing the typing.
          if (!me) return;
          if (!e?.uid || e.uid === me || (e.chatId && e.chatId !== chatId)) return;
          setTypingUids(prev => {
            if (prev.has(e.uid)) return prev;
            const next = new Set(prev); next.add(e.uid); return next;
          });
        };
        const onTypingStop = (e: { uid: string; chatId?: string }) => {
          if (!e?.uid || (e.chatId && e.chatId !== chatId)) return;
          setTypingUids(prev => {
            if (!prev.has(e.uid)) return prev;
            const next = new Set(prev); next.delete(e.uid); return next;
          });
        };

        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {

          if (!e?.userId) return;
          setChat(prev => prev ? {
            ...prev,
            members: prev.members.map(mem => mem.userId === e.userId
              ? { ...mem, online: e.online, lastSeenAt: e.lastSeenAt ?? mem.lastSeenAt }
              : mem),
          } : prev);
        };

        // Reactions are now E2EE reference-messages in the ordered stream (F4) —
        // no separate reaction_added/removed socket events, no legacy fetch.
        const onScreenshotCaptured = (e: { chatId: string; capturedBy: string; capturedAt: string }) => {
          const me = meIdRef.current;
          // Server already filters to chat members — but ignore the
          // echo of our own capture and any cross-chat noise.
          // Fail closed while our own id is unknown: an unfiltered echo means
          // the person who took the screenshot gets the "someone captured your
          // content" banner, and the person it was taken from gets nothing.
          if (!me) return;
          if (!e || e.chatId !== chatId || e.capturedBy === me) return;
          setScreenshotBanner({ by: e.capturedBy, at: e.capturedAt });
        };
        // Poll-vote live updates. Server emits one event per (user, option)
        // change; for single-vote polls a "switch" arrives as one
        // poll_unvoted (old option) immediately followed by one poll_voted
        // (new option). Each handler patches counts + the caller's `mine`
        // set in place — no refetch needed.
        const onPollVoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          const me = meIdRef.current;
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, +1, e.userId === me));
        };
        const onPollUnvoted = (e: { messageId: number; userId: string; optionIndex: number }) => {
          const me = meIdRef.current;
          if (!e?.messageId) return;
          setPollVotes(prev => bumpPollVote(prev, e.messageId, e.optionIndex, -1, e.userId === me));
        };

        // VaultView remote revoke. The sender destroyed the media server-side;
        // this device destroys its per-file key and every decrypted copy, then
        // repaints the bubble as a tombstone. Irreversible by design — see
        // lib/protectedMedia.
        const onMediaRevoked = (e: { chatId: string; messageId: number; attachmentId: string }) => {
          if (!e?.attachmentId || e.chatId !== chatId) return;
          wipeRevokedMedia(e.attachmentId).catch(() => {});
          setMessages(prev => prev.map(m =>
            String(m.meta?.attachmentId ?? '') === String(e.attachmentId)
              ? { ...m, meta: { ...(m.meta || {}), revoked: true } }
              : m));
        };

        const onLiveLocation = (e: LiveLocationEvent) => {

          const me = meIdRef.current;
          if (!e?.userId || e.userId === me) return;
          if (e.blob) {
            // E2E path: decrypt the relayed blob with the per-session key the peer
            // delivered in the initial 'location' message. No key yet → ignore
            // (the key arrives via the E2E message; updates resume once we have it).
            const key = getLiveKey(chatId, e.userId);
            if (!key) return;
            const pos = decryptPosition(key, e.blob);
            if (pos) setLiveLoc({ userId: e.userId, latitude: pos.lat, longitude: pos.lng, address: pos.address });
          } else if (e.latitude != null) {
            // Legacy plaintext path (older sender): type- and range-checked
            // (socketPayloads), so a malformed pair is dropped, not pinned.
            const pos = legacyLivePosition(e);
            if (pos) setLiveLoc({ userId: e.userId, ...pos });
          }
        };
        const onLiveLocationStop = (e: LiveLocationStopEvent) => {
          setLiveLoc(prev => (prev && e?.userId === prev.userId) ? null : prev);
          if (e?.userId) clearLiveKey(chatId, e.userId);
        };

        s.on('live_location_update', onLiveLocation);
        s.on('live_location_stop',   onLiveLocationStop);
        s.on('new_message',       onNew);
        s.on('message_edited',    onEdit);
        s.on('message_deleted',   onDelete);
        s.on('message_delivered', onMemberDelivered);
        s.on('message_read',      onMemberRead);
        s.on('typing_start',      onTypingStart);
        s.on('typing_stop',       onTypingStop);
        s.on('presence_changed',  onPresence);
        s.on('screenshot_captured', onScreenshotCaptured);
        s.on('media_revoked',     onMediaRevoked);
        s.on('poll_voted',        onPollVoted);
        s.on('poll_unvoted',      onPollUnvoted);
        const onPinned = (e: PinnedEvent) => setPinnedId(pinnedIdOf(e));
        s.on('message_pinned',    onPinned);

        off.push(() => s.off('message_pinned', onPinned));
        off.push(() => s.off('live_location_update', onLiveLocation));
        off.push(() => s.off('live_location_stop',   onLiveLocationStop));
        off.push(() => s.off('new_message',       onNew));
        off.push(() => s.off('message_edited',    onEdit));
        off.push(() => s.off('message_deleted',   onDelete));
        off.push(() => s.off('message_delivered', onMemberDelivered));
        off.push(() => s.off('message_read',      onMemberRead));
        off.push(() => s.off('typing_start',      onTypingStart));
        off.push(() => s.off('typing_stop',       onTypingStop));
        off.push(() => s.off('presence_changed',  onPresence));
        off.push(() => s.off('screenshot_captured', onScreenshotCaptured));
        off.push(() => s.off('media_revoked',     onMediaRevoked));
        off.push(() => s.off('poll_voted',        onPollVoted));
        off.push(() => s.off('poll_unvoted',      onPollUnvoted));
      } catch (e) {
        if (!cancelled) console.warn('[chat] socket setup failed:', e instanceof Error ? e.message : e);
      }
    })();

    return () => {
      cancelled = true;
      off.forEach(fn => fn());
      leaveChatRoom(chatId).catch(() => {});
    };
  // Refs and state setters are stable for the screen's lifetime: one
  // subscription per chat, as when this effect lived in app/chat.tsx.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);
}
