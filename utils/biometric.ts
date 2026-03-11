import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricType = 'fingerprint' | 'faceid' | 'iris' | 'none';

// Check what biometrics are available on device
export const getBiometricType = async (): Promise<BiometricType> => {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'faceid';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris';
  return 'none';
};

// Authenticate with biometrics — real hardware call
export const authenticateWithBiometrics = async (reason: string): Promise<boolean> => {
  const hasHardware  = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled   = await LocalAuthentication.isEnrolledAsync();

  if (!hasHardware || !isEnrolled) return false;

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage:           reason,
    cancelLabel:             'Cancel',
    disableDeviceFallback:   false,
    fallbackLabel:           'Use PIN',
  });

  return result.success;
};

// Check if device has biometrics enrolled
export const hasBiometrics = async (): Promise<boolean> => {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled  = await LocalAuthentication.isEnrolledAsync();
  return hasHardware && isEnrolled;
};
