// App-facing event facade; the transport singleton also owns typed submissions.
import { startCCWire, stopCCWire, ccwireClient, ccwireStatus, type StartCCWireOptions } from './transport';
import { APP_EVENT_JSON_MAX } from './codec';

type Handler = (...args: any[]) => void;
const MAX_EVENT_BYTES = APP_EVENT_JSON_MAX;
const LIFECYCLE = new Set(['connect', 'disconnect', 'connect_error', 'ready']);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const SUBSCRIPTION_KINDS: Record<string, string> = {
  join_chat: 'chat', leave_chat: 'chat', join_call: 'call', leave_call: 'call',
  channel_join: 'channel', channel_leave: 'channel', run_subscribe: 'run', run_unsubscribe: 'run',
};

export class CCWireEventSocket {
  readonly ccwire = true;
  connected = false;
  private listeners = new Map<string, Set<Handler>>();
  private started = false;
  private generation = 0;
  private renewed = false;
  private waiting: Promise<this> | null = null;
  private cancelWaiting: (() => void) | null = null;
  private subscriptions = new Map<string, { event: string; payload: any; bytes: number }>();
  private subscriptionBytes = 0;
  constructor(private options: StartCCWireOptions, private refreshToken: () => Promise<string>) {}

  on(event: string, handler: Handler): this {
    let handlers = this.listeners.get(event);
    if (!handlers) this.listeners.set(event, handlers = new Set());
    handlers.add(handler);
    return this;
  }
  off(event: string, handler?: Handler): this {
    if (handler) {
      const handlers = this.listeners.get(event);
      handlers?.delete(handler);
      if (!handlers?.size) this.listeners.delete(event);
    } else this.listeners.delete(event);
    return this;
  }
  once(event: string, handler: Handler): this {
    const once = (...args: any[]) => { this.off(event, once); handler(...args); };
    return this.on(event, once);
  }
  removeAllListeners(): this {
    this.listeners.clear();
    this.subscriptions.clear(); this.subscriptionBytes = 0;
    return this;
  }
  private dispatch(event: string, payload?: any): void {
    for (const h of [...(this.listeners.get(event) ?? [])]) {
      try { h(payload); } catch { /* isolate consumers */ }
    }
  }
  emit(event: string, payload?: any): this {
    // No offline event queue: durable messages/receipts already have SQLite
    // owners; stale typing, ICE and location must not replay after reconnect.
    if (!event || event.length > 64 || LIFECYCLE.has(event)) return this;
    try {
      const bytes = UTF8_ENCODER.encode(JSON.stringify(payload ?? {}));
      if (bytes.length > MAX_EVENT_BYTES) return this;
      const kind = SUBSCRIPTION_KINDS[event];
      if (kind) {
        const id = kind === 'channel' ? payload?.channelId : kind === 'run' ? payload?.runId : payload?.chatId;
        if (typeof id !== 'string' || !id) return this;
        const key = `${kind}:${id}`;
        const previous = this.subscriptions.get(key);
        const leaving = event.includes('leave') || event === 'run_unsubscribe';
        if (leaving) {
          if (previous) this.subscriptionBytes -= previous.bytes;
          this.subscriptions.delete(key);
        } else {
          const total = this.subscriptionBytes - (previous?.bytes ?? 0) + bytes.length;
          if ((!previous && this.subscriptions.size >= 256) || total > 262144) return this;
          this.subscriptions.set(key, { event, payload: JSON.parse(UTF8_DECODER.decode(bytes)), bytes: bytes.length });
          this.subscriptionBytes = total;
        }
      }
      if (!this.connected) return this;
      const c = ccwireClient();
      c?.send({ request_id: c.nextRequestId(), traffic_class: 1, stream: 1,
        body_field: 100, value: { event, payload_json: bytes } });
    } catch { /* invalid payload is not queued */ }
    return this;
  }
  connect(): this {
    if (this.started) return this;
    if (ccwireStatus() === 'error') stopCCWire('logout');
    this.started = true;
    const generation = ++this.generation;
    startCCWire({ ...this.options, requireAppEvents: true,
      onAppEvent: (event, payload) => {
        if (generation === this.generation && !LIFECYCLE.has(event)) this.dispatch(event, payload);
      },
      onStatus: (status, detail) => {
        if (generation !== this.generation) return;
        try { this.options.onStatus?.(status, detail); } catch { /* telemetry cannot block readiness */ }
        if (status === 'ready') {
          this.renewed = false;
          const wasConnected = this.connected;
          this.connected = true;
          if (!wasConnected) {
            for (const subscription of [...this.subscriptions.values()]) this.emit(subscription.event, subscription.payload);
            this.dispatch('connect'); this.dispatch('ready');
          }
        } else {
          const wasConnected = this.connected;
          this.connected = false;
          if (wasConnected) this.dispatch('disconnect', detail ?? status);
          if (status === 'error') {
            this.started = false;
            if (detail?.includes('auth') && !this.renewed) {
              this.renewed = true;
              void this.refreshToken().then((result) => {
                if (generation !== this.generation) return;
                if (result === 'ok') { stopCCWire('logout'); this.connect(); }
                else this.dispatch('connect_error', new Error('Authentication failed'));
              }).catch(() => this.dispatch('connect_error', new Error('Authentication failed')));
            } else this.dispatch('connect_error', new Error(detail ?? 'CC-Wire unavailable'));
          }
        }
      },
    });
    return this;
  }
  disconnect(): this {
    this.cancelWaiting?.();
    ++this.generation;
    const wasConnected = this.connected;
    this.connected = false;
    this.started = false;
    stopCCWire('logout');
    if (wasConnected) this.dispatch('disconnect', 'client disconnect');
    return this;
  }
  waitUntilReady(): Promise<this> {
    if (this.connected) return Promise.resolve(this);
    if (this.waiting) return this.waiting;
    this.waiting = new Promise<this>((resolve, reject) => {
      const cleanup = () => { this.cancelWaiting = null; clearTimeout(timer); this.off('ready', ready); this.off('connect_error', failed); };
      const ready = () => { cleanup(); resolve(this); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => failed(new Error('CC-Wire readiness timeout')), 18000);
      this.cancelWaiting = () => failed(new Error('Connection closed'));
      this.on('ready', ready).on('connect_error', failed);
      this.connect();
    }).finally(() => { this.waiting = null; });
    return this.waiting;
  }
}
