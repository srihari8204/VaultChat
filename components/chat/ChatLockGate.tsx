// components/chat/ChatLockGate.tsx — the per-chat lock veil. Moved out of
// app/chat.tsx unchanged. The screen owns the lock state and its rules (the
// focus check, submitLockPin); this draws the veil and its two factors.
//
// The condition is "not proven OPEN", never "known locked": while the lock is
// still being read, and when reading it failed, the veil is up. The `&&
// lockInfo` that used to be on it is exactly what rendered the chat in full
// when getLock threw.

import { useEffect } from 'react';
import { AccessibilityInfo, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { verifyBiometric, type LockedChat } from '../../lib/chatLock';
import { useS } from './chatStyles';

export type LockState = 'checking' | 'open' | 'locked';

export function ChatLockGate({
  lockState, setLockState, lockInfo, lockBio, setLockBio, lockPin, setLockPin, lockErr, setLockErr, submitLockPin, embedded, onClosePane,
}: {
  lockState: LockState;
  setLockState: (s: LockState) => void;
  lockInfo: LockedChat | null;
  lockBio: boolean;
  setLockBio: (b: boolean) => void;
  lockPin: string;
  setLockPin: (p: string) => void;
  lockErr: string | null;
  setLockErr: (e: string | null) => void;
  submitLockPin: () => void;
  /** A split-view pane (app/split.tsx): navigating from here would replace the whole split. */
  embedded?: boolean;
  /** Split view: close just this pane (app/split.tsx), the pane's own exit. */
  onClosePane?: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  // Speak a new PIN error. Android reads the live region on the Text below;
  // iOS has no live regions, so it is announced explicitly there.
  useEffect(() => {
    if (lockErr && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(lockErr);
  }, [lockErr]);
  if (lockState === 'open') return null;
  return (
    <View style={S.lockGate} accessibilityViewIsModal>
      {lockState === 'locked' && (<>
      <Ionicons name="lock-closed" size={56} color={colors.primary} />
      <Text style={S.lockGateTitle}>Chat locked</Text>
      <Text style={S.lockGateSub}>{lockInfo?.chatName ?? 'This chat could not be unlocked'}</Text>

      {/* 'both' has to SAY it needs both, or a user whose fingerprint just
          passed and who is still looking at a veil concludes the app is
          broken. The biometric button stays tappable either way so a failed
          scan can be retried. */}
      {lockInfo?.lockMethod === 'both' && (
        <Text style={S.lockGateSub}>
          {lockBio
            ? 'Biometrics verified — now enter this chat’s PIN.'
            : 'This chat needs both biometrics and its PIN.'}
        </Text>
      )}

      {(lockInfo?.lockMethod === 'biometric' || lockInfo?.lockMethod === 'both') && (
        <TouchableOpacity
          style={S.lockGateBtn}
          accessibilityRole="button"
          accessibilityLabel={lockBio ? 'Biometrics verified, scan again' : 'Use biometrics'}
          onPress={async () => {
            if (!(await verifyBiometric('Unlock chat'))) return;
            setLockBio(true);
            if (lockInfo?.lockMethod !== 'both') setLockState('open');
          }}
        >
          <Ionicons name={lockBio ? 'checkmark-circle' : 'finger-print'} size={18} color={colors.onPrimary} />
          <Text style={S.lockGateBtnTxt}>{lockBio ? 'Biometrics verified' : 'Use biometrics'}</Text>
        </TouchableOpacity>
      )}

      {(lockInfo?.lockMethod === 'pin' || lockInfo?.lockMethod === 'both') && (
        <View style={{ width: '100%', maxWidth: 280, marginTop: 18 }}>
          <TextInput
            style={S.lockGateInput}
            value={lockPin}
            onChangeText={(t) => { setLockPin(t); setLockErr(null); }}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={8}
            placeholder="Enter PIN"
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="Chat PIN"
            onSubmitEditing={submitLockPin}
          />
          {!!lockErr && <Text style={S.lockGateErr} accessibilityRole="alert" accessibilityLiveRegion="polite">{lockErr}</Text>}
          <TouchableOpacity style={[S.lockGateBtn, { marginTop: 12 }]} onPress={submitLockPin} accessibilityRole="button" accessibilityLabel="Unlock">
            <Text style={S.lockGateBtnTxt}>Unlock</Text>
          </TouchableOpacity>
        </View>
      )}

      {embedded && onClosePane ? (
        // A pane has no screen of its own to leave: router.replace here swapped
        // the whole split view (and the other chat) for the chat list. Closing
        // just this pane leaves the other chat in place.
        <TouchableOpacity style={{ marginTop: 20 }} hitSlop={10} onPress={onClosePane} accessibilityRole="button" accessibilityLabel="Close this chat pane">
          <Text style={S.lockGateBack}>Close this chat</Text>
        </TouchableOpacity>
      ) : embedded ? (
        // No close callback from the host: the split bar's Swap / Close are this
        // pane's exits, as for the hidden header Back.
        <Text style={[S.lockGateSub, { marginTop: 20 }]}>Use Swap or Close in the split bar to leave this chat.</Text>
      ) : (
        <TouchableOpacity style={{ marginTop: 20 }} hitSlop={10} onPress={() => router.replace('/(tabs)/chats')} accessibilityRole="button" accessibilityLabel="Back to chats">
          <Text style={S.lockGateBack}>Back to chats</Text>
        </TouchableOpacity>
      )}
      </>)}
    </View>
  );
}
