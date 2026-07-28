// app/creator-channels.tsx
//
// The old "Creator Economy Channels" screen was a demo: SAMPLE_CHANNELS, local
// AsyncStorage, and fake paid-subscription tiers with no payment backend. The
// real broadcast channels (create / discover-by-link / subscribe / posts) live in
// app/broadcast.tsx, backed by /channels. This route now redirects there so there
// is one real channels surface and no fabricated monetization.

import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

export default function CreatorChannelsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/broadcast' as any); }, [router]);
  return <View />;
}
