// components/call/inviteResult.ts — say what an "Add to call" tap actually did.
//
// The call screens used to fire engine.inviteToCall and drop the result, so a
// tap on someone who was already in the call, or on a call that had just ended,
// looked exactly like a successful invite. inviteToCall returns how many people
// it rang, or 'rate_limited' when the server refused the ring; this turns that
// (or a throw) into one honest sentence.
//
// Pure and React-Native-free so inviteResult.selftest.ts can run it under Node.
// The invite call is passed in rather than imported, because lib/call/engine
// pulls in react-native-webrtc and cannot load outside the app.

/** What inviteToCall resolves to: how many it rang, or that the server refused the ring. */
export type InviteOutcome = number | 'rate_limited';

/** The sentence shown after inviting `name`. `rung` is inviteToCall's outcome, or 'error'. */
export function inviteResultMessage(name: string, rung: InviteOutcome | 'error'): string {
  const who = name.trim() || 'They';
  if (rung === 'error') return `Could not invite ${who}. Check your connection and try again.`;
  if (rung === 'rate_limited') return `${who} was not called: you are ringing too fast. Wait a moment and try again.`;
  if (rung > 0) return `Calling ${who}. They join this call only if they answer.`;
  // 0: inviteToCall rang nobody — the person is already here, or the call is over.
  return `${who} was not called: they are already on this call, or the call has ended.`;
}

/**
 * Run one invite — `() => engine.inviteToCall([uid])` — and resolve to the
 * sentence describing the outcome. Never throws.
 */
export async function inviteAndDescribe(invite: () => Promise<InviteOutcome>, name: string): Promise<string> {
  let rung: InviteOutcome | 'error';
  try { rung = await invite(); } catch { rung = 'error'; }
  return inviteResultMessage(name, rung);
}
