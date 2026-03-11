// ================================================================
// lib/errorHandler.ts — Global crash prevention
// ================================================================
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';

type ErrorLog = { ts: number; screen: string; error: string; stack?: string };

class ErrorHandler {
  private logs: ErrorLog[] = [];

  async log(screen: string, error: unknown) {
    const entry: ErrorLog = {
      ts: Date.now(), screen,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    try {
      await AsyncStorage.setItem('errorLogs', JSON.stringify(this.logs.slice(0, 50)));
    } catch {}
    console.error(`[VaultChat][${screen}]`, entry.error);
  }

  async getLogs(): Promise<ErrorLog[]> {
    try {
      const raw = await AsyncStorage.getItem('errorLogs');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  async clearLogs() {
    this.logs = [];
    await AsyncStorage.removeItem('errorLogs');
  }
}

export const errorHandler = new ErrorHandler();

// ── Network monitor ──────────────────────────────────────────────
export type NetworkState = 'online' | 'offline' | 'weak';
let networkState: NetworkState = 'online';
let networkListeners: ((s: NetworkState) => void)[] = [];

export function subscribeNetwork(cb: (s: NetworkState) => void) {
  networkListeners.push(cb);
  cb(networkState);
  return () => { networkListeners = networkListeners.filter(l => l !== cb); };
}

NetInfo.addEventListener(state => {
  const prev = networkState;
  if (!state.isConnected)            networkState = 'offline';
  else if (!state.isInternetReachable) networkState = 'weak';
  else                               networkState = 'online';
  if (networkState !== prev) networkListeners.forEach(l => l(networkState));
});

// ── Retry wrapper ────────────────────────────────────────────────
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000,
  screen = 'unknown'
): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) {
        await errorHandler.log(screen, e);
        throw e;
      }
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error('Max retries exceeded');
}

// ── Safe AsyncStorage ────────────────────────────────────────────
export const storage = {
  async get(key: string): Promise<string | null> {
    try { return await AsyncStorage.getItem(key); }
    catch { return null; }
  },
  async set(key: string, value: string): Promise<boolean> {
    try { await AsyncStorage.setItem(key, value); return true; }
    catch { return false; }
  },
  async remove(key: string): Promise<boolean> {
    try { await AsyncStorage.removeItem(key); return true; }
    catch { return false; }
  },
};

