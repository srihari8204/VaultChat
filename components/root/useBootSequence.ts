// components/root/useBootSequence.ts — the root's boot sequence: the work every
// app open starts once the first render has happened (socket warm-up, the
// background security scan, key publishing, sync and outbox drains, deferred
// maintenance) and the notification / call-intent routing it wires up.
// Moved out of app/_layout.tsx unchanged; the launch gate and the veil stay
// there. Selftests that pin this text read both files (scripts/rootLayoutSources.ts).

import { type ComponentType, type RefObject, useEffect, useState } from 'react';
import type { Href, Router } from 'expo-router';
import { AppState, InteractionManager, Platform } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import { setSecure } from '../../lib/screenGuard';
import { primeChats } from '../../lib/chatsPrefetch';
import { runSecurityCheck } from '../../services/securityService';
import { attachTapHandler } from '../../lib/push';
import { getSocket } from '../../lib/socket';
import { registerForCalls } from '../../lib/CallService';
import { setRingingPeer, setRingScreenPeer } from '../../lib/ringTracker';
import { cancelIncomingCall } from '../../lib/callNotification';
import { getAccessToken } from '../../lib/api';
import { currentLaunchDecision } from '../../lib/launchGate';
import { hrefWithQuery, onDeliveredTap, openWhenUnlocked } from '../../lib/pendingLink';
import { holdSecurityVerdict } from '../../lib/securityVerdict';
import { E2EE_ENABLED } from '../../constants/flags';
import { mark } from '../../lib/perf';
import { type AnsweredCall, type IncomingCall, attachIncomingCallListener, makeCallActionHandler, openIncomingCall } from './callRouting';
import { consumeLaunchNotifications, makeNativeLaunchIntentConsumer } from './launchIntents';
import { attachMessageIngest, attachRekeyListener } from './messageIngest';

/**
 * Runs the boot sequence once per root mount (deps [router]) and returns the
 * PDF thumbnail host once the deferred work has loaded it (null until then).
 * `pathRef` is the root's current route, read by the notification-tap gate;
 * the effect outlives renders, so it must be a ref.
 */
