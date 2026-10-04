// components/root/useForegroundUpkeep.ts — work the root re-runs every time the
// app comes to the foreground. Moved out of app/_layout.tsx unchanged.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { refreshCallRegistration } from '../../lib/CallService';
import { SCHEDULED_LOCAL } from '../../constants/flags';

// Scheduled messages (#73): fire due items on start + every foreground, and
// re-arm OS triggers (some OEMs clear alarms on force-stop). Sends fail-soft
// if not signed in yet and retry on the next sweep.
export function useScheduledMessages(): void {
  useEffect(() => {
    if (!SCHEDULED_LOCAL) return;
    import('../../lib/scheduledRunner')
      .then(m => { m.runDueScheduled(); m.rearmAllTriggers(); })
      .catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') import('../../lib/scheduledRunner').then(m => m.runDueScheduled()).catch(() => {});
    });
    return () => sub.remove();
  }, []);
}

// KEEP THE CALL DOORBELL ALIVE.
//
// registerForCalls() runs once at boot, and that is not enough: FCM rotates
// tokens (reinstall, data clear, restore, expiry), a phone can boot before its
// network is up, and a user can sign in after launch. In all three the server
// ends up holding a token that no longer reaches this device, so it stops
// ringing while killed — silently, and until the next cold start.
//
// refreshCallRegistration is cheap: it reads the current token locally and
// returns without any network request unless the token actually changed or the
// last attempt did not succeed, which is the case on essentially every
// foreground. Registered here rather than inside the boot effect so it keeps
// running for the whole life of the process.
export function useCallRegistrationRefresh(): void {
  useEffect(() => {
    void refreshCallRegistration().catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshCallRegistration().catch(() => {});
    });
    return () => sub.remove();
  }, []);
}
