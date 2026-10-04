// components/chat/ChatLockGate.tsx — the per-chat lock veil. Moved out of
// app/chat.tsx unchanged. The screen owns the lock state and its rules (the
// focus check, submitLockPin); this draws the veil and its two factors.
//
// The condition is "not proven OPEN", never "known locked": while the lock is
// still being read, and when reading it failed, the veil is up. The `&&
// lockInfo` that used to be on it is exactly what rendered the chat in full
// when getLock threw.

import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { verifyBiometric, type LockedChat } from '../../lib/chatLock';
import { useS } from './chatStyles';

export type LockState = 'checking' | 'open' | 'locked';

export function ChatLockGate({
  lockState, setLockState, lockInfo, lockBio, setLockBio, lockPin, setLockPin, lockErr, setLockErr, submitLockPin,
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
}) {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
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
          <Ionicons name={lockBio ? 'checkmark-circle' : 'finger-print'} size={18} color="#fff" />
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
          {!!lockErr && <Text style={S.lockGateErr}>{lockErr}</Text>}
          <TouchableOpacity style={[S.lockGateBtn, { marginTop: 12 }]} onPress={submitLockPin} accessibilityRole="button" accessibilityLabel="Unlock">
            <Text style={S.lockGateBtnTxt}>Unlock</Text>
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity style={{ marginTop: 20 }} onPress={() => router.replace('/(tabs)/chats' as any)} accessibilityRole="button" accessibilityLabel="Back to chats">
        <Text style={S.lockGateBack}>Back to chats</Text>
      </TouchableOpacity>
      </>)}
    </View>
  );
}
