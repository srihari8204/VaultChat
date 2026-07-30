// lib/vaultBeamDirect.ts — VaultBeam direct tiers: P3 LAN (native TCP) + P2 P2P
// (WebRTC datachannel). Both move the SAME AES-256-GCM chunks with the SAME wire
// format as the R2 relay tier, so a chunk is tier-agnostic. The relay tier
// (lib/vaultBeamTransfer) remains the always-available baseline; these are the
// opportunistic fast paths used when both peers are online + reachable.
//
// Negotiation (receiver-driven, mutually exclusive, over the existing vaultbeam_*
// signaling relay):
//   recipient → vaultbeam_pull   "I'm ready — let's try direct"
//   sender    → vaultbeam_ready  "{lanIp,lanPort}"  (+ vaultbeam_offer for P2P)
//   recipient tries LAN connect, else answers the WebRTC offer, else
//             → vaultbeam_tier {mode:'relay'}  and both fall back to the relay.
//
// The sender serves BOTH transports and returns whichever the receiver actually
// used; the receiver tries LAN first (fastest), then P2P, then signals relay.
// Signaling is BUFFERED from the moment of pull so an early offer/ice is never
// lost while the LAN attempt is still running.

import { getSocket } from './socket';
import { getTurnConfig, type IceServer } from './chatService';
import { reprioritizeIceObject, readWinningPair } from './icePriority';
import perf from './perf';
import { newCallCipher, openCallOffer, type CallCipher } from './callCrypto';
import {
  isNativeStreamAvailable, prealloc, lanIp, lanServe, lanConnect,
  readCipherChunk, writeCipherChunk, onLanEvent,
} from './vaultBeamStreamNative';
import { Buffer } from 'buffer';

// WebRTC is native (react-native-webrtc). Lazy-require so a build without it (or
// Expo Go) degrades to relay instead of crashing at import.
let RTC: any = null;
try { RTC = require('react-native-webrtc'); } catch { RTC = null; }

const FRAME = 16 * 1024;            // SCTP-safe datachannel frame (≤16 KiB)
const BP_HIGH = 4 * 1024 * 1024;    // datachannel backpressure ceiling
const PULL_WAIT_MS   = 6000;        // recipient: wait for the sender's "ready"
const SERVE_WAIT_MS  = 20000;       // sender: wait for a pull before giving up to relay
const CONNECT_MS     = 12000;       // either side: give up on direct if nothing CONNECTS in time
const P2P_OFFER_MS   = 8000;        // recipient: wait for the sender's datachannel offer
const STALL_MS       = 15000;       // recipient: abandon a direct tier that goes silent → relay
const ACK_TIMEOUT_MS = 30000;       // sender: wait for the receiver's delivery ack after eof

// A direct tier that CONNECTS but then goes silent (Wi-Fi drop, peer suspended)
// must not hang forever — the recipient abandons it after STALL_MS with no
// progress and hotswaps to the relay. `ping()` on each progress tick; race the
// tier's promise against `promise` ('stalled').
function stallGuard(stallMs: number) {
  let last = Date.now();
  let timer: any;
  let fire: () => void = () => {};
  const promise = new Promise<'stalled'>((resolve) => { fire = () => resolve('stalled'); });
  const tick = () => { if (Date.now() - last >= stallMs) fire(); else timer = setTimeout(tick, 1000); };
  timer = setTimeout(tick, 1000);
  return { promise, ping: () => { last = Date.now(); }, cancel: () => clearTimeout(timer) };
}

export interface DirectGeom {
  transferId: string; fileId: string; keyB64: string; token: string; peerId: string;
  chunkBytes: number; chunkCount: number; totalBytes: number;
}
export type ProgressCb = (done: number, total: number) => void;

