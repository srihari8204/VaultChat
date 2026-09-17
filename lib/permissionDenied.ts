// What to do when the OS says no.
//
// Android stops showing the system dialog once the user has refused twice:
// request*() then returns denied IMMEDIATELY, without any prompt. A screen that
// answers that with a single-OK "Permission needed" alert is a dead end — the
// next tap runs the same code, gets the same silent refusal, and shows the same
// alert. The only way out is the app's settings page, and 43 of 45 permission
// sites never mentioned it.
//
// `canAskAgain` is the whole decision. While it is true the refusal was a
// one-off and tapping again really will re-prompt, so a plain notice is honest
// and a trip to Settings would be busywork. Once it is false, Settings is the
// ONLY route and the button has to be there.
//
// Pass it through from the permission response — every expo-modules
// PermissionResponse carries it, and PermissionsAndroid's NEVER_ASK_AGAIN is
// the same signal. Omitting it is treated as "cannot ask again", which offers
// the settings route: the safe direction to be wrong in, since the cost is one
// extra button next to "Not now" rather than a screen with no way forward.

import { Alert, Linking } from 'react-native';

export function permissionDenied(title: string, body: string, canAskAgain = false): void {
  if (canAskAgain) {
    Alert.alert(title, body);
    return;
  }
  Alert.alert(title, `${body}\n\nYou can turn it on in Settings.`, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => {}); } },
  ]);
}
