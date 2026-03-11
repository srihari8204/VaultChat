import * as LocalAuthentication from 'expo-local-authentication';

export const authenticateFace = async () => {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();

  if (!hasHardware || !isEnrolled) {
    throw new Error('NO_BIOMETRIC');
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock VaultChat',
    fallbackLabel: 'Use Password',
    disableDeviceFallback: false,
  });

  if (!result.success) {
    throw new Error('AUTH_FAILED');
  }

  return true;
};