const b64ToU8 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const u8ToB64 = (u8: Uint8Array): string => Buffer.from(u8).toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function emit(event: string, data: any) {
  try { (await getSocket()).emit(event, data); } catch {}
}
function makePc(ice: IceServer[]): any {
  return new RTC.RTCPeerConnection({
    iceServers: ice as any,
    iceCandidatePoolSize: 4,      // pre-gather host candidates → IPv6 pair under test sooner
    bundlePolicy: 'max-bundle',
  });
}
async function iceServers(): Promise<IceServer[]> {
  // Cloudflare STUN is dual-stack — helps discover the IPv6 server-reflexive
  // candidate on networks where our coturn STUN is IPv4-only (feeds IPv6-first).
  const CF: IceServer = { urls: 'stun:stun.cloudflare.com:3478' };
  try { return [CF, ...(await getTurnConfig()).iceServers]; }
  catch { return [CF, { urls: 'stun:stun.l.google.com:19302' }]; }
}
// Log which candidate pair actually won (measures the real Jio/Airtel IPv6
// hit-rate — direct vs paid relay). Best-effort; never blocks the transfer.
function logIceWin(pc: any, tag: string): void {
  try {
    pc.getStats().then((s: any) => {
      const o = readWinningPair(s);
      if (o) perf.mark('vaultbeam_ice_win', { tag, wonVia: o.wonVia, direct: o.isDirect, ipv6: o.isIPv6, rttMs: o.roundTripTimeMs });
    }).catch(() => {});
  } catch {}
}

// Buffers all vaultbeam_* signaling for one transfer from the moment it's opened,
// so an offer/ready/ice that arrives before we're ready to consume it is queued,
// not lost. onIce, once set, drains + forwards queued candidates.
async function openInbox(transferId: string) {
  const s = await getSocket();
  const state: {
    ready?: any; offer?: any; answer?: any; iceQ: any[];
    onIce?: (c: any) => void;
    // Set AFTER the initial offer/answer is consumed — late arrivals are ICE
    // RESTARTS (UITE §12): a network flip mid-transfer renegotiates candidates
    // over the same DTLS session, so the datachannel (and the transfer) survive.
    onOffer?: (d: any) => void; onAnswer?: (d: any) => void;
  } = { iceQ: [] };
  const filt = (h: (d: any) => void) => (d: any) => { if (d?.transferId === transferId) h(d); };
  const hReady = filt((d) => { state.ready = d; });
  const hOffer = filt((d) => { state.offer = d; state.onOffer?.(d); });
  const hAnswer = filt((d) => { state.answer = d; state.onAnswer?.(d); });
  const hIce = filt((d) => { if (state.onIce) state.onIce(d.candidate); else state.iceQ.push(d.candidate); });
  s.on('vaultbeam_ready', hReady); s.on('vaultbeam_offer', hOffer);
  s.on('vaultbeam_answer', hAnswer); s.on('vaultbeam_ice', hIce);
  return {
    state,
    setOnIce(fn: (c: any) => void) { state.onIce = fn; const q = state.iceQ.splice(0); for (const c of q) fn(c); },
    close() { try { s.off('vaultbeam_ready', hReady); s.off('vaultbeam_offer', hOffer); s.off('vaultbeam_answer', hAnswer); s.off('vaultbeam_ice', hIce); } catch {} },
  };
}
// Poll a buffer field into existence (cheap; signaling is infrequent).
async function until<T>(get: () => T | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = get(); if (v) return v;
    if (signal?.aborted || Date.now() >= deadline) return undefined;
    await sleep(120);
  }
}

