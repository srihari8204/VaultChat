
// ================================================================
// lib/stealthMode.ts
// UI-state flag for the calculator-decoy disguise. This module ONLY
// tracks whether stealth is active — it does not encrypt anything.
// Cryptographic separation of real vs decoy data is handled by the
// duress vault (services/security/duressVault.ts). No wipe.
// Works on Android + iOS.
// ================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

class StealthMode {
  private active             = false;
  private onActivateCbs:   (() => void)[] = [];
  private onDeactivateCbs: (() => void)[] = [];

  // Activate stealth — app shows the calculator decoy. This only flips a flag;
  // the real account's protection comes from the duress vault, not from here.
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
