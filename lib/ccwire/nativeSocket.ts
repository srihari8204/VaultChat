// Optional Android Rust carrier. CCWireClient owns the protocol and reconnects.
import { Buffer } from 'buffer';
import { MAX_FRAME_BYTES, HEADER_BYTES } from './frame';

interface NativeTransport {
  supportsWebTransport?(): boolean;
  create(): number;
  connect(id: number, url: string, token: string): void;
  send(id: number, bytes: string): boolean;
  acknowledge(id: number): void;
  close(id: number): void;
}
interface NativeEvent { id: number; kind: number; code?: number; data?: string }
interface Emitter { addListener(name: string, listener: (event: NativeEvent) => void): { remove(): void } }
const MAX_BYTES = MAX_FRAME_BYTES + HEADER_BYTES;

export function createNativeWebSocketImpl(native: NativeTransport, emitter: Emitter, webTransportUrl?: string) {
  return class RustWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly protocol = webTransportUrl ? 'webtransport' : '';
    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    private readonly id: number;
    private subscription: { remove(): void };

    constructor(readonly url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) {
      if (!url.startsWith('wss://')) throw new Error('Rust transport requires verified WSS');
      if (webTransportUrl) {
        const endpoint = new URL(webTransportUrl), original = new URL(url);
        if (endpoint.protocol !== 'https:' || endpoint.hostname !== original.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('WebTransport endpoint must use the API hostname with verified HTTPS');
      }
      if (protocols?.length) throw new Error('Rust carrier does not negotiate subprotocols');
      const auth = options?.headers?.Authorization ?? options?.headers?.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.length <= 7 || auth.length > 16391 || /[\r\n]/.test(auth)) throw new Error('Rust transport requires Bearer authentication');
      this.id = native.create();
      if (!this.id) throw new Error('Rust transport connection capacity reached');
      this.subscription = emitter.addListener('transportSocket', (event) => {
        if (event.id !== this.id || this.readyState === 3) return;
        if (event.kind === 0 && this.readyState === 0) {
          this.readyState = 1;
          this.onopen?.({ type: 'open' });
        } else if (event.kind === 1) {
          try {
            if (this.readyState !== 1 || typeof event.data !== 'string' || event.data.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Invalid native binary event');
            const bytes = Buffer.from(event.data, 'base64');
            if (bytes.length > MAX_BYTES) throw new Error('Native frame too large');
            this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
          } catch {
            this.onerror?.({ message: 'Rust transport receive failed' });
            this.finish(1006);
          } finally { native.acknowledge(this.id); }
        } else if (event.kind === 2) {
          if (event.code !== 1000) this.onerror?.({ message: 'Rust transport disconnected' });
          this.finish(event.code ?? 1006);
        }
      });
      try { native.connect(this.id, webTransportUrl ?? url, auth.slice(7)); } catch {
        this.subscription.remove();
        native.close(this.id);
        throw new Error('Rust transport connect failed');
      }
    }

    send(data: ArrayBuffer | Uint8Array): void {
      if (this.readyState !== 1) throw new Error('Rust transport is not open');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Rust transport frame size refused');
      if (!native.send(this.id, Buffer.from(bytes).toString('base64'))) throw new Error('Rust transport send queue full');
    }

    close(code = 1000, _reason?: string): void {
      if (this.readyState === 3) return;
      this.readyState = 2;
      native.close(this.id);
      // Match WebSocket's asynchronous close event even for a cancelled dial.
      Promise.resolve().then(() => this.finish(code));
    }

    private finish(code: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.subscription.remove();
      native.close(this.id);
      this.onclose?.({ code, reason: '', wasClean: code === 1000 });
    }
  };
}

export function getNativeWebSocketImpl(webTransportUrl?: string): ReturnType<typeof createNativeWebSocketImpl> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules, NativeEventEmitter, Platform } = require('react-native');
    const native = NativeModules.TransportCore;
    if (Platform.OS !== 'android' || !native || !['create', 'connect', 'send', 'acknowledge', 'close'].every((key) => typeof native[key] === 'function')) return undefined;
    if (webTransportUrl && (typeof native.supportsWebTransport !== 'function' || !native.supportsWebTransport())) return undefined;
    return createNativeWebSocketImpl(native, new NativeEventEmitter(native), webTransportUrl);
  } catch { return undefined; }
}