// ── SENDER ──────────────────────────────────────────────────────────
// Serve both transports after a pull; return 'lan' | 'p2p' on success, or null
// (→ caller uploads to the relay). Never throws.
export async function serveDirect(g: DirectGeom & { srcPath: string; onProgress?: ProgressCb; signal?: AbortSignal }): Promise<'lan' | 'p2p' | null> {
  if (!isNativeStreamAvailable() || !RTC) return null;
  const inbox = await openInbox(g.transferId);
  let pc: any = null;
  const cleanups: Array<() => void> = [inbox.close];

  // Wait for the recipient to ask for a direct pull (else → relay baseline).
  const gotPull = await waitFor('vaultbeam_pull', g.transferId, SERVE_WAIT_MS, g.signal);
  if (!gotPull) { for (const c of cleanups) c(); return null; }

  let connected = false;
  const result = await new Promise<'lan' | 'p2p' | null>((resolve) => {
    let settled = false;
    const done = (v: 'lan' | 'p2p' | null) => { if (!settled) { settled = true; resolve(v); } };
    const markConnected = () => { connected = true; };

    // LAN: advertise the bound port, mirror native progress onto the card.
    let lanIpVal: string | null = null;
    lanIp().then((ip) => { lanIpVal = ip; }).catch(() => {});
    cleanups.push(onLanEvent('vbLanBound', (d) => {
      if (d?.transferId === g.transferId) emit('vaultbeam_ready', { to: g.peerId, transferId: g.transferId, lanIp: lanIpVal, lanPort: d.port });
    }));
    cleanups.push(onLanEvent('vbLanProgress', (d) => {
      if (d?.transferId === g.transferId) { markConnected(); g.onProgress?.(d.done, d.total); }
    }));
    lanServe({
      srcPath: g.srcPath, keyB64: g.keyB64, transferId: g.transferId, fileId: g.fileId, token: g.token,
      chunkBytes: g.chunkBytes, chunkCount: g.chunkCount, totalBytes: g.totalBytes,
    }).then(() => done('lan')).catch(() => {});

    // P2P: offer a datachannel; stream once the recipient opens it. The SDP + ICE
    // are sealed with the per-transfer call cipher (callCrypto) so the server
    // never sees the DTLS fingerprint or device IPs — defence-in-depth on top of
    // the already-E2EE chunk payload. Plaintext fallback if E2EE isn't available.
    (async () => {
      try {
        pc = makePc(await iceServers());
        let cipher: CallCipher | null = null;

        // Remote ICE must NOT be applied before our setRemoteDescription —
        // react-native-webrtc throws on addIceCandidate with no remote desc,
        // silently dropping (often the host) candidate and making P2P fail
        // intermittently. Buffer remote candidates; flush once the answer lands.
        let remoteReady = false;
        const pendingIce: any[] = [];
        // IPv6-first: rewrite each candidate's priority so the IPv6 pair is checked
        // before IPv4/relay (both sides do it; ICE still falls through if IPv6 fails).
        const addIce = async (cand: any) => { try { await pc.addIceCandidate(new RTC.RTCIceCandidate(reprioritizeIceObject(cand))); } catch {} };
        inbox.setOnIce((c) => { const cand = cipher ? cipher.open(c) : c; if (!cand) return; if (remoteReady) addIce(cand); else pendingIce.push(cand); });

        // Outgoing ICE must NOT egress before the cipher exists, or the server
        // sees device IPs unsealed. Buffer until the cipher is derived, then flush.
        let sealReady = false;
        const outIce: any[] = [];
        const emitIce = (c: any) => { const b = reprioritizeIceObject(c); emit('vaultbeam_ice', { to: g.peerId, transferId: g.transferId, candidate: cipher ? cipher.seal(b) : b }); };
        pc.onicecandidate = (e: any) => { if (!e.candidate) return; if (sealReady) emitIce(e.candidate); else outIce.push(e.candidate); };

        const dc = pc.createDataChannel('vaultbeam', { ordered: true });
        // Delivery ack: the receiver sends {t:'ack'} only after every chunk is
        // decrypted + on disk. p2pSend waits for this before resolving 'p2p'.
        // Progress acks {t:'p',n} arrive per chunk the receiver has VERIFIED
        // (GCM tag ok + written) — the sender's bar tracks those, never bytes
        // pushed into the SCTP buffer, so it can't show 100% while the receiver
        // is still at 30%.
        let ackResolve: (() => void) | null = null;
        const ackP = new Promise<void>((r) => { ackResolve = r; });
        dc.onmessage = (m: any) => {
          try {
            if (typeof m.data !== 'string') return;
            const c = JSON.parse(m.data);
            if (c?.t === 'ack') ackResolve?.();
            else if (c?.t === 'p' && Number.isInteger(c.n) && c.n >= 1 && c.n <= g.chunkCount) g.onProgress?.(c.n, g.chunkCount);
          } catch {}
        };
        // Connected but stalled / no ack in time → resolve null so the caller
        // falls back to the relay instead of the send hanging on a dead channel.
        dc.onopen = () => { markConnected(); logIceWin(pc, 'send'); p2pSend(dc, g, ackP).then(() => done('p2p')).catch(() => done(null)); };

        // Apply the (buffered) answer, THEN release the queued remote candidates.
        (async () => {
          const a = await until(() => inbox.state.answer, CONNECT_MS + 5000, g.signal);
          if (a?.answer) {
            const ans = cipher ? cipher.open(a.answer) : a.answer;
            if (ans) { try { await pc.setRemoteDescription(new RTC.RTCSessionDescription(ans)); remoteReady = true; for (const c of pendingIce.splice(0)) addIce(c); } catch {} }
          }
          // From here on, any further answer is the receiver accepting an ICE restart.
          inbox.state.onAnswer = async (ra: any) => {
            const rans = cipher ? cipher.open(ra.answer) : ra.answer;
            if (!rans) return;
            try { await pc.setRemoteDescription(new RTC.RTCSessionDescription(rans)); } catch {}
          };
        })();

        // ICE restart (UITE §12): a mid-transfer network flip (Wi-Fi→LTE, new IP)
        // drops the candidate pair but NOT the DTLS session — renegotiating
        // candidates lets the datachannel resume where it stopped instead of
        // failing over to the relay and re-uploading from zero. 'disconnected'
        // gets a 3s grace (often self-heals); 'failed' restarts immediately.
        // Capped at 3; a restart that can't recover falls through to the
        // existing stall→relay safety net.
        let restarts = 0;
        let restartTimer: any = null;
        cleanups.push(() => clearTimeout(restartTimer));
        const iceRestart = async () => {
          if (restarts >= 3 || !cipher) return;
          restarts++;
          try {
            const ro = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(ro);
            emit('vaultbeam_offer', { to: g.peerId, transferId: g.transferId, offer: cipher.seal(ro) });
          } catch {}
        };
        pc.oniceconnectionstatechange = () => {
          const st = pc.iceConnectionState;
          if (st === 'failed') { clearTimeout(restartTimer); iceRestart(); }
          else if (st === 'disconnected') { clearTimeout(restartTimer); restartTimer = setTimeout(() => { if (pc.iceConnectionState === 'disconnected') iceRestart(); }, 3000); }
          else if (st === 'connected' || st === 'completed') clearTimeout(restartTimer);
        };

        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        const cc = await newCallCipher(g.peerId, offer); // seal offer + derive cipher
        cipher = cc?.cipher ?? null;
        sealReady = true;
        for (const c of outIce.splice(0)) emitIce(c);   // flush candidates gathered pre-cipher
        emit('vaultbeam_offer', { to: g.peerId, transferId: g.transferId, offer: cc ? cc.offerWire : offer });
      } catch { /* P2P setup failed → LAN or relay */ }
    })();

    // Give up on direct only if NOTHING connected in time (an in-flight transfer
    // is never interrupted by this).
    setTimeout(() => { if (!connected) done(null); }, CONNECT_MS);
    // The receiver asks for the relay once it abandons BOTH direct tiers (stall).
    // Honor it for the whole serve window — even if a tier "connected" then died —
    // so the sender stops and the relay baseline takes over instead of hanging.
    waitFor('vaultbeam_tier', g.transferId, ACK_TIMEOUT_MS, g.signal).then((d) => { if (d?.mode === 'relay') done(null); });
    try { g.signal?.addEventListener?.('abort', () => done(null)); } catch {}
  });

  for (const c of cleanups) { try { c(); } catch {} }
  try { pc?.close(); } catch {}
  return result;
}

