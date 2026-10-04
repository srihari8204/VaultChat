// lib/family/keepAlive.ts — what the Family hub asks for when sharing is
// switched ON, moved out of app/family.tsx's toggleShare unchanged.
//
// TURNING SHARING ON IS THE MOMENT TO ASK FOR THE THINGS THAT KEEP IT ON.
// A location foreground service is not enough by itself on most Android
// phones sold here: EMUI/MIUI/ColorOS kill background work aggressively, so
// a locked phone stops publishing and the family sees someone "vanish"
// while the app believes it is sharing. Asked ONCE per circle, never
// nagged — the flag records that we have asked, not that they said yes.

import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  requestIgnoreBatteryOptimizations, needsAutoStartGuidance, openAutoStartSettings, getManufacturer,
  isIgnoringBatteryOptimizations,
} from '../batteryOptimization';
import { canShareInBackground } from './presence';
import { requestBackgroundPermission } from './background';

/** Best-effort: never throws — sharing itself has already succeeded. */
export async function askKeepSharingWhenLocked(): Promise<void> {
  try {
    const askedKey = 'vc_family_bg_asked';
    const asked = await AsyncStorage.getItem(askedKey);
    // Re-ask when the exemption is genuinely MISSING, even if we asked
    // before — "asked once" was the right rule while we could not read the
    // answer, but it also meant a user who declined (or an OEM that revoked
    // it later) was never told again, and their locked-screen sharing just
    // quietly stopped working. Now the state decides, not the memory of a
    // dialog.
    const exempt = await isIgnoringBatteryOptimizations();
    if (!asked || !exempt) {
      await AsyncStorage.setItem(askedKey, '1');
      const bg = await canShareInBackground();
      if (!bg) await requestBackgroundPermission();
      if (!exempt) await requestIgnoreBatteryOptimizations();
      if (await needsAutoStartGuidance()) {
        Alert.alert(
          'Keep sharing when locked',
          `${(await getManufacturer()).toUpperCase()} phones stop background apps to save power, which stops your location too.\n\n`
          + 'Turn ON auto-start for crazzychat so your family keeps seeing you while the screen is locked.',
          [{ text: 'Later', style: 'cancel' }, { text: 'Open settings', onPress: () => { openAutoStartSettings().catch(() => {}); } }],
        );
      }
    }
  } catch { /* guidance is best-effort; sharing itself already succeeded */ }
}
