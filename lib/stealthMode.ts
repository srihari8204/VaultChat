
// ================================================================
// lib/stealthMode.ts
// Hides VaultChat behind a Calculator decoy.
// Data stays safe — encrypted on device.
// No wipe. Just hidden until secret gesture.
// Works on Android + iOS.
// ================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

class StealthMode {
  private active             = false;
  private onActivateCbs:   (() => void)[] = [];
  private onDeactivateCbs: (() => void)[] = [];

  // Activate stealth — app hides, calculator shown
  // Data is NOT wiped — stays AES-256 encrypted on device
  async activate(reason: string) {
    if (this.active) return;
    this.active = true;
    await AsyncStorage.setItem('stealthActive', 'true');
    this.onActivateCbs.forEach(cb => { try { cb(); } catch {} });
  }

  // Deactivate — only via secret gesture + real PIN
  async deactivate() {
    this.active = false;
    await AsyncStorage.removeItem('stealthActive');
    this.onDeactivateCbs.forEach(cb => { try { cb(); } catch {} });
  }

  // Check if stealth was active before app restart
  async restoreState() {
    const s = await AsyncStorage.getItem('stealthActive');
    this.active = s === 'true';
    return this.active;
  }

  onActivated(cb: () => void)   { this.onActivateCbs.push(cb); }
  onDeactivated(cb: () => void) { this.onDeactivateCbs.push(cb); }
  isActive()                    { return this.active; }
}

export const stealthMode = new StealthMode();
