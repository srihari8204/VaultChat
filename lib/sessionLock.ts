// In-memory app-unlock flag for the MPIN gate.
//
// Resets to false on every cold start (full JS reload), so a signed-in user
// with an MPIN is asked to unlock each launch. Stays true while the app is
// warm, so navigating around doesn't re-prompt. enter-mpin / set-mpin call
// markUnlocked() on success; logout calls lockSession().
let unlocked = false;

export function markUnlocked(): void { unlocked = true; }
export function lockSession(): void { unlocked = false; }
export function isUnlocked(): boolean { return unlocked; }

export default { markUnlocked, lockSession, isUnlocked };
