// app/interest-calculator.tsx — redirect shim for old deep links only.
//
// The finance calculator grew into the Vault Finance hub (app/finance). Old
// links and tiles that open /interest-calculator land on the calculator they
// named, app/finance/interest.tsx. Nothing in the app links here
// (lib/finance/legacyRoute.selftest.ts pins that); whether to delete the route
// once old links no longer matter is an open decision (fix_status §5).
//
// <Redirect> replaces the route as it mounts and renders nothing, so there is
// no intermediate screen to flash or for a screen reader to announce — the
// same stub as app/creator-channels.tsx. With no history behind it,
// FinHeader's back goes to the finance dashboard.

import { Redirect } from 'expo-router';

export default function InterestCalculatorRedirect() {
  return <Redirect href="/finance/interest" />;
}
