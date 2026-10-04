// components/ResumeLock.tsx — lock the app again when it returns from the
// background after the "Auto Screen Lock" timeout. Renders nothing.
//
// The launch gate in app/_layout.tsx sends a device-MFA or sealed-session user
// to /app-lock once per cold start; nothing re-checked after that, so an app
// left in the background stayed open indefinitely. This relocks on resume,
// after the timeout chosen in Vault Features, for a signed-in user with device
// MFA OR a Device PIN (lib/resumeLockPolicy.lockAppliesTo). A PIN holder's
// session is sealed under that PIN, so this covers sealed-session users too;
// app-lock then asks for the PIN.
//
// Mounted once inside the root Stack's navigator context (see the P2 handoff).
// app/app-lock reads `resume=1` to return to the screen underneath on unlock
// instead of resetting to Chats.
//
// THE LOCK WINS OVER NOTIFICATION TAPS. A tap that brings the app forward is
// routed on the same 'active' event; each resume's decision is published to
// lib/pendingLink first, so app/_layout's taps wait for it and are held for
// replay after unlock instead of landing on top of /app-lock.

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { hasSession } from '../lib/api';
import { isMfaEnabled } from '../lib/mfa';
import { isLockOrAuthRoute, setResumeLockCheck } from '../lib/pendingLink';
import { lockAppliesTo } from '../lib/resumeLockPolicy';
import { checkLockOnResume } from '../services/lockService';
import { hasPin } from '../services/security/pinStore';

// Screens that are already a lock or are the sign-in flow itself, and the
// launch splash ("/"), which hands off to the launch gate.
const exempt = (path: string | null | undefined) => path === '/' || isLockOrAuthRoute(path);

const lockApplies = async () => {
  const [mfaOn, signedIn, hasDevicePin] = await Promise.all([
    isMfaEnabled(), hasSession().catch(() => false), hasPin().catch(() => false),
  ]);
  return lockAppliesTo({ signedIn, mfaOn, hasDevicePin });
};

export function ResumeLock(): null {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Once the lock (or any auth route) is on screen, the route itself holds
  // taps back; a stale "locking" decision would hold them after unlock too.
  useEffect(() => {
    if (isLockOrAuthRoute(pathname)) setResumeLockCheck(Promise.resolve(false));
  }, [pathname]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const lock = checkLockOnResume(state, lockApplies)
        .then((l) => l && !exempt(pathRef.current))
        // A failed check leaves the app as it is; cold launch still locks.
        .catch(() => false);
      if (state === 'active') setResumeLockCheck(lock);
      lock.then((l) => {
        if (l) router.push({ pathname: '/app-lock', params: { resume: '1' } } as any);
      }).catch(() => {});
    });
    return () => sub.remove();
  }, [router]);

  return null;
}

export default ResumeLock;
