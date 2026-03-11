const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let lastActivityTs = Date.now();
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
let onSessionExpire: (() => void) | null = null;

export function resetActivity() { lastActivityTs = Date.now(); }

export function startSessionTimer(onExpire: () => void) {
  onSessionExpire = onExpire;
  const tick = () => {
    const idle = Date.now() - lastActivityTs;
    if (idle >= SESSION_TIMEOUT_MS) {
      onSessionExpire?.();
    } else {
      sessionTimer = setTimeout(tick, SESSION_TIMEOUT_MS - idle);
    }
  };
  sessionTimer = setTimeout(tick, SESSION_TIMEOUT_MS);
}

export function stopSessionTimer() {
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
}

export function getIdleSeconds(): number {
  return Math.floor((Date.now() - lastActivityTs) / 1000);
}
