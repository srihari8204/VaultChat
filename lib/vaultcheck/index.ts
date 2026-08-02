// lib/vaultcheck/index.ts — VaultCheck orchestration.
//
// Runs the available authenticity layers over a photo or video and combines
// them into one verdict, plus the per-layer detail the user can inspect.
//
// ── How the verdict is formed, and why it is conservative ──
//
// Three layers, only two of which exist today:
//
//   C2PA      — real. Strong POSITIVE evidence when a valid signature and
//               matching hard binding are present. Its absence proves nothing:
//               most phones and every screenshot strip it.
//   rPPG      — real, video only. Finding a pulse is decent evidence of a live
//               human. Not finding one is weak evidence of anything, because
//               lighting, motion and compression destroy the signal.
//   Detector  — NOT bundled (see detector.ts for why that is deliberate).
//
// So the combiner is asymmetric on purpose: it is willing to say "likely
// authentic" on strong positive evidence, and it is very reluctant to say
// "likely fake". The only route to 'likely-fake' today is a C2PA hard-binding
// MISMATCH — a signed asset whose pixels were altered after signing, which is
// a fact, not an inference.
//
// Everything else lands in 'unknown', and the UI says "we couldn't verify this"
// rather than implying innocence or guilt. That is the honest output of a
// two-layer system, and it is what protects a user from acting on a
// confident-sounding guess.

import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { verifyC2pa, type C2paResult } from './c2pa';
import { analyseVideo, isRppgAvailable, type RppgResult } from './rppg';
import { run as runDetector, type DetectorResult } from './detector';

export type Verdict = 'likely-authentic' | 'unknown' | 'likely-fake';

export interface VaultCheckReport {
  verdict: Verdict;
  /** One-line plain-language summary for the result card headline. */
  headline: string;
  /** What the user should take away, including the limits of this answer. */
  detail: string;
  c2pa: C2paResult;
  rppg?: RppgResult;
  detector: DetectorResult;
  kind: 'image' | 'video';
  checkedAt: string;
  /** Layers that could not run at all, for the "what wasn't checked" line. */
  notChecked: string[];
}

async function readBytes(uri: string): Promise<Uint8Array | null> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Verify a media file.
 *
 * `uri` must be a local file — VaultCheck runs entirely on-device and never
 * uploads the media, which is the whole point for the content this feature
 * exists to handle.
 */
