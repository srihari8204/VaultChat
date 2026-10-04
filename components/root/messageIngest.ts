// components/root/messageIngest.ts — the root's persistent socket listeners for
// inbound messages: E2EE rekey requests, and new-message notifications with the
// family-event (famEvent) ingest. Moved out of app/_layout.tsx unchanged; the
// root attaches both in its boot effect and runs the cleanups on unmount.

import { addPersistentListener } from '../../lib/socket';
import { notify as notifyMessage, setSelfId } from '../../lib/messageNotifications';

// E2EE Stage-2 auto-recovery: a peer that couldn't decrypt us asks us to
// reset our session so our next message re-runs X3DH (persistent so it
// survives socket reconnects, like the call listener).
export function attachRekeyListener(): () => void {
  return addPersistentListener('e2ee_rekey', (data: any) => {
    const from = data?.from ?? data?.fromUid;
    // `force` marks a peer whose CALL setup failed — honoured immediately
    // rather than being held back by the anti-thrash window.
    //
    // `epoch` identifies WHICH breakage the peer is reporting, so a repeat of
    // a complaint we have already acted on can be recognised and dropped
    // instead of tearing down the session we rebuilt for it. Left undefined
    // by peers on older builds, which falls back to the timer alone.
    const epoch = typeof data?.epoch === 'number' ? data.epoch : undefined;
    if (from) import('../../lib/chatService').then(m => m.handleRekeyRequest(String(from), data?.force === true, epoch)).catch(() => {});
  });
}

// No-GMS background delivery (Phase 4): raise a local notification for each
// inbound message. Global + persistent so it fires while the app is
// backgrounded-but-alive (foreground-service connection). notify() self-gates
// (skips push-capable devices, foregrounded app, own echo, duplicates).
export function attachMessageIngest(): () => void {
  /** My user id, for the famEvent ingest below — the listener outlives any render. */
  let selfId: string | null = null;
  import('../../app/(constants)/authService').then(m => m.getCurrentUserAsync().then((u: any) => {
    setSelfId(u?.id ?? null);
    selfId = u?.id != null ? String(u.id) : null;   // famEvent ingest skips my own events
  })).catch(() => {});
  return addPersistentListener('new_message', (m: any) => {
    // famEvent envelopes ride `system`-type messages, and `type` is a
    // plaintext DB column — only `content` is E2EE (group chats default to
    // GROUP_E2EE=true). So `m.content` here is CIPHERTEXT for any encrypted
    // group, and a plain string match against it can never see the marker.
    // Found by review: the very first shipped version of this check tested
    // ciphertext and therefore never fired — every crossing kept buzzing the
    // phone as "new message" and the alerts inbox never filled remotely.
    //
    // Only `system`-type messages pay the decrypt cost here; every ordinary
    // text/media message skips straight to notifyMessage below, unchanged —
    // this does not weaken "never decrypt in the background" for the common
    // case. decryptFromChat self-routes on the envelope prefix and passes
    // plaintext/legacy content through untouched, so this is safe even for
    // a real (non-famEvent) system message like "X was added to the group".
    //
    // THE MESSAGE ID IS LOAD-BEARING, and it arrives as a STRING.
    // chatsPublicMsg emits `ID string` (fmt.Sprintf("%d")) — an in-repo
    // comment claiming the socket delivers a number is wrong. Getting this
    // wrong is not cosmetic: groupDecryptMessage only writes the plaintext
    // cache `if (messageId > 0)`, while the sender-key ratchet advances
    // UNCONDITIONALLY and does not retain the consumed iteration as a
    // skipped key (senderKey.ts: "too old / already used"). So decrypting
    // here without a real id would consume the ratchet step and cache
    // nothing — and the chat thread's own later decrypt of that same
    // message would throw, leaving EVERY group system message permanently
    // unreadable. With the real id, the plaintext is cached and the thread
    // gets a cache hit instead of a second ratchet step.
    const msgId = Number(m?.id);
    // No usable id → do NOT decrypt at all. Falling through to a plain
    // notification is the old behaviour (a famEvent may buzz once); a
    // corrupted ratchet is not recoverable.
    if (m?.type === 'system' && typeof m?.content === 'string' && m?.chatId
        && Number.isFinite(msgId) && msgId > 0) {
      Promise.all([import('../../lib/chatService'), import('../../lib/family/alerts')])
        .then(async ([cs, a]) => {
          const plain = await cs.decryptFromChat(
            String(m.chatId), String(m.senderId ?? ''), m.content, msgId);
          if (a.isFamEvent(m.type, plain)) {
            a.ingestFamEvent(String(m.chatId), plain, String(selfId ?? ''));
            return; // muted — the alerts badge is this message's surface, not a banner
          }
          notifyMessage(m).catch(() => {});
        })
        // Decrypt/import itself failed (not "not a famEvent" — parseFamEvent
        // already returns null for that) — fail OPEN to a notification. A
        // spurious "New message" banner is recoverable; a silently dropped
        // real message is not.
        .catch(() => { notifyMessage(m).catch(() => {}); });
      return;
    }
    notifyMessage(m).catch(() => {});
    // VaultBeam auto-download (flag-gated; no-op when off / not a vaultbeam msg).
    if (m?.meta?.vaultbeam) import('../../lib/vaultBeamIngest').then(v => v.onIncomingVaultbeamMessage(m)).catch(() => {});
  });
}
