// lib/call/opus.selftest.ts — run: npx tsx lib/call/opus.selftest.ts
//
// SDP rewriting is the kind of code that appears to work and quietly breaks a
// call: drop one parameter the stack set and audio degrades, mangle a line and
// setLocalDescription throws. The properties below are the ones that actually
// matter.
//
// FEC and DTX are negotiated codec parameters — there is no runtime API — so if
// this transform is wrong there is no second chance to apply them.

import { tuneOpus } from './opus';

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 103',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;maxaveragebitrate=24000',
  'a=rtpmap:103 ISAC/16000',
  'a=fmtp:103 mode=20',
].join('\r\n');

let failures = 0;
const check = (name: string, ok: boolean) => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗'} ${name}`); };
const fmtpFor = (sdp: string, pt: string) =>
  sdp.split(/\r?\n/).find(l => l.startsWith(`a=fmtp:${pt} `)) ?? '';

console.log('\nOpus SDP tuning\n');

const out = tuneOpus(SDP);
const opus = fmtpFor(out, '111');

// ── the point of the whole file ───────────────────────────────────────
check('in-band FEC enabled', /useinbandfec=1/.test(opus));
check('DTX enabled', /usedtx=1/.test(opus));
check('stereo disabled (voice is mono)', /stereo=0/.test(opus));

// ── must not destroy what the stack already set ───────────────────────
// A blanket rewrite would drop these, and minptime in particular changes
// packetisation — a silent audio-quality regression.
check('minptime preserved', /minptime=10/.test(opus));
check('maxaveragebitrate preserved', /maxaveragebitrate=24000/.test(opus));

// ── must not touch other codecs ───────────────────────────────────────
check('the non-Opus payload is untouched', fmtpFor(out, '103') === 'a=fmtp:103 mode=20');

// ── no duplicates on a second pass ────────────────────────────────────
// Renegotiation re-tunes an SDP that was already tuned; duplicated keys make
// some stacks reject the description outright.
const twice = tuneOpus(out);
check('idempotent — running twice changes nothing', twice === out);
check('no duplicated useinbandfec', (fmtpFor(twice, '111').match(/useinbandfec/g) ?? []).length === 1);

// ── an Opus payload with NO fmtp line still gets one ──────────────────
const noFmtp = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'].join('\r\n');
const added = tuneOpus(noFmtp);
check('fmtp is created when absent', /a=fmtp:111 .*useinbandfec=1/.test(added));
check('...and placed after its rtpmap', added.indexOf('a=rtpmap:111') < added.indexOf('a=fmtp:111'));

// ── non-standard payload numbers ──────────────────────────────────────
// 111 is conventional, not guaranteed; assuming it would silently no-op.
const pt = ['m=audio 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 opus/48000/2', 'a=fmtp:96 minptime=10'].join('\r\n');
check('works on a non-111 Opus payload', /useinbandfec=1/.test(fmtpFor(tuneOpus(pt), '96')));

// ── inputs that must pass through untouched ───────────────────────────
check('an SDP with no Opus is unchanged', tuneOpus('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96') === 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96');
check('empty input is safe', tuneOpus('') === '');

// ── line integrity ────────────────────────────────────────────────────
check('no line count change on the tuned SDP',
  out.split(/\r?\n/).length === SDP.split(/\r?\n/).length);
check('every line still well formed', out.split(/\r?\n/).every(l => l === '' || /^[a-z]=/.test(l)));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all Opus tuning checks passed\n');
process.exit(failures ? 1 : 0);
