import { useMemo } from 'react';
import { AUTH, AUTH_LIGHT, type AuthPalette } from '../constants/authTheme';
import { useTheme } from './theme';

export function useAuthTheme(): AuthPalette {
  const { colors, scheme } = useTheme();
  // Theme colors also change identity when live window/inset metrics change.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- colors identity invalidates styles after live layout changes.
  return useMemo(() => ({ ...(scheme === 'light' ? AUTH_LIGHT : AUTH) }), [colors, scheme]);
}
