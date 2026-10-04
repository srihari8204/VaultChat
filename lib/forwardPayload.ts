// lib/forwardPayload.ts — what a forward sends, decided in one place.
//
// The rules lib/chatService.ts forwardMessage() applies, as a pure function,
// so the chat screen can hand the result to the outbox (messageQueue
// .enqueueMessage) instead of posting directly. Import-free apart from
// forwardPolicy (itself import-free), so lib/forwardPayload.selftest.ts runs
// under plain tsx.

import { nextForwardScore } from './forwardPolicy';

export interface ForwardSource {
  id: number;
  chatId: string;
  senderId: string;
  type: string;
  content: string | null;
  meta?: Record<string, any> | null;
}

export interface ForwardPayload {
  type: string;
  plaintext: string;
  meta: Record<string, any>;
}

/**
 * The message a forward of `source` sends. Throws for view-once and Invisible
 * Ink: stripping only the flag would re-send the protected body as an
 * ordinary, permanent message (the UI hides Forward for these; this is the
 * backstop). A sender-local file path means nothing on another device, so
 * `localUri` never travels. No reply context: a forward shows "Forwarded".
 */
export function forwardPayload(source: ForwardSource): ForwardPayload {
  if (source.meta?.viewOnce || source.meta?.invisibleInk) {
    throw new Error('View-once and invisible-ink messages cannot be forwarded.');
  }
  const { localUri: _localUri, viewOnce: _viewOnce, invisibleInk: _invisibleInk, ...meta } = source.meta ?? {};
  return {
    type: source.type,
    plaintext: source.content ?? '',
    meta: {
      ...meta,
      forwardedFrom: { messageId: source.id, chatId: source.chatId, senderId: source.senderId },
      // How many hops this has made, counted from the SOURCE's meta so a chain
      // keeps counting (lib/forwardPolicy.ts — signalling, not a control).
      forwardScore: nextForwardScore(source.meta),
    },
  };
}
