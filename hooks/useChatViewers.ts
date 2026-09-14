// hooks/useChatViewers.ts — Live Chat Viewers (feature #58).
//
// Ephemeral "who is viewing this chat right now". ALWAYS listens (to render
// others); only EMITS my own presence when `enabled` (per-chat toggle) and the
// screen is focused. Heartbeat every 10s; LEFT on blur/unmount/background; the
// server expires anyone stale for 30s. Nothing is persisted anywhere.

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getSocket, emitChatView, addPersistentListener, type ViewerActivity } from '../lib/socket';

export type Viewer = { userId: string; activity: ViewerActivity };

const HEARTBEAT_MS = 10000;

export function useChatViewers(opts: {
  chatId: string | undefined;
  meId: string | null;
  enabled: boolean;                 // per-chat toggle + not ghosted → emit my presence
  focused: boolean;                 // chat screen focused
  activity: ViewerActivity;         // my current local activity (reading/typing/uploading)
}): Viewer[] {
  const { chatId, meId, enabled, focused, activity } = opts;
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const activityRef = useRef<ViewerActivity>(activity);
  activityRef.current = activity;

  // ── Listen for others (independent of whether I emit) ──────────────
  useEffect(() => {
    // Also gated on meId, not just chatId. Every handler below decides "is this
    // me?" with `id === meId`, and that comparison is FALSE for everyone while
    // meId is still null — so subscribing early does not merely miss the filter,
    // it adds US to the viewer list and renders our own "typing" back at us.
    // The effect re-runs when meId arrives, so nothing is permanently lost.
    if (!chatId || !meId) return;
    const mine = (id?: string) => id && id === meId;

    const onList = (d: any) => {
      if (d?.chatId !== chatId) return;
      setViewers((d.viewers || []).filter((v: Viewer) => !mine(v.userId)));
    };
    const onJoin = (d: any) => {
      if (d?.chatId !== chatId || mine(d.userId)) return;
      setViewers(vs => vs.some(v => v.userId === d.userId)
        ? vs.map(v => v.userId === d.userId ? { ...v, activity: d.activity || 'reading' } : v)
        : [...vs, { userId: d.userId, activity: d.activity || 'reading' }]);
    };
    const onLeft = (d: any) => {
      if (d?.chatId !== chatId) return;
      setViewers(vs => vs.filter(v => v.userId !== d.userId));
    };
    const onAct = (d: any) => {
      if (d?.chatId !== chatId || mine(d.userId)) return;
      setViewers(vs => vs.map(v => v.userId === d.userId ? { ...v, activity: d.activity } : v));
    };

    const offs = [
      addPersistentListener('viewer_list', onList),
      addPersistentListener('viewer_joined', onJoin),
      addPersistentListener('viewer_left', onLeft),
      addPersistentListener('viewer_activity', onAct),
    ];
    return () => { offs.forEach(f => f()); setViewers([]); };
  }, [chatId, meId]);

  // ── Emit my presence while focused + enabled ───────────────────────
  useEffect(() => {
    if (!chatId || !enabled || !focused) return;
    let stopped = false;

    emitChatView(chatId, 'VIEWING', activityRef.current, true).catch(() => {});
    const hb = setInterval(() => {
      if (!stopped) emitChatView(chatId, 'VIEWING', activityRef.current).catch(() => {});
    }, HEARTBEAT_MS);

    // Re-announce + resync the list on socket reconnect.
    let offConnect = () => {};
    (async () => {
      try {
        const s = await getSocket();
        // Cleanup may have run while getSocket() was pending — offConnect was
        // still the no-op stub then, so attaching now would leave the handler on
        // the app-lifetime socket, re-announcing "is viewing" on every reconnect
        // for a chat the user already left.
        if (stopped) return;
        const onConnect = () => emitChatView(chatId, 'VIEWING', activityRef.current, true).catch(() => {});
        s.on('connect', onConnect);
        offConnect = () => { try { s.off('connect', onConnect); } catch {} };
      } catch {}
    })();

    // App background = leave; foreground = re-announce.
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active') emitChatView(chatId, 'VIEWING', activityRef.current, true).catch(() => {});
      else emitChatView(chatId, 'LEFT').catch(() => {});
    });

    return () => {
      stopped = true;
      clearInterval(hb);
      offConnect();
      appSub.remove();
      emitChatView(chatId, 'LEFT').catch(() => {});
    };
  }, [chatId, enabled, focused]);

  // ── Activity change → push immediately so peers see typing/uploading fast ──
  useEffect(() => {
    if (!chatId || !enabled || !focused) return;
    emitChatView(chatId, 'VIEWING', activity).catch(() => {});
  }, [activity, chatId, enabled, focused]);

  return viewers;
}

export default useChatViewers;
