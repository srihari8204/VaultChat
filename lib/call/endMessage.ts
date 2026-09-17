// lib/call/endMessage.ts — what to tell the user when a call ends badly.
//
// EndReason has been computed and stored since the state machine was written,
// and its own doc comment says it "drives the log entry and any user-facing
// message". The log entry existed. The message never did: nothing outside
// machine.ts ever read endReason, so a call that failed ICE, failed setup, or
// rang out simply closed. From the user's side a dropped call and a hang-up
// looked identical, which is the difference between "try again" and "they hung
// up on me".
//
// SILENT FOR EXPECTED ENDINGS. A call you ended, or one the other person
// ended, needs no announcement — telling someone "the call ended" when they
// just pressed End is noise, and noise trains people to dismiss the dialog
// that actually matters. Only the endings the user did not ask for speak up.
//
// Pure and dependency-free so the mapping is testable; `import type` is erased
// at runtime, so this module pulls in no React Native.

import type { EndReason } from './types';

export function endMessage(reason: EndReason | null, error: string | null): string | null {
  switch (reason) {
    case 'no_answer':
      return 'No answer.';
    case 'failed':
      return 'The call dropped. The connection was lost.';
    case 'setup_error':
      // The engine's own text when it has one — it knows whether the microphone
      // was refused, signalling failed, or the key exchange did.
      return error && error.trim() ? error.trim() : 'The call could not be started.';
    case 'replaced':
      // Superseded by another call, which is already on screen. Saying anything
      // here would describe the call the user just left, over the one they are
      // now in.
      return null;
    case 'local_hangup':
    case 'remote_hangup':
    case null:
    default:
      return null;
  }
}
