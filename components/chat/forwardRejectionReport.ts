// components/chat/forwardRejectionReport.ts — the app-wide report of a forward
// the server rejected (components/chat/forwardFeedback), shared by the chat
// screen (each forward) and the root's boot sequence (armed before the outbox
// drains, so a forward queued before an app restart and rejected now is still
// reported, by the name its outbox row carries).

import { Alert } from 'react-native';
import { appForwardFeedback, type ForwardQueueBus } from './forwardFeedback';

// A forward the server REJECTS (blocked, not a member, too large) turns red in
// the target chat only; say so wherever the user is now. Offline is not a
// rejection — the outbox keeps the clock and retries, so no alert. Module
// scope: the app-wide tracker outlives any one chat screen, so the report must
// not close over one mounted instance.
export function reportForwardRejection(name: string, error: string) {
  Alert.alert(`Not forwarded to ${name}`,
    `${error || 'The server refused it.'}\n\nIt is marked “not sent” in ${name}, where you can retry or cancel it.`);
}

/** The one app-wide forward tracker, subscribed to the queue's bus on first call. */
export function armForwardRejectionReport(on: ForwardQueueBus) {
  return appForwardFeedback(on, reportForwardRejection);
}