export function useBootSequence(router: Router, pathRef: RefObject<string>): ComponentType | null {
  const [PdfHost, setPdfHost] = useState<ComponentType | null>(null);

  useEffect(() => {
    // Boot timeline. These marks are what make a startup claim checkable
    // instead of asserted — read them on-device from app/perf-debug.tsx:
    //   boot_effect_start  → this effect begins
    //   db_ready           → op-sqlite open (marked in the promise below)
    //   boot_unblocked     → first render is no longer gated
    //   boot_deferred_start→ the first frame has settled; deferred work begins
    // The gap boot_effect_start → boot_unblocked is cold-start cost the user
    // actually feels; anything after boot_deferred_start is off that path.
    mark('boot_effect_start');

    // THIS mount's launch decision. The root re-arms it during its first render
    // (beginLaunchGate, before any effect), so read it here, once. The
    // process-wide launchAllowed says how the FIRST mount decided; after a
    // root remount it would gate /blocked and notification taps by that stale
    // answer while the new gate is still deciding (app/index.tsx reads the
    // same per-mount decision).
    const launchDecision = currentLaunchDecision();

    // START THE SOCKET HANDSHAKE FIRST, but INSIDE the boot sequence.
    //
    // The connection must not wait for the rest of this effect: the TLS +
    // WebSocket + auth round trips are the slowest part of coming online, and
    // kicking them here overlaps them with the render instead of serialising
    // them after it. Fire-and-forget: getSocket() de-duplicates (the persistent
    // listeners armed further down join this same in-flight attempt rather than
    // opening a second socket), it refuses cleanly with "Not signed in" when
    // there is no token yet, and addPersistentListener's own retry ladder still
    // owns recovery. Nothing here changes WHAT connects or with which
    // credentials — only when the attempt starts.
    //
    // It used to sit at MODULE SCOPE, which ran it during bundle evaluation —
    // before React mounted, before boot_effect_start, and racing everything else
    // this effect owns. First line of the controlled sequence gets the same
    // overlap with one ordered timeline instead of two.
    //
    // Safe only because connect() re-applies persistent listeners on the
    // 'connect' event: this warm-up builds the socket before any listener is
    // registered, and without that re-apply an incoming call would attach to
    // nothing. See lib/socket.ts.
    try { void getSocket().catch(() => {}); } catch { /* never block boot */ }

    // ── 2. Google Sign-In is NOT configured here any more ───────
    // It used to be a synchronous require of ./(constants)/authService +
    // configureGoogleSignIn() on every launch, which parsed
    // @react-native-google-signin for users who never sign in with Google.
    // Each SDK entry point now configures itself instead: signInWithGoogle /
    // signOutGoogle (authService), pickGoogleAccount (lib/onboarding) — the
    // pattern lib/googleDrive.ts already used. See the note on
    // configureGoogleSignIn for why repeating it is also the correct fix.

    // ── 3. Security scan runs in the BACKGROUND ─────────────────
    // It used to be awaited before the first paint — and its two localhost
    // Frida probes alone can stall ~1.4s — so cold start felt slow. The scan
    // wipes keys + redirects to /blocked ITSELF if the device is compromised,
    // so running it async (without gating the UI) is safe and WhatsApp-fast.
    if (Platform.OS !== 'web') {
      runSecurityCheck()
        .then(async report => {
          if (!report.clean) {
            // /blocked reads the verdict from here, not from its params, so a
            // crafted link cannot fake one (lib/securityVerdict.ts). `level`
            // matters to the copy: only a `wipe` verdict destroyed keys.
            holdSecurityVerdict(report);
            // AFTER the launch gate: its replace('/onboard' | '/app-lock') would
            // otherwise land on top of the verdict and hide it.
            await launchDecision;
            router.replace('/blocked');
          }
        })
        .catch(() => { /* fail open */ });

    }

    // Publish this device's E2EE key bundle on startup (lazy, fire-and-forget).
    getAccessToken()
      .then(tok => {
        // FIRST, and before the crypto work below: this is a network request
        // whose answer the Chats screen will block on in a few hundred ms, and
        // everything after it here is local. See lib/chatsPrefetch.ts for the
        // measurements — the request used to be dispatched at +395ms simply
        // because that is when the screen mounted.
        if (tok) primeChats();
        if (tok && E2EE_ENABLED) {
          import('../../services/crypto/e2eeSession.rn').then(m => m.provisionE2EEIdentity()).catch(() => {});
        }
        // Register the native FCM token so calls ring when the app is killed.
        if (tok) registerForCalls();
      })
      .catch(() => {});

    // Nothing in this effect gates the first render.
    mark('boot_unblocked');

    // (attachTapHandler is wired below, after the call handlers are defined)
    let cleanupListeners = () => {};

    // A NOTIFICATION TAP NEVER OPENS A SCREEN OVER THE LOCK.
    //
    // These taps used to router.push() as soon as they fired, racing the
    // launch gate's replace('/app-lock' | '/onboard') on a cold start and
    // ResumeLock's push('/app-lock') on resume — a chat could land ON TOP of
    // the lock, and a cold-start push could keep the veil from ever latching
    // down. Now they wait for the gate and any resume-lock decision, and are
    // held for replay after unlock when either is locking (lib/pendingLink).
    // Call routes are deliberately NOT gated: a ring must be answerable from
    // the lock screen, as the OS full-screen call already is.
    const openHref = (href: string) => {
      void openWhenUnlocked(href, launchDecision, () => pathRef.current,
        (h) => router.push(h as Href)).catch(() => {});
    };
    const openLink = ({ pathname: path, params }: { pathname: string; params?: Record<string, string> }) =>
      openHref(hrefWithQuery(path, params));
    // Taps from notifee's background handler (lib/callBackground) — a family
    // alert pressed while the app was backgrounded, or before this mounted.
    const offDeliveredTap = onDeliveredTap(openHref);

    // Open the in-app ringing screen (components/root/callRouting).
    const routeToIncoming = (p: IncomingCall) => openIncomingCall(router, p);

    // ── Notifee full-screen call events (foreground) ────────────────────
    // ANSWERED FROM THE OS — go straight into the call.
    //
    // The OS ring IS the ring. Routing an explicit Answer through the in-app
    // ring screen made the user accept twice: the notification's Answer, then
    // a second full-screen overlay that appeared on top of it. Reported on
    // device exactly that way.
    //
    // Safe now because the call screen no longer needs the caller's envelope to
    // answer — the chat identifies the call (see engine.acceptIncoming).
    // ONE CALL SCREEN PER ANSWER.
    //
    // routeToCall is reachable from FOUR places: the native answer intent
    // (consumeNativeLaunchIntent) and three notifee handlers — the foreground
    // event, the initial notification, and the background handler. More than one
    // firing for a single answer is NORMAL, not exceptional, and each did its
    // own router.push. Two pushes mount two call screens, and each screen's
    // effect starts its own session — the second replacing the first via
    // bootstrap's hangUp('replaced').
    //
    // That is the "it makes too many calls" report: two call ids seconds apart
    // on one chat, ringing the callee twice. The engine now holds a setup claim
    // too (lib/call/engine.ts); stopping it here means the duplicate screen is
    // never mounted at all.
    //
    // Keyed by peer+kind and TIME-BOXED, so a genuine second call to the same
    // person a minute later still opens a screen.
    const routedCalls = new Map<string, number>();
    // 2s, not 10s. The duplicate handlers fire within MILLISECONDS of each
    // other (same answer event, several listeners), so a short window collapses
    // them just as well. Ten seconds was over-aggressive: answer, hang up, and
    // answer again inside that window and the second call screen would never
    // open — a worse bug than the one being fixed.
    const ROUTE_DEDUPE_MS = 2_000;
    const routeToCall = (p: AnsweredCall) => {
      const dedupeKey = `${p.peerUid}|${p.type}|${p.group ? 'g' : 'd'}`;
      if (Date.now() - (routedCalls.get(dedupeKey) ?? 0) < ROUTE_DEDUPE_MS) return;
      routedCalls.set(dedupeKey, Date.now());
      cancelIncomingCall();
      // CLAIM the ring, do not release it.
      //
      // Clearing these was a bug I introduced with this route: the caller keeps
      // re-ringing every 3s until the call connects, and routeToIncoming's
      // guard is exactly `getRingScreenPeer() === peerUid`. With it cleared,
      // the next ring opened the in-app ring screen ON TOP of the call the user
      // had just answered — the overlay that survived the first fix.
      //
      // Claiming it means "this peer's ring is already being handled here". The
      // call screens release it when they unmount.
      setRingingPeer(p.peerUid);
      setRingScreenPeer(p.peerUid);
      if (p.group) {
        router.push({ pathname: '/group-call-active',
          params: { chatId: p.chatId || '', video: p.type === 'video' ? '1' : '0', name: p.groupName || p.peerName } });
        return;
      }
      router.push({
        pathname: p.type === 'video' ? '/videocall' : '/voicecall',
        params: { chatId: p.chatId || '', peerUid: p.peerUid, peerName: p.peerName, isIncoming: 'true' },
      });
    };
    const onNotifeeAnswerOrDecline = makeCallActionHandler(routeToCall);

    // ── Incoming-call listener (realtime) ──────────────────────────────
    const cleanupCallListener = attachIncomingCallListener(routeToIncoming);
    // E2EE rekey requests and inbound-message notifications (components/root/messageIngest).
    const cleanupRekey = attachRekeyListener();

    // ── Boot work that the user is WAITING for ─────────────────────────
    // These four decide what the first screen shows, so they start now:
    // catch-up on messages missed while offline, re-flush dropped receipts,
    // resume interrupted media sends, and drain the text outbox.
    import('../../lib/syncEngine').then(m => m.initSync()).catch(() => {});
    import('../../lib/receipts').then(m => m.initReceipts()).catch(() => {});
    import('../../lib/mediaOutbox').then(m => m.initMediaOutbox()).catch(() => {});
    // The TEXT outbox belongs here for the same reason the media one does, and
    // it was the only one missing. Its sole other caller is the chat screen's
    // mount effect, so until some individual chat was opened there was no boot
    // drain, no NetInfo reconnect flush and no periodic tick — queue messages
    // offline, restart, stop at the chat list, regain network, and nothing sent.
    // It also left `online` stale-true, since only initQueue's listener writes it.
    import('../../lib/messageQueue').then(m => {
      // Report a forward the server rejects on this drain by the name its
      // outbox row carries (queued before a restart, so no chat screen tracked
      // it). Armed only once THIS mount's gate let the launch in: the Alert
      // names a chat, and must not appear over the lock or sign-in screen.
      // Never in the way of the drain itself.
      void launchDecision.then(ok => ok
        ? import('../chat/forwardRejectionReport').then(r => { r.armForwardRejectionReport(m.on); })
        : undefined).catch(() => {});
      m.initQueue();
    }).catch(() => {});

    // ── Boot work that can wait for the first frame ────────────────────
    // Neither of these changes anything the user can see on the chat list, and
    // both are I/O heavy at exactly the wrong moment: resumePendingSends reads
    // transfer state and re-opens uploads, and sweepMediaCache walks the media
    // cache directory. Running them during the first render competes with the
    // JS thread for no visible benefit.
    //
    // runAfterInteractions defers to after the initial render/animation settles
    // — NOT a fixed timeout, so on a slow device it waits longer and on a fast
    // one it barely waits at all. Both remain fire-and-forget and keep their own
    // error handling, so a deferred failure is still contained.
    const deferred = InteractionManager.runAfterInteractions(() => {
      mark('boot_deferred_start');
      // VaultBeam: resume any relay upload interrupted by an app kill (the
      // recipient resumes symmetrically via the server bitmask).
      import('../../lib/vaultBeamController').then(m => m.resumePendingSends()).catch(() => {});
      // Bound the re-derivable media cache (safe: never touches the user's library).
      import('../../lib/mediaCacheGC').then(m => m.sweepMediaCache()).catch(() => {});
      // One-time: drain the legacy external media tree
      // (/Android/media/<pkg>/crazzychat) into the private sandbox, then delete
      // it. That tree is the reason media used to survive uninstall. Self-gating
      // (no-ops once complete), resumable, and never fatal — see lib/mediaMigration.
      import('../../lib/mediaMigration').then(m => m.migrateLegacyMedia()).catch(() => {});
      // One-time: delete the abandoned 'vc_pending_signup' record. On old builds
      // it sat in AsyncStorage IN THE CLEAR, and it contains two account-recovery
      // answers — the credential /auth/security-questions/verify trades for a
      // session. The signup flow that wrote it is gone, so nothing will ever read
      // it again; boot is the only place left that can reach the plaintext.
      import('../../app/(constants)/authService').then(m => m.purgeLegacyPendingSignup()).catch(() => {});
      import('../PdfThumbnailer').then(m => setPdfHost(() => m.PdfThumbnailerHost)).catch(() => {});
      if (Platform.OS !== 'web') {
        // Warm up the local message store after the first frame; screens that
        // need it still open it directly if the user gets there first.
        // db_open_start/db_ready are marked inside getLocalDb itself — this
        // warm-up usually observes a promise index.tsx already resolved.
        import('../../lib/localDb')
          .then(m => m.getLocalDb())
          .catch((e: any) => console.warn('[db] localDb init failed:', e?.message));
        // Passive monitoring and cache maintenance have no first-frame output.
        // Their native/headless registrations remain module-scope imports above.
        import('../../services/security/deviceSecurity/monitorService')
          .then(m => m.runMonitoringScan('launch')).catch(() => {});
        import('../../services/security/deviceSecurity/monitorTriggers')
          .then(m => m.startSecurityMonitoring()).catch(() => {});
        import('../../services/cache/cacheManager')
          .then(m => m.maybeAutoClean()).catch(() => {});
        // A chat export killed mid-write leaves a PLAINTEXT file in the cache
        // folder; remove it now instead of when the export screen next opens.
        // Deletes files only (reads no content), so it needs no unlock.
        import('../chattools/chatExportFile')
          .then(m => m.sweepExportFiles()).catch(() => {});
      }
    });

    const cleanupMsgNotif = attachMessageIngest();

    // A tap delivered as the native launch/resume intent; re-read on every
    // foreground (components/root/launchIntents).
    const consumeNativeLaunchIntent = makeNativeLaunchIntentConsumer({ openLink, routeToCall, routeToIncoming });
    const launchIntentSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') consumeNativeLaunchIntent();
    });

    const notifeeFg = notifee.onForegroundEvent(({ type, detail }) => {
      // Scheduled-message trigger fired (#73) → send any due items.
      if (detail?.notification?.data?.type === 'scheduled_fire') {
        import('../../lib/scheduledRunner').then(m => m.runDueScheduled()).catch(() => {});
        return;
      }
      if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) return;
      onNotifeeAnswerOrDecline(detail?.pressAction?.id === 'decline' ? 'decline' : 'answer', detail?.notification?.data);
    });

    // App launched/woken BY a notification → act on it once up.
    void consumeLaunchNotifications({ onCallAction: onNotifeeAnswerOrDecline, consumeNativeLaunchIntent });

    // Expo notification tap / actions (heads-up call push fallback).
    const onCallNotification = (data: any, action: string) =>
      onNotifeeAnswerOrDecline(action === 'decline' ? 'decline' : 'answer', { ...data, type: 'call' });

    if (Platform.OS !== 'web') {
      cleanupListeners = attachTapHandler(
        (chatId) => { openLink({ pathname: '/chat', params: { id: chatId } }); },
        onCallNotification,
        // Membership pushes: an accepted member lands in the space, an invitee
        // lands on the invitation itself — never in a chat they cannot open.
        (event, chatId) => {
          if (event === 'member_approved' && chatId) {
            openLink({ pathname: '/family', params: { groupId: chatId } });
          } else {
            openLink({ pathname: '/group-invitations' });
          }
        },
        // A games turn push: land ON the table, not on the hub. An unknown game
        // or a blank room opens the hub, which is what /games does with params
        // it does not recognise anyway.
        (game, room) => {
          openLink({ pathname: '/games', params: game && room ? { game, room } : {} });
        },
        // A family alert tapped while the app is open waits for any lock, like the rest.
        (circleId) => { openLink({ pathname: '/family-alerts', params: { circleId } }); },
      );
    }

    return () => {
      if (Platform.OS !== 'web') {
        setSecure(false).catch(() => {});
      }
      deferred.cancel();   // don't run deferred boot work after unmount
      launchIntentSub.remove();
      cleanupListeners();
      offDeliveredTap();
      cleanupCallListener();
      cleanupRekey();
      cleanupMsgNotif();
      notifeeFg();
    };
  }, [router, pathRef]);

  return PdfHost;
}
