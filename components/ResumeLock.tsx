// components/ResumeLock.tsx — lock the app again when it returns from the
// background after the "Auto Screen Lock" timeout. Renders nothing.
//
// The launch gate in app/_layout.tsx sends a device-MFA user to /app-lock once
// per cold start; nothing re-checked after that, so an app left in the
// background stayed open indefinitely. This applies the same condition (device
// MFA on, signed in) on resume, after the timeout chosen in Vault Features.
//
// Mounted once inside the root Stack's navigator context (see the P2 handoff).
// app/app-lock reads `resume=1` to return to the screen underneath on unlock
// instead of resetting to Chats.

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { hasSession } from '../lib/api';
import { isMfaEnabled } from '../lib/mfa';
import { checkLockOnResume } from '../services/lockService';

// Screens that are already a lock or are the sign-in flow itself.
const EXEMPT = /^\/(app-lock|onboard[\w-]*|email-verify|mpin-entry|mpin-recover|blocked)?(\/|$)/;

const lockApplies = async () => (await isMfaEnabled()) && (await hasSession().catch(() => false));

export function ResumeLock(): null {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      checkLockOnResume(state, lockApplies)
        .then((lock) => {
          if (lock && !EXEMPT.test(pathRef.current ?? '')) {
            router.push({ pathname: '/app-lock', params: { resume: '1' } } as any);
          }
        })
        .catch(() => { /* a failed check leaves the app as it is; cold launch still locks */ });
    });
    return () => sub.remove();
  }, [router]);

  return null;
}

export default ResumeLock;
