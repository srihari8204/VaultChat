// lib/call/native/index.ts — pick the platform adapter, once.
//
// This is the ONLY Platform.OS branch in lib/call/. Everything downstream
// programs against NativeCallAdapter.

import { Platform } from 'react-native';
import type { NativeCallAdapter } from './types';

/**
 * Web and any platform without a native call surface. Distinct from the iOS
 * adapter on purpose: iOS is "not implemented yet" and will change, while this
 * is "there is nothing to implement here" — see the platform scope in
 * docs/IOS_PARITY.md. Both are safe no-ops; only the reporting differs.
 */
const noopAdapter: NativeCallAdapter = {
  platform: 'none',
  canRingWhenKilled: false,
  async register() {},
  startCallSession() {},
  endCallSession() {},
  dismissIncomingUi() {},
  async ringPeer() { return false; },
  async cancelRing() {},
  async consumeLaunchIntent() { return null; },
  async consumeDeclinedCall() { return null; },
};

function pick(): NativeCallAdapter {
  // Required, not lazy-loaded, so the Android bundle never pulls the iOS file
  // and vice versa — Metro resolves both branches, but only one is reachable
  // and dead-code elimination keeps the other out of the shipped graph.
  if (Platform.OS === 'android') return require('./android').androidAdapter;
  if (Platform.OS === 'ios') return require('./ios').iosAdapter;
  return noopAdapter;
}

export const nativeCall: NativeCallAdapter = pick();

/**
 * Whether this build can ring while the app is killed. Screens should use this
 * instead of checking Platform.OS, so a claim about reliability is never made
 * on a platform that cannot honour it.
 */
export const canRingWhenKilled = (): boolean => nativeCall.canRingWhenKilled;

export type { NativeCallAdapter, IncomingCallIntent } from './types';
export default nativeCall;
