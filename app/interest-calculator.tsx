// app/interest-calculator.tsx — legacy route.
// The finance calculator grew into the full Vault Finance hub (app/finance).
// This redirect keeps old deep links / tiles pointing at /interest-calculator
// working by forwarding them to the new hub.

import { Redirect } from 'expo-router';
import React from 'react';

export default function InterestCalculatorRedirect() {
  return <Redirect href="/finance" />;
}