// Resolve on the first `event` whose payload.transferId matches, else null after
// timeout / abort.
async function waitFor(event: string, transferId: string, timeoutMs: number, signal?: AbortSignal): Promise<any | null> {
  const s = await getSocket();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: any) => { if (done) return; done = true; try { s.off(event, handler); } catch {}; clearTimeout(timer); resolve(v); };
    const handler = (d: any) => { if (d?.transferId === transferId) finish(d); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.on(event, handler);
    try { signal?.addEventListener?.('abort', () => finish(null)); } catch {}
  });
}

// ── RECIPIENT ───────────────────────────────────────────────────────
// Try direct; return true if fully received, false → use the relay.
export async function receiveDirect(g: DirectGeom & { dstPath: string; onProgress?: ProgressCb; signal?: AbortSignal }): Promise<boolean> {
  if (!isNativeStreamAvailable() || !RTC) return false;
  await prealloc(g.dstPath, g.totalBytes);

  const inbox = await openInbox(g.transferId);
  try {
    emit('vaultbeam_pull', { to: g.peerId, transferId: g.transferId });

    // LAN first (fastest) — if the sender advertised a reachable endpoint. A tier
    // that connects then goes silent for STALL_MS is abandoned → next tier / relay.
    const ready = await until(() => inbox.state.ready, PULL_WAIT_MS, g.signal);
    if (ready?.lanIp && ready?.lanPort) {
      const guard = stallGuard(STALL_MS);
      const offP = onLanEvent('vbLanProgress', (d) => { if (d?.transferId === g.transferId) { guard.ping(); g.onProgress?.(d.done, d.total); } });
      try {
        const res = await Promise.race([
          lanConnect({
            host: ready.lanIp, port: ready.lanPort, dstPath: g.dstPath, keyB64: g.keyB64,
            transferId: g.transferId, fileId: g.fileId, token: g.token,
            chunkBytes: g.chunkBytes, chunkCount: g.chunkCount, totalBytes: g.totalBytes,
          }).then((n) => (n === g.chunkCount ? 'done' : 'fail')).catch(() => 'fail'),
          guard.promise, // 'stalled'
        ]);
        if (res === 'done') { g.onProgress?.(g.chunkCount, g.chunkCount); return true; }
      } finally { guard.cancel(); offP(); }
    }

    // P2P — answer the sender's (buffered) datachannel offer and pull chunks.
    const guard2 = stallGuard(STALL_MS);
    try {
      const res = await Promise.race([
        p2pReceive({ ...g, onProgress: (d, t) => { guard2.ping(); g.onProgress?.(d, t); } }, inbox).then((ok) => (ok ? 'done' : 'fail')),
        guard2.promise,
      ]);
      if (res === 'done') return true;
    } finally { guard2.cancel(); }

    emit('vaultbeam_tier', { to: g.peerId, transferId: g.transferId, mode: 'relay' });
    return false;
  } finally { inbox.close(); }
}

