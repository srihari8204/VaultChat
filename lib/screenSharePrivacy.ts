
// lib/screenSharePrivacy.ts
// Screen Share Privacy Ã¢â‚¬â€ hides VaultChat content during screen share
//
// HOW IT WORKS:
// Android uses FLAG_SECURE on the window Ã¢â‚¬â€ this makes the entire
// window appear BLACK in screenshots and screen recordings.
//
// We SELECTIVELY apply this:
//   Screen sharing ON  Ã¢â€ â€™ FLAG_SECURE active on chat screens
//   Screen sharing OFF Ã¢â€ â€™ FLAG_SECURE removed, normal view
//
// The person sharing their screen with you:
//   - Can show you their home screen
//   - Can show you other apps
//   - VaultChat screens appear BLACK / protected
//
// Implementation:
//   - Expo native module (full build)
//   - JS fallback (Expo Go) Ã¢â‚¬â€ shows privacy overlay instead

import { NativeModules, Platform } from 'react-native';
const getSocket = () => null; // stub

class ScreenSharePrivacy {
  private isProtected = false;
  private listeners: ((protected_: boolean) => void)[] = [];

  // Enable FLAG_SECURE Ã¢â‚¬â€ makes screen appear black in recordings
  async enableProtection() {
    if (this.isProtected) return;
    this.isProtected = true;

    if (Platform.OS === 'android') {
      try {
        // Native module Ã¢â‚¬â€ works in full build (npx expo run:android)
        const { ScreenSecure } = NativeModules;
        if (ScreenSecure?.enable) {
          await ScreenSecure.enable();
        } else {
          // Fallback Ã¢â‚¬â€ notify UI to show overlay
        }
      } catch (e) {
      }
    }

    this.listeners.forEach(l => l(true));
  }

  // Disable FLAG_SECURE Ã¢â‚¬â€ restore normal view
  async disableProtection() {
    if (!this.isProtected) return;
    this.isProtected = false;

    if (Platform.OS === 'android') {
      try {
        const { ScreenSecure } = NativeModules;
        if (ScreenSecure?.disable) await ScreenSecure.disable();
      } catch {}
    }

    this.listeners.forEach(l => l(false));
  }

  isActive() { return this.isProtected; }

  // Called when OTHER person starts screen share
  // We enable our protection so THEY can't see our chats
  onRemoteScreenShare(sharing: boolean) {
    if (sharing) {
      this.enableProtection();
    } else {
      this.disableProtection();
    }
  }

  // Called when WE start screen sharing
  // Notify server and enable protection locally too
  async startOwnScreenShare(myVaultId: string, toVaultId: string) {
    await this.enableProtection();
    const socket = getSocket();
    socket.emit('screen_share_start', { from: myVaultId, to: toVaultId });
  }

  async stopOwnScreenShare(myVaultId: string, toVaultId: string) {
    await this.disableProtection();
    const socket = getSocket();
    socket.emit('screen_share_stop', { from: myVaultId, to: toVaultId });
  }

  onProtectionChange(cb: (protected_: boolean) => void) {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }
}

export const screenSharePrivacy = new ScreenSharePrivacy();
