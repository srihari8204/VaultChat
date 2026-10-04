// components/family/useHubSos.ts — the hub's hold-to-SOS, moved out of
// app/family.tsx unchanged: the hold gesture (progress ring + timer), and what
// firing does — the message first, then live sharing, then ONE dialog.

import { useRef, type MutableRefObject } from 'react';
import { Alert, Animated, Linking, Vibration } from 'react-native';
import * as Location from 'expo-location';
import { type Router } from 'expo-router';
import { canShareInBackground } from '../../lib/family/presence';
import { recordAlert } from '../../lib/family/alerts';
import { sendMessage } from '../../lib/chatService';

const SOS_HOLD_MS = 1500;
/** Oldest cached fix an SOS message may quote as the sender's position. */
const SOS_FIX_MAX_AGE_MS = 5 * 60_000;

export function useHubSos({ active, me, toggleShare, bgAsked, enableBackgroundSharing, router, onSent }: {
  active: { id: string } | null;
  me: { id: string; name: string } | null;
  /** useHubSharing's switch: (on, quiet) → whether sharing is now live. */
  toggleShare: (on: boolean, quiet?: boolean) => Promise<boolean>;
  bgAsked: MutableRefObject<boolean>;
  enableBackgroundSharing: () => void;
  router: Router;
  /** Something was sent: re-pull the highlights. */
  onSent: () => void;
}) {
  const sosProg = useRef(new Animated.Value(0)).current;
  const sosTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireSos = async () => {
    sosProg.setValue(0);
    if (!active || !me) return;
    Vibration.vibrate([0, 400, 150, 400]);
    // THE MESSAGE GOES FIRST. Turning sharing on can raise the location,
    // background-location and battery-exemption system dialogs, and a high-
    // accuracy fix can take tens of seconds — none of that may stand between
    // the user and the alert. The OS's cached fix is instant and prompt-free
    // (it throws without permission, which just means no coordinates); live
    // sharing, started right after, supplies the real position.
    // The cache can be hours old, and a stale fix sent as "where I am" sends
    // the circle to the wrong place — so it only goes when it is recent.
    try {
      let where = ' (location unavailable)';
      try {
        const c = await Location.getLastKnownPositionAsync({ maxAge: SOS_FIX_MAX_AGE_MS });
        if (c && Date.now() - c.timestamp <= SOS_FIX_MAX_AGE_MS) {
          where = ` (${c.coords.latitude.toFixed(5)}, ${c.coords.longitude.toFixed(5)})`;
        }
      } catch {}
      await sendMessage(active.id, `🆘 ${me.name} triggered an SOS — please respond${where}`, 'system');
    } catch (e: any) { Alert.alert('SOS', e?.message ?? 'Could not send SOS.'); return; }
    recordAlert({
      circleId: active.id, kind: 'sos', actorId: me.id, actorName: me.name,
      text: `${me.name} triggered an SOS`,
    }).catch(() => {});
    onSent();
    const live = await toggleShare(true, true).catch(() => false);
    // The one dialog after an SOS: what happened, plus the single fix that
    // matters — location access when sharing could not start, or always-on
    // location when it only runs while this screen is open — instead of the
    // stack of dialogs toggleShare would otherwise raise.
    const bgMissing = live && !(await canShareInBackground().catch(() => true));
    if (bgMissing) bgAsked.current = true;
    const fix = !live
      ? [{ text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => {}); } }]
      : bgMissing
        ? [{ text: 'Keep sharing when locked', onPress: () => { enableBackgroundSharing(); } }]
        : [];
    Alert.alert('SOS sent', !live
      ? 'Your circle has been alerted. Your live location is NOT being shared — check that location access is on.'
      : bgMissing
        ? 'Your circle has been alerted and your live location is on while crazzychat is open.'
        : 'Your circle has been alerted and your live location is on.', [
      ...fix,
      { text: 'Also alert trusted contacts', onPress: () => router.push('/emergency-sos') },
      { text: 'OK' },
    ]);
  };
  const sosStart = () => {
    Vibration.vibrate(30);
    Animated.timing(sosProg, { toValue: 1, duration: SOS_HOLD_MS, useNativeDriver: true }).start();
    sosTimer.current = setTimeout(fireSos, SOS_HOLD_MS);
  };
  const sosEnd = () => {
    if (sosTimer.current) { clearTimeout(sosTimer.current); sosTimer.current = null; }
    Animated.timing(sosProg, { toValue: 0, duration: 120, useNativeDriver: true }).start();
  };
  return { sosProg, fireSos, sosStart, sosEnd };
}