// ── P2P datachannel data path (bounded to one chunk in JS heap) ──────
// Per chunk: a JSON control frame {t:'c',i,len} then the ciphertext in ≤16 KiB
// binary frames; {t:'eof'} ends the stream. Ordered channel → sequential.
async function p2pSend(dc: any, g: DirectGeom & { srcPath: string; onProgress?: ProgressCb; signal?: AbortSignal }, ackP: Promise<void>): Promise<void> {
  for (let i = 0; i < g.chunkCount; i++) {
    if (g.signal?.aborted) throw new Error('aborted');
    const ct = b64ToU8(await readCipherChunk({
      srcPath: g.srcPath, keyB64: g.keyB64, transferId: g.transferId, fileId: g.fileId,
      chunkIndex: i, chunkBytes: g.chunkBytes, chunkCount: g.chunkCount, totalBytes: g.totalBytes,
    }));
    dc.send(JSON.stringify({ t: 'c', i, len: ct.length }));
    for (let off = 0; off < ct.length; off += FRAME) {
      while (dc.bufferedAmount > BP_HIGH) { if (g.signal?.aborted) throw new Error('aborted'); await sleep(15); }
      dc.send(new Uint8Array(ct.subarray(off, off + FRAME)));
    }
    // No onProgress here: "sent" only means buffered into SCTP. The sender's
    // progress comes from the receiver's {t:'p'} verified-chunk acks (serveDirect).
  }
  dc.send(JSON.stringify({ t: 'eof' }));
  // Only 'delivered' once the receiver confirms every chunk landed; no ack in
  // time → treat as failed so the caller falls back to the relay (guaranteed).
  await Promise.race([ackP, sleep(ACK_TIMEOUT_MS).then(() => { throw new Error('no p2p delivery ack'); })]);
}

