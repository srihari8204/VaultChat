// components/family/useHubSafety.ts — the Family hub's on-device safety
// watchers, moved out of app/family.tsx unchanged: watch alerts for OTHER
// members (low battery, went quiet) and crash detection on MY device.

import { useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { Accelerometer } from 'expo-sensors';
import { recordAlert } from '../../lib/family/alerts';
import { deriveWatchAlerts, emptyWatchState } from '../../lib/family/watchAlerts';
import { emptyCrashState, feedSpeed, feedImpact, COUNTDOWN_S } from '../../lib/family/crash';
import { type CircleMember, type MemberPresence } from '../../lib/family/types';

/**
 * Watch alerts: low battery + went-quiet for OTHER members. Derived HERE, on
 * the viewing device, from presences already decrypted — a member's battery
 * rides every ping and their silence is the absence of pings, so only a
 * watcher can raise either. Edge-detected in the pure engine (one episode =
 * one alert); recordAlert's 60s dedupe absorbs the hub and map both deriving.
 * State resets per circle.
 */
export function useWatchAlerts({ activeId, myId, members, membersLoaded, presences, tick }: {
  activeId: string | undefined;
  myId: string | undefined;
  members: CircleMember[];
  membersLoaded: boolean;
  presences: Record<string, MemberPresence>;
  /** Drives the quiet detection: silence, by definition, changes no state. */
  tick: number;
}) {
  const watchRef = useRef(emptyWatchState());
  useEffect(() => { watchRef.current = emptyWatchState(); }, [activeId]);
  useEffect(() => {
    if (!activeId || !myId || !membersLoaded) return;
    const nameById = new Map(members.map((mm) => [mm.id, mm.name]));
    const snaps = Object.entries(presences)
      .filter(([uid]) => uid !== myId)
      .map(([uid, p]) => ({
        id: uid, name: nameById.get(uid) || 'A member',
        battery: p.battery, charging: p.charging, ts: p.ts, sharingOff: p.sharingOff,
      }));
    if (!snaps.length) return;
    const r = deriveWatchAlerts(watchRef.current, snaps, Date.now());
    watchRef.current = r.state;
    for (const a of r.alerts) {
      recordAlert({ circleId: activeId, kind: a.kind, actorId: a.actorId, actorName: a.actorName, text: a.text })
        .catch(() => {});
    }
  }, [presences, tick, activeId, myId, members, membersLoaded]);
}

/**
 * Crash detection (MY device): impact after driving → countdown → SOS.
 * The accelerometer is armed only while sharing is on — the situation a
 * family expects protection in — and the decision logic is pure and
 * self-checked (lib/family/crash). A suspect opens a loud full-screen
 * countdown; SOS fires unless the person says they are OK.
 */
export function useCrashDetection({ armed, presences, myId, onSos }: {
  armed: boolean;
  /** Every presence update re-reads my speed, as the hub always did. */
  presences: Record<string, MemberPresence>;
  myId: string | undefined;
  onSos: () => void;
}) {
  const crashRef = useRef(emptyCrashState());
  const [crashAsk, setCrashAsk] = useState(false);
  const [crashLeft, setCrashLeft] = useState(COUNTDOWN_S);
  // The countdown always fires the CURRENT SOS handler, whichever render it
  // ends on.
  const sosRef = useRef(onSos);
  sosRef.current = onSos;
  useEffect(() => {
    const sp = myId ? presences[myId]?.speed : undefined;
    crashRef.current = feedSpeed(crashRef.current, sp ?? null, Date.now());
  }, [presences, myId]);
  useEffect(() => {
    if (!armed) return;
    Accelerometer.setUpdateInterval(200);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const g = Math.sqrt(x * x + y * y + z * z);
      const r = feedImpact(crashRef.current, g, Date.now());
      crashRef.current = r.state;
      if (r.suspect) {
        setCrashLeft(COUNTDOWN_S);
        setCrashAsk(true);
        Vibration.vibrate([0, 600, 200, 600, 200, 600]);
      }
    });
    return () => sub.remove();
  }, [armed]);
  useEffect(() => {
    if (!crashAsk) return;
    if (crashLeft <= 0) { setCrashAsk(false); sosRef.current(); return; }
    const t = setTimeout(() => setCrashLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [crashAsk, crashLeft]);
  return {
    crashAsk, crashLeft,
    /** "I'm OK" — stops the countdown. */
    dismiss: () => setCrashAsk(false),
    /** "Send SOS now". */
    sendNow: () => { setCrashAsk(false); sosRef.current(); },
  };
}
