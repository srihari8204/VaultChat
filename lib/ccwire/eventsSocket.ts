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
// ViewerActivity (envelope.proto) by the name the Socket.IO payload carries —
// the mirror of viewerActivityWire in ccwire_presence.go.
const VIEWER_ACTIVITY: Record<string, number> = { reading: 1, typing: 2, uploading: 3 };

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
      if (!c) return this;
      // Typing goes out as the TYPED body 81 only when the SERVER advertised
      // typed_app_bodies. A server that predates capabilities.proto field 9
      // leaves it unset, so this is false and the app_event (100) frame below
      // is emitted byte-identically to before — that fallback is the contract.
      //
      // Same traffic_class/stream the app_event form used, so nothing about how
      // this frame is classified changes. Inbound frames are never sequenced by
      // the server (ccwire_seq.go allocates seq on SEND only; ccwire.go
      // noteSentLocked is the sole cursor writer and reads m.Seq of outbound
      // frames), so this cannot advance any cursor either way.
      //
      // sender_uid (field 3) is DELIBERATELY not sent: the server derives it
      // from the session (ccwire_messages.go typing() uses s.d.uid and
      // DecodeTyping never reads field 3). Sending it would be a spoofing
      // surface for whose ghost-mode applies.
      const typing = event === 'typing_start' || event === 'typing_stop';
      if (typing && c.serverHello?.typedAppBodies && typeof payload?.chatId === 'string' && payload.chatId) {
        c.send({ request_id: c.nextRequestId(), traffic_class: 1, stream: 1,
          body_field: 81, value: { chat_id: payload.chatId, typing: event === 'typing_start' } });
        return this;
      }
      // join_chat is the SAME gate again, onto a body the server has served
      // since CC-Wire shipped: Subscribe (32) with SCOPE_KIND_CHAT.
      //
      // The two paths end in the SAME place. app_event join_chat reaches
      // handlers.go registerChatHandlersPeer, which checks chatMemberAllowed
      // and calls s.Join("chat:<id>") -> joinEventRoom -> s.subs. Body 32
      // reaches ccwire.go s.scope, which checks subscribeAllowed ->
      // chatMemberAllowed (the comment there says "the same check join_chat
      // makes", same cache, same generation) and calls joinEventRoom with
      // scopeRoom(CHAT, id) — the identical "chat:<id>" key. Nothing else in
      // the app_event handler does anything else.
      //
      // Only the ANSWER differs, and neither is load-bearing: join_chat replies
      // nothing, Subscribe replies an Ack (22) that no listener matches, and a
      // refusal is NOT_PERMITTED which sendError classes RETRYABLE, so the
      // session survives exactly as it does through today's silent refusal.
      //
      // leave_chat stays on app_event: handlers.go's leave_chat deletes the
      // same s.subs key, so a typed join and a legacy leave still compose.
      //
      // The subscription bookkeeping above has already run, so a reconnect
      // replays this through emit() and takes this same branch again.
      if (event === 'join_chat' && c.serverHello?.typedAppBodies
          && typeof payload?.chatId === 'string' && payload.chatId) {
        c.send({ request_id: c.nextRequestId(), traffic_class: 1, stream: 1,
          body_field: 32, value: { kind: 1, id: payload.chatId } });
        return this;
      }
      // join_call is the same move, one ScopeKind along: SCOPE_KIND_CALL = 3.
      //
      // It waited for the server, and this comment records why it could not
      // ship with join_chat. Body 32 with kind CALL reached ccwire.go s.scope,
      // which took the gate and joined "call:<id>" — and then ACKED AND STOPPED.
      // None of what join_call does happened: no call_roster to the joiner, no
      // call_peer_joined to the room, no cluster roster write, and a mesh-cap
      // refusal that arrived as a bare NOT_PERMITTED. A client on that door
      // would have sat in a call it could not see and nobody could see it in.
      // s.scope's CALL arm now does all four, in both directions (Unsubscribe
      // emits call_peer_left and clears the cluster roster) — pinned by
      // ccwire_call_parity_test.go.
      //
      // The REPLY is decodable, which is what chat_view failed on: every call
      // event still arrives as app_event (100), the same frames the app_event
      // door produces, through the same handlers.go emits. The Ack (22) that
      // answers the Subscribe has no listener, exactly as join_chat's does not.
      //
      // leave_call stays on app_event, like leave_chat: handlers.go's leave_call
      // emits call_peer_left and deletes the same s.subs key, so a typed join
      // and a legacy leave still compose.
      if (event === 'join_call' && c.serverHello?.typedAppBodies
          && typeof payload?.chatId === 'string' && payload.chatId) {
        c.send({ request_id: c.nextRequestId(), traffic_class: 1, stream: 1,
          body_field: 32, value: { kind: 3, id: payload.chatId } });
        return this;
      }
      // channel_join is NOT migrated with it. Same wire shape, DIFFERENT
      // policy: chat is membership-gated on both transports, channel is
      // ungated on both by deliberate policy (handlers.go channel_join has no
      // check; subscribeAllowed's SCOPE_KIND_CHANNEL returns true and says
      // why). Moving an ungated join onto a gate-shaped body buys nothing and
      // would have to be undone when channels grow a real check.
      //
      // chat_view is the SAME gate, one body along: typed body 82 ViewerState
      // only when the server advertised typed_app_bodies, byte-identical
      // app_event (100) otherwise, same traffic_class/stream either way.
      //
      // ViewerState has NO identity field to withhold — typedbody.go
      // readViewerState reads fields 1..4 and nothing else, and
      // ccwire_presence.go viewerState takes the actor from s.d.uid — so unlike
      // TypingState.sender_uid there is nothing here a client could spoof.
      //
      // The mapping is onChatViewPeer's own, read field for field: status
      // "LEFT" is `leaving`, activity is the three-name table Go keeps in
      // viewerActivityWire, resync is resync. An activity string this build
      // does not know would reach cvTouch verbatim over app_event but as "" via
      // the enum, so it stays on app_event rather than quietly changing meaning.
      // REVERTED 2026-09-18 — chat_view stays on app_event (100). The emit was
      // correct; the REPLY is not decodable by this build.
      //
      // The two server paths answer differently. app_event chat_view reaches
      // handlers.go onChatViewPeer, which replies `viewer_list` as an
      // app_event (100) — which hooks/useChatViewers.ts consumes. The typed
      // path reaches ccwire_presence.go viewerState, which replies with typed
      // body 83 (ViewerList). transport.ts decodes only 81 and 100, and
      // codec.ts has no reader for 83 at all, so the initial roster sent on
      // `isNew || resync` would be silently DROPPED.
      //
      // It fails partially, which is the worst shape: viewer_joined/left/
      // activity still arrive as app_event, so the list updates incrementally
      // but never populates on entry. Found by audit, before any build.
      //
      // To redo this: add a body-83 reader to codec.ts and decode it in
      // transport.ts FIRST, then restore the branch. Typing (81) has no such
      // reply and is unaffected.
      c.send({ request_id: c.nextRequestId(), traffic_class: 1, stream: 1,
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