async function p2pReceive(g: DirectGeom & { dstPath: string; onProgress?: ProgressCb; signal?: AbortSignal }, inbox: Awaited<ReturnType<typeof openInbox>>): Promise<boolean> {
  const offerMsg = await until(() => inbox.state.offer, P2P_OFFER_MS, g.signal);
  if (!offerMsg?.offer) return false;
  // Decrypt the sealed offer + derive the cipher (plaintext passthrough for a
  // legacy peer). A sealed offer we can't open (stale session) → give up → relay.
  const { cipher, offer: sdp } = await openCallOffer(g.peerId, offerMsg.offer);
  if (!sdp) return false;
  let pc: any = null;
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      (async () => {
        try {
          pc = makePc(await iceServers());
          pc.onicecandidate = (e: any) => { if (e.candidate) emit('vaultbeam_ice', { to: g.peerId, transferId: g.transferId, candidate: cipher.seal(reprioritizeIceObject(e.candidate)) }); };
          // Same rule as the sender: buffer remote ICE until our setRemoteDescription
          // is applied, else react-native-webrtc drops the early (host) candidate.
          let remoteReady = false;
          const pendingIce: any[] = [];
          // IPv6-first bias (see the sender path).
          const addIce = async (cand: any) => { try { await pc.addIceCandidate(new RTC.RTCIceCandidate(reprioritizeIceObject(cand))); } catch {} };
          inbox.setOnIce((c) => { const cand = cipher.open(c); if (!cand) return; if (remoteReady) addIce(cand); else pendingIce.push(cand); });

          pc.ondatachannel = (ev: any) => {
            const dc = ev.channel;
            dc.onopen = () => logIceWin(pc, 'recv');   // measure the winning pair (IPv6 vs relay)
            let cur: { i: number; len: number; buf: Uint8Array; off: number } | null = null;
            let received = 0;
            // Ack only after every chunk is decrypted + written, so the sender's
            // "Delivered" is truthful. Delay the resolve briefly so the ack egresses
            // before p2pReceive's finally closes the peer connection.
            const finishOk = () => { try { dc.send(JSON.stringify({ t: 'ack' })); } catch {}; setTimeout(() => done(true), 300); };
            dc.onmessage = async (m: any) => {
              try {
                if (typeof m.data === 'string') {
                  const ctl = JSON.parse(m.data);
                  if (ctl.t === 'eof') { if (received === g.chunkCount) finishOk(); else done(false); return; }
                  if (ctl.t === 'c') cur = { i: ctl.i, len: ctl.len, buf: new Uint8Array(ctl.len), off: 0 };
                  return;
                }
                if (!cur) return;
                const bytes = m.data instanceof ArrayBuffer ? new Uint8Array(m.data) : new Uint8Array(m.data.buffer || m.data);
                const take = Math.min(bytes.length, cur.len - cur.off);
                cur.buf.set(bytes.subarray(0, take), cur.off);
                cur.off += take;
                if (cur.off >= cur.len) {
                  const i = cur.i, ctB64 = u8ToB64(cur.buf); cur = null;
                  await writeCipherChunk({
                    dstPath: g.dstPath, keyB64: g.keyB64, transferId: g.transferId, fileId: g.fileId,
                    chunkIndex: i, chunkBytes: g.chunkBytes, chunkCount: g.chunkCount, totalBytes: g.totalBytes, ctB64,
                  });
                  received++;
                  g.onProgress?.(received, g.chunkCount);
                  // Verified-progress ack: this chunk passed its GCM tag and is
                  // on disk. (A tag failure lands in the catch below → tier fails
                  // → relay takes over; retransmitting identical bytes over a
                  // reliable ordered channel would fail identically, so we don't.)
                  try { dc.send(JSON.stringify({ t: 'p', n: received })); } catch {}
                  if (received === g.chunkCount) finishOk();
                }
              } catch { done(false); }
            };
          };

          await pc.setRemoteDescription(new RTC.RTCSessionDescription(sdp));
          remoteReady = true; for (const c of pendingIce.splice(0)) addIce(c);   // release queued candidates
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          emit('vaultbeam_answer', { to: g.peerId, transferId: g.transferId, answer: cipher.seal(answer) });
          // Any offer AFTER the initial one is the sender's ICE restart (§12):
          // apply + answer so the surviving datachannel picks a fresh pair.
          inbox.state.onOffer = async (om: any) => {
            const off = cipher.open(om.offer);
            if (!off) return;
            try {
              await pc.setRemoteDescription(new RTC.RTCSessionDescription(off));
              const rans = await pc.createAnswer();
              await pc.setLocalDescription(rans);
              emit('vaultbeam_answer', { to: g.peerId, transferId: g.transferId, answer: cipher.seal(rans) });
            } catch {}
          };
          try { g.signal?.addEventListener?.('abort', () => done(false)); } catch {}
        } catch { done(false); }
      })();
    });
  } catch { return false; }
  finally { try { pc?.close(); } catch {} }
}

export default {};
