// lib/trackingId.ts — VaultView steganographic recipient ID.
//
// A 48-bit id is embedded in the pixels of protected media before upload, so a
// photo that later surfaces on a leak site can be traced back to the recipient
// device it was sent to. It sits UNDER the visible watermark: crop the visible
// overlay off and the hidden id is still there.
//
// ── What this is, honestly ──
//
// The codec is pair-wise block-mean luminance modulation (see
// plugins/android/VaultMediaModule.kt for the full description and the matching
// Swift twin). It survives JPEG re-encode, brightness/contrast changes, and
// cropping. It does NOT survive rescaling, rotation, or heavy blur.
//
// That matters for how the result is used: a failed extraction means "no id
// recovered", NOT "this person is innocent", and a successful extraction is
// gated on a CRC so it will not name the wrong person. Both halves of that are
// load-bearing — this feature's output is an accusation.
//
// ── Privacy of the id itself ──
//
// The embedded value is NOT the recipient's user id. It is a per-(message,
// recipient) random 48-bit token, and the mapping token → recipient lives only
// on the sender's device (mapStore below). So a leaked image cannot be reversed
// into an account id by anyone who finds it, including us — only the sender who
// sent it can resolve who it went to.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const Native: any = (NativeModules as any)?.VaultViewMedia ?? null;

/** True when this build can embed/extract tracking ids. */
export function isTrackingAvailable(): boolean { return !!Native; }

export interface TrackingRecord {
  token: string;        // 12 hex chars (48-bit)
  attachmentId?: string;
  recipientId?: string;
  recipientName?: string;
  chatId?: string;
  sentAt: string;
}

const MAP_KEY = 'vc_tracking_map';

async function loadMap(): Promise<Record<string, TrackingRecord>> {
  try {
    const raw = await AsyncStorage.getItem(MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function saveMap(m: Record<string, TrackingRecord>): Promise<void> {
  try { await AsyncStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch {}
}

/** Fresh 48-bit token as 12 lowercase hex chars. */
export function newToken(): string {
  return Buffer.from(randomBytes(6)).toString('hex');
}

/** Remember who a token was issued to (sender-side only, never uploaded). */
export async function recordToken(rec: TrackingRecord): Promise<void> {
  const m = await loadMap();
  m[rec.token] = rec;
  await saveMap(m);
}

/** Resolve a token recovered from a leaked image back to the recipient. */
export async function lookupToken(token: string): Promise<TrackingRecord | null> {
  const m = await loadMap();
  return m[token.toLowerCase()] ?? null;
}

export async function listTokens(): Promise<TrackingRecord[]> {
  const m = await loadMap();
  return Object.values(m).sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
}

/**
 * Embed a tracking token into an image, writing the marked copy to dstUri.
 *
 * Returns false when the native module is missing or the image is too small to
 * carry a full payload (under ~128 blocks of 16px — roughly 180×180). Callers
 * must decide explicitly what to do on false; silently sending the unmarked
 * original while telling the user it is traceable would be a lie.
 */
export async function embedToken(
  srcUri: string, dstUri: string, token: string, quality = 92,
): Promise<boolean> {
  if (!Native?.embedTrackingId) return false;
  try {
    return !!(await Native.embedTrackingId(srcUri, dstUri, token, quality));
  } catch {
    return false;
  }
}

export interface ExtractResult {
  found: boolean;
  token?: string;
  /** 0–1. Low values mean the image was degraded but still CRC-verified. */
  confidence?: number;
  reason?: 'too_small' | 'crc_mismatch' | 'unavailable' | 'error';
}

/**
 * Recover a tracking token from a suspect image.
 *
 * `found: false` is returned for a rescaled/rotated image just as it is for an
 * unmarked one — this codec cannot tell those apart, and must not guess.
 */
export async function extractToken(srcUri: string): Promise<ExtractResult> {
  if (!Native?.extractTrackingId) return { found: false, reason: 'unavailable' };
  try {
    const r = await Native.extractTrackingId(srcUri);
    if (!r?.found) return { found: false, reason: r?.reason ?? 'error' };
    return { found: true, token: String(r.id), confidence: Number(r.confidence ?? 0) };
  } catch {
    return { found: false, reason: 'error' };
  }
}

/** Extract and resolve in one step, for the "who leaked this?" flow. */
export async function traceImage(srcUri: string): Promise<{
  result: ExtractResult;
  record: TrackingRecord | null;
}> {
  const result = await extractToken(srcUri);
  const record = result.found && result.token ? await lookupToken(result.token) : null;
  return { result, record };
}

export default {};
