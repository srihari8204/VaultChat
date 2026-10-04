// app/creator-channels.tsx — redirect shim for old deep links only.
//
// The old "Creator Economy Channels" screen was a demo: SAMPLE_CHANNELS, local
// AsyncStorage, and fake paid-subscription tiers with no payment backend. The
// real broadcast channels (create / discover-by-link / subscribe / posts) live in
// app/broadcast.tsx, backed by /channels. Nothing in the app links here
// (lib/orphanRoutes.selftest.ts pins that); it exists so an old link still lands
// somewhere real.
//
// <Redirect> replaces the route as it mounts and renders nothing, so there is
// no intermediate screen to flash or for a screen reader to announce — the
// same stub app/filevault.tsx uses.

import { Redirect } from 'expo-router';

export default function CreatorChannelsRedirect() {
  return <Redirect href={'/broadcast' as any} />;
}
