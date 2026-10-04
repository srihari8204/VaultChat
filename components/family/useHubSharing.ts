// components/family/useHubSharing.ts — MY sharing switch on the Family hub,
// moved out of app/family.tsx unchanged: the switch state, what turning it on
// asks for (location, keep-alive, always-on), and my own high-speed alert.

import { useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { setSettings } from '../../lib/family/store';
import { setSharing, canShareInBackground } from '../../lib/family/presence';
import { requestBackgroundPermission } from '../../lib/family/background';
import { askKeepSharingWhenLocked } from '../../lib/family/keepAlive';
import { SPEED_ALERT_CHOICES, DEFAULT_SPEED_ALERT_KMH } from '../../lib/family/types';

export function useHubSharing({ spaceName, inSpace }: {
  /** The active space's name, for the "location is turned off" copy. */
  spaceName: string | undefined;
  /** A space and an identity are loaded, so sharing can be restarted. */
  inSpace: boolean;
}) {
  const [share, setShare] = useState(false);
  // Location was refused (or never asked for). Not an error state — the space
  // works without it; only our own dot on the map is missing.
  const [locDenied, setLocDenied] = useState(false);
  // My own high-speed alert (off by default; detected on this device only).
  const [speedAlert, setSpeedAlert] = useState<{ enabled: boolean; thresholdKmh: number }>(
    { enabled: false, thresholdKmh: DEFAULT_SPEED_ALERT_KMH });
  const bgAsked = useRef(false);       // only nag once per mount about always-on location

  /** Ask for always-on location; on a yes, restart sharing so the running
   *  watcher picks the background permission up. */
  const enableBackgroundSharing = async () => {
    if (await requestBackgroundPermission()) { try { await setSharing(false); await setSharing(true); } catch {} }
  };

  /**
   * Sharing only used to survive while this screen was in front. Ask once for
   * always-on so it keeps working in a pocket; declining is a valid answer and
   * simply leaves the foreground-only behaviour in place.
   */
  const offerBackground = async () => {
    if (bgAsked.current) return;
    bgAsked.current = true;
    try {
      if (await canShareInBackground()) return;
      Alert.alert(
        'Keep sharing in the background?',
        'Without always-on location, your family only sees you while this screen is open. You can change this any time in system settings.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Allow', onPress: () => { if (inSpace) enableBackgroundSharing(); else requestBackgroundPermission(); } },
        ],
      );
    } catch {}
  };

  /**
   * Resolves to whether sharing is ON afterwards. `quiet` (the SOS path) skips
   * every dialog and settings hand-off this would otherwise raise, so the SOS
   * shows ONE outcome dialog instead of a stack of them (fireSos offers the
   * one fix that matters inside that dialog).
   */
  const toggleShare = async (v: boolean, quiet = false): Promise<boolean> => {
    // setSharing asks for location permission when turning ON — that is the
    // moment it is genuinely needed. If it is refused, leave the switch OFF
    // rather than showing it on while nothing is being published.
    let ok = v;
    try { ok = await setSharing(v); } catch { ok = false; }
    setShare(ok);
    setLocDenied(v && !ok);
    await setSettings({ sharing: ok });
    // Turning sharing on is the moment to ask for what keeps it on when locked.
    if (ok && v && !quiet) await askKeepSharingWhenLocked();
    if (v && !ok && !quiet) {
      Alert.alert(
        'Location is turned off',
        `crazzychat needs location permission to share your position with ${spaceName ?? 'this space'}. `
        + 'You can still use everything else here without it.',
        [{ text: 'Not now' }, { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => {}); } }],
      );
      return false;
    }
    if (ok && !quiet) await offerBackground();
    return ok;
  };

  const toggleSpeedAlert = async (on: boolean) => {
    const next = { enabled: on, thresholdKmh: speedAlert.thresholdKmh };
    setSpeedAlert(next);
    await setSettings({ speedAlert: next }).catch(() => {});
  };
  const cycleSpeedThreshold = async () => {
    const i = SPEED_ALERT_CHOICES.indexOf(speedAlert.thresholdKmh as typeof SPEED_ALERT_CHOICES[number]);
    const next = { enabled: true, thresholdKmh: SPEED_ALERT_CHOICES[(i + 1) % SPEED_ALERT_CHOICES.length] };
    setSpeedAlert(next);
    await setSettings({ speedAlert: next }).catch(() => {});
  };

  return {
    share, setShare, locDenied, setLocDenied, speedAlert, setSpeedAlert, bgAsked,
    toggleShare, toggleSpeedAlert, cycleSpeedThreshold, enableBackgroundSharing,
  };
}
