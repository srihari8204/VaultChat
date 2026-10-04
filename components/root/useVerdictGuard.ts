// components/root/useVerdictGuard.ts — keeps a held security verdict on screen.
// Moved out of app/_layout.tsx unchanged.

import { useEffect } from 'react';
import type { Router } from 'expo-router';
import { securityVerdict } from '../../lib/securityVerdict';

// A HELD SECURITY VERDICT OWNS THE SCREEN. Taps are already held while
// /blocked is up (lib/pendingLink), but a deep link that expo-router opens
// itself never passes through that gate, so it could stack a chat on top of
// the verdict. Any route other than /blocked goes back to it — except the
// call screens, which stay answerable as they are from the OS lock screen.
export function useVerdictGuard(launchGate: string, pathname: string, router: Router): void {
  useEffect(() => {
    if (launchGate === 'checking' || pathname === '/blocked' || !securityVerdict()) return;
    if (/^\/(incoming-call|voicecall|videocall|group-call-active)(\/|$)/.test(pathname)) return;
    router.replace('/blocked');
  }, [launchGate, pathname, router]);
}
