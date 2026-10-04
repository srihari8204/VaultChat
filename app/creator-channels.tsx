// app/creator-channels.tsx
//
// The old "Creator Economy Channels" screen was a demo: SAMPLE_CHANNELS, local
// AsyncStorage, and fake paid-subscription tiers with no payment backend. The
// real broadcast channels (create / discover-by-link / subscribe / posts) live in
// app/broadcast.tsx, backed by /channels. This route now redirects there so there
// is one real channels surface and no fabricated monetization.

import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../lib/theme';

export default function CreatorChannelsRedirect() {
  const router = useRouter();
  const { colors } = useTheme();
  useEffect(() => { router.replace('/broadcast' as any); }, [router]);
  // Themed, not a bare <View />, so the redirect never flashes an unthemed blank screen.
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.primary} accessibilityLabel="Opening channels" />
    </View>
  );
}
