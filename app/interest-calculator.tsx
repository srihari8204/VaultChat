// app/interest-calculator.tsx — legacy route.
// The finance calculator grew into the full Vault Finance hub (app/finance).
// This redirect keeps old deep links / tiles pointing at /interest-calculator
// working by forwarding them to the calculator they named, inside the hub
// (with no history behind it, FinHeader's back goes to the dashboard).

import { Redirect } from 'expo-router';
import React from 'react';

export default function InterestCalculatorRedirect() {
  return <Redirect href="/finance/interest" />;
}
