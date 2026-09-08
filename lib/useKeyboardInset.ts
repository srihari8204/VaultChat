// lib/useKeyboardInset.ts — the live keyboard inset, as a hook.
//
// Thin wrapper over keyboardInsetFrom (lib/keyboardInset.ts), which is kept
// react-native-free so it can be unit-tested under Node. Everything about WHY
// the inset is measured from the keyboard's top edge is documented there.

import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { keyboardInsetFrom } from './keyboardInset';

/**
 * How far the keyboard reaches up from the bottom of the screen, in dp. 0 when
 * closed.
 *
 * iOS uses the `Will` events so layout moves with the keyboard animation;
 * Android only fires the `Did` pair reliably.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) =>
      setInset(keyboardInsetFrom(e.endCoordinates, Dimensions.get('screen').height)));
    const hide = Keyboard.addListener(hideEvt, () => setInset(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return inset;
}

export default { useKeyboardInset };
