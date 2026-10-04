// components/root/launchIntents.ts — taps and answers that arrive as a launch
// or resume intent rather than as a live event. Moved out of app/_layout.tsx
// unchanged; the root calls these from its boot effect.

import notifee from '@notifee/react-native';
import { getInitialCallIntent, drainDeclinedCall } from '../../lib/CallService';
import { consumePendingCall } from '../../lib/ringTracker';
import { getSocket } from '../../lib/socket';
import { deliverTap, hrefWithQuery } from '../../lib/pendingLink';
import type { AnsweredCall, IncomingCall } from './callRouting';

type OpenLink = (link: { pathname: string; params?: Record<string, string> }) => void;

// ── native launch intent (message tap / call tap) ────────────────────
//
// MUST BE RE-READ ON RESUME, NOT ONLY AT MOUNT.
//
// MainActivity is launchMode="singleTask", so when the app is already in
// memory — the normal case — a notification tap is delivered to
// onNewIntent, which calls setIntent() so getIntent() is current. But this
// block used to run once inside the mount effect, and nothing read the
// intent again afterwards. The extras arrived and were simply never
// consumed: the app came to the foreground on whatever screen it was
// already showing, so tapping a message notification opened the chat LIST
// instead of the chat.
//
// Verified on the Redmi: `am start` with the notification's own extras
// reported "intent has been delivered to currently running top-most
// instance" and the screen stayed on the list. It only ever worked from a
// COLD start, where the notification intent happens to BE the launch
// intent this effect reads.
//
// So the consumer is named and also fired on AppState 'active', which is
// exactly when a tap brings the app forward. getInitialCallIntent clears
// the extras as it reads them, so an ordinary resume with no pending tap
// reads null and does nothing — no navigation, no visual change.
export function makeNativeLaunchIntentConsumer({ openLink, routeToCall, routeToIncoming }: {
  openLink: OpenLink;
  routeToCall: (p: AnsweredCall) => void;
  routeToIncoming: (p: IncomingCall) => void;
}): () => Promise<void> {
  return async () => {
    try {
      const ci = await getInitialCallIntent();
      if (ci?.action === 'open_chat' && ci.chatId) {
        // Native message-notification tap (F2 content-free doorbell).
        openLink({ pathname: '/chat', params: { id: ci.chatId } });
      } else if (ci?.action === 'open_game') {
        // VaultGames turn/invite tap. game+room are carried through so the
        // WebView opens the exact table the push was about — landing on the
        // hub instead would make the player hunt for their own game.
        openLink({ pathname: '/games', params: { game: ci.game ?? '', room: ci.room ?? '' } });
      } else if (ci?.callId && ci.action !== 'open_calls') {
        // A GROUP ring answered from the lock screen must open the GROUP call.
        //
        // Every field here is shaped for 1:1 — peerUid is the caller, and the
        // 1:1 screens would place a call to THAT PERSON rather than joining the
        // group call the notification was about. `isGroup` rides the intent
        // from VaultCallMessagingService and defaults false, so a 1:1 ring and
        // any intent built by an older native build behave exactly as before.
        const to: (p: IncomingCall) => void = ci.action === 'answer' ? routeToCall : routeToIncoming;
        to({
          // Blank, not the placeholder — see the note on the socket ring
          // (components/root/callRouting.ts). peerUid stays the CALLER even for
          // a group: it is the de-dupe key both routers guard on, and an empty
          // one would collide with "no ring on screen" and silently refuse to
          // open the ring screen. The `group` flag decides the destination.
          chatId: ci.callId, peerUid: ci.callerId || '',
          peerName: ci.callerName || '',
          type: ci.isVideo ? 'video' : 'audio', offer: '',
          group: !!ci.isGroup, groupName: ci.callerName || '',
        });
      }
    } catch {}
  };
}

/** App launched/woken BY a notification → act on it once up. */
export async function consumeLaunchNotifications({ onCallAction, consumeNativeLaunchIntent }: {
  onCallAction: (action: string, data: any) => void;
  consumeNativeLaunchIntent: () => Promise<void>;
}): Promise<void> {
  try {
    const initial = await notifee.getInitialNotification();
    if (initial?.notification?.data?.type === 'call') {
      onCallAction(initial.pressAction?.id === 'decline' ? 'decline' : 'answer', initial.notification.data);
    }
    // A family alert tapped while the app was killed opens that circle's
    // alerts, as a foreground tap does (lib/push.ts attachTapHandler).
    // deliverTap, not openLink: the background handler may already have
    // delivered this same press, and it de-duplicates.
    else if (initial?.notification?.data?.type === 'family-alert') {
      deliverTap(hrefWithQuery('/family-alerts', { circleId: String(initial.notification.data.circleId ?? '') }));
    }
  } catch {}
  const pending = consumePendingCall();   // chosen from a bg notification action
  if (pending) onCallAction(pending.action, pending.data);

  // Native full-screen-intent (FCM) launch → open the in-app ringing screen.
  // The caller re-emits the offer over the socket; incoming-call captures it live.
  await consumeNativeLaunchIntent();

  // A decline tapped on the killed lock-screen notification → stop the caller's ring.
  try {
    const declined = await drainDeclinedCall();
    if (declined) getSocket().then(s => s.emit('webrtc_end', { chatId: declined })).catch(() => {});
  } catch {}
}
