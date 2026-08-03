// lib/call/native/types.ts — the one platform seam in the call stack.
//
// Everything else in lib/call/ is platform-neutral TypeScript. This is where
// the two operating systems genuinely differ, and the difference is not
// cosmetic — it is a different model of what an app is allowed to do:
//
//   Android  A foreground service keeps mic and camera alive, and a
//            FirebaseMessagingService can start the process from a COLD START
//            with no JS runtime and post a full-screen-intent notification.
//            VaultChat implements both (plugins/android/*.kt).
//
//   iOS      Neither is permitted. The only sanctioned path is a PushKit VoIP
//            push that MUST be reported to CallKit via
//            CXProvider.reportNewIncomingCall() immediately on arrival — iOS
//            revokes the app's VoIP privileges if it is not. Audio continues
//            because CallKit owns the AVAudioSession, not because the app asked.
//
// Modelling that as one interface with two implementations means the engine
// never branches on Platform.OS, and landing iOS is adding a file rather than
// editing the call pipeline.

export interface IncomingCallIntent {
  action: string;
  callId?: string;
  callerId?: string;
  callerName?: string;
  isVideo?: boolean;
  chatId?: string;
}

export interface NativeCallAdapter {
  /** Which implementation is live — for diagnostics and honest UI copy. */
  readonly platform: 'android' | 'ios' | 'none';

  /**
   * True when this platform can actually ring a killed app. When false the UI
   * must not promise it; on iOS that is the case until CallKit ships.
   */
  readonly canRingWhenKilled: boolean;

  /** Register this device for call wake-ups (push token → backend). */
  register(): Promise<void>;

  /** Keep audio alive for a connected call. */
  startCallSession(p: { callId: string; peerName: string; peerPhotoUrl?: string; isVideo: boolean }): void;

  /** Release the audio session / foreground service. */
  endCallSession(): void;

  /** Dismiss the OS incoming-call UI once the app has taken over the ring. */
  dismissIncomingUi(): void;

  /** Ring the callee out-of-band (doorbell only — never carries SDP). */
  ringPeer(p: { calleeId: string; callId: string; isVideo: boolean }): Promise<boolean>;

  /** Stop a ring we started; converts the callee's ring into a missed call. */
  cancelRing(calleeId: string, callId: string): Promise<void>;

  /** A call the app was launched by, consumed once. */
  consumeLaunchIntent(): Promise<IncomingCallIntent | null>;

  /** A decline chosen from a notification while the app was killed. */
  consumeDeclinedCall(): Promise<string | null>;
}

export default {};
