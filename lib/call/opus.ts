// lib/call/opus.ts — Opus tuning for cellular networks.
//
// WHY SDP AND NOT setParameters
// -----------------------------
// maxBitrate is an RTCRtpSender parameter, so it CAN be set at runtime (the
// policy for that lives in lib/call/quality.ts, which is written and tested
// but not yet wired to a sender - see its header).
// runtime. FEC and DTX are NOT: they are negotiated codec parameters carried in
// the SDP `a=fmtp` line for the Opus payload type, and they must be agreed at
// offer/answer time. There is no runtime API for them, which is why this is a
// text transform rather than a method call.
//
// WHAT THESE ACTUALLY DO
//   useinbandfec=1  In-band Forward Error Correction. The encoder embeds a
//                   low-bitrate copy of the PREVIOUS frame inside the next one,
//                   so a receiver that loses a packet reconstructs it from the
//                   packet after it — no retransmission, no added latency. This
//                   is what keeps speech intelligible on a lossy cellular link
//                   instead of dropping syllables.
//   usedtx=1        Discontinuous Transmission. Sends almost nothing during
//                   silence rather than encoding the room. On a two-way call
//                   each person is silent about half the time, so this is a
//                   large saving in mobile data and radio wake time — which is
//                   battery, not just bytes.
//   stereo=0        Voice is mono. Stereo doubles the payload for no benefit
//                   and some phones default to negotiating it.
//
// Both sides must offer these for them to apply in each direction, which is why
// the transform runs on offers AND answers.
//
// Pure string in, string out — no WebRTC import, so it is checkable in Node.

/** The fmtp parameters we want present on every Opus payload. */
const WANT: Record<string, string> = {
  useinbandfec: '1',
  usedtx: '1',
  stereo: '0',
};

/**
 * Add FEC/DTX to the Opus fmtp lines of an SDP.
 *
 * Existing parameters are PRESERVED and never duplicated: the browser/native
 * stack sets things like `minptime` and `maxaveragebitrate` that matter, and a
 * blanket rewrite would silently drop them. A malformed or Opus-free SDP is
 * returned untouched — audio must keep working even if this cannot help.
 */
export function tuneOpus(sdp: string): string {
  if (!sdp || !/opus/i.test(sdp)) return sdp;

  // Opus payload numbers are dynamic and there can be more than one (e.g. a
  // second at a different clock rate), so they are read from the rtpmap lines
  // rather than assumed to be 111.
  const payloads = new Set<string>();
  for (const m of sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/\d+/gim)) payloads.add(m[1]);
  if (payloads.size === 0) return sdp;

  const seen = new Set<string>();
  const lines = sdp.split(/\r?\n/);

  const out = lines.map(line => {
    const m = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (!m || !payloads.has(m[1])) return line;
    seen.add(m[1]);

    const params = new Map<string, string>();
    for (const kv of m[2].split(';')) {
      const [k, v] = kv.split('=');
      if (k?.trim()) params.set(k.trim(), (v ?? '').trim());
    }
    for (const [k, v] of Object.entries(WANT)) params.set(k, v);

    const merged = Array.from(params, ([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
    return `a=fmtp:${m[1]} ${merged}`;
  });

  // An Opus payload with NO fmtp line at all still needs one, or the parameters
  // are simply never negotiated. Insert directly after its rtpmap so the SDP
  // stays in the conventional order.
  const missing = Array.from(payloads).filter(p => !seen.has(p));
  if (missing.length === 0) return out.join('\r\n');

  const withFmtp: string[] = [];
  for (const line of out) {
    withFmtp.push(line);
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\/\d+/i);
    if (m && missing.includes(m[1])) {
      withFmtp.push(`a=fmtp:${m[1]} ` +
        Object.entries(WANT).map(([k, v]) => `${k}=${v}`).join(';'));
    }
  }
  return withFmtp.join('\r\n');
}

export default { tuneOpus };