export async function verifyMedia(
  uri: string,
  kind: 'image' | 'video',
): Promise<VaultCheckReport> {
  const notChecked: string[] = [];

  // ── C2PA ──
  let c2pa: C2paResult = {
    present: false, actions: [], binding: 'absent', signature: 'absent', issuer: 'unverified',
  };
  const bytes = await readBytes(uri);
  if (!bytes) {
    notChecked.push('Content Credentials (file could not be read)');
  } else if (kind === 'video') {
    // C2PA in MP4/BMFF lives in a different box structure than the JPEG/PNG
    // path implemented here. Saying so beats silently reporting "no manifest".
    notChecked.push('Content Credentials (video containers not supported yet)');
  } else {
    c2pa = verifyC2pa(bytes);
  }

  // ── rPPG ──
  let rppg: RppgResult | undefined;
  if (kind === 'video') {
    if (!isRppgAvailable()) notChecked.push('Heartbeat analysis (not available in this build)');
    else rppg = await analyseVideo(uri);
  }

  // ── learned detector ──
  const detector = await runDetector(uri);
  if (!detector.available) notChecked.push('AI detection model (not bundled — see release notes)');

  // ── combine ──
  let verdict: Verdict = 'unknown';
  let headline = 'Could not verify';
  let detail =
    'Nothing here proves this is fake or genuine. Most photos carry no ' +
    'Content Credentials, and a screenshot strips them, so this result is ' +
    'common for real images too.';

  if (c2pa.binding === 'mismatch') {
    // A signed asset whose bytes no longer hash to the claim. This is the one
    // fact — not inference — that supports a negative verdict.
    verdict = 'likely-fake';
    headline = 'Altered after signing';
    detail =
      'This file carries Content Credentials, but the image no longer matches ' +
      'what was signed — it was edited after the camera or editor signed it. ' +
      'That does not say who altered it or how.';
  } else if (c2pa.present && c2pa.signature === 'valid' && c2pa.binding === 'match') {
    verdict = 'likely-authentic';
    headline = 'Signed and unaltered';
    detail =
      `Content Credentials verify: signed${c2pa.generator ? ` by ${c2pa.generator}` : ''} and ` +
      'the image still matches what was signed. The signing certificate itself ' +
      'has not been checked against a trust list, so this confirms the file is ' +
      'unaltered, not that the signer is who they claim to be.';
  } else if (rppg?.verdict === 'pulse') {
    verdict = 'likely-authentic';
    headline = `Heartbeat detected (${rppg.bpm} BPM)`;
    detail =
      'A cardiac pulse was measured in the skin tones of this video, which ' +
      'generated faces do not produce. This is good evidence of a real person ' +
      'on camera — it does not verify who they are or what was said.';
  } else if (rppg?.verdict === 'no-pulse') {
    // Explicitly NOT 'likely-fake'. See the header.
    verdict = 'unknown';
    headline = 'No heartbeat found';
    detail =
      'No pulse could be measured. That happens with generated video — but ' +
      'also with poor lighting, a moving camera, heavy compression, or a face ' +
      'that is small or turned away. On its own this is not evidence of a fake.';
  } else if (c2pa.present && c2pa.signature === 'invalid') {
    verdict = 'unknown';
    headline = 'Credentials could not be trusted';
    detail =
      'This file carries Content Credentials whose signature did not verify. ' +
      'That can mean tampering, or simply a signing method this app cannot ' +
      'check yet.';
  }

  return {
    verdict, headline, detail,
    c2pa, rppg, detector, kind,
    checkedAt: new Date().toISOString(),
    notChecked,
  };
}

/**
 * Render a report as shareable plain text — for sending to family, a lawyer, or
 * the police. States the limits inline so the document cannot be quoted as a
 * stronger claim than it is.
 */
export function formatReport(r: VaultCheckReport): string {
  const lines: string[] = [];
  lines.push('VaultChat — Media verification report');
  lines.push(`Checked: ${new Date(r.checkedAt).toLocaleString()}`);
  lines.push(`Media type: ${r.kind}`);
  lines.push('');
  lines.push(`RESULT: ${r.headline}`);
  lines.push(r.detail);
  lines.push('');
  lines.push('Content Credentials (C2PA)');
  if (!r.c2pa.present) {
    lines.push('  No credentials embedded.');
  } else {
    lines.push(`  Generator: ${r.c2pa.generator ?? 'unknown'}`);
    lines.push(`  Signature: ${r.c2pa.signature}`);
    lines.push(`  Content binding: ${r.c2pa.binding}`);
    if (r.c2pa.signerName) lines.push(`  Signer: ${r.c2pa.signerName}`);
    lines.push('  Issuer trust: not checked against a trust list');
    for (const a of r.c2pa.actions) lines.push(`  Action: ${a.action}${a.when ? ` (${a.when})` : ''}`);
  }
  if (r.rppg) {
    lines.push('');
    lines.push('Heartbeat analysis (rPPG)');
    lines.push(`  Result: ${r.rppg.verdict}`);
    if (r.rppg.bpm) lines.push(`  Rate: ${r.rppg.bpm} BPM`);
    if (r.rppg.reason) lines.push(`  Note: ${r.rppg.reason}`);
  }
  if (r.notChecked.length) {
    lines.push('');
    lines.push('Not checked');
    for (const n of r.notChecked) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push(
    'This report is a technical opinion produced on-device, not proof. ' +
    'It is not a forensic examination and does not replace expert testimony.',
  );
  return lines.join('\n');
}

export default {};
