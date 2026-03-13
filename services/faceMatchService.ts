/**
 * services/faceMatchService.ts
 *
 * Your own face recognition algorithm.
 * No AWS. No Azure. No TensorFlow. No cloud.
 *
 * HOW IT WORKS:
 *   expo-face-detector gives us named landmark points from Google MLKit.
 *   We measure 28 distances between landmark pairs.
 *   We normalize every distance by the inter-ocular (eye-to-eye) distance
 *   so head size / distance from camera does NOT affect the result.
 *   That normalized 28-number array = your face fingerprint.
 *
 *   On verification: capture fresh fingerprint, compare with stored one.
 *   If the RMS difference < MATCH_THRESHOLD → same person → unlock.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface FaceLandmarks {
  LEFT_EYE:     Point;
  RIGHT_EYE:    Point;
  NOSE_BASE:    Point;
  LEFT_EAR:     Point;
  RIGHT_EAR:    Point;
  LEFT_CHEEK:   Point;
  RIGHT_CHEEK:  Point;
  MOUTH_LEFT:   Point;
  MOUTH_RIGHT:  Point;
  MOUTH_BOTTOM: Point;
}

export type FaceVector = number[];   // 28-dimensional normalized distance vector

export interface StoredFaceData {
  vector:       FaceVector;
  registeredAt: number;
  frameCount:   number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'vaultchat_face_vector_v2';

/**
 * Match threshold.
 * 0.13 = faces must be within 13% geometric similarity.
 * Lower = stricter. Raise to 0.18 if you get false rejects.
 */
export const MATCH_THRESHOLD = 0.13;

/**
 * 28 landmark pairs we measure distances between.
 * Each pair captures one unique facial geometry ratio.
 */
const PAIRS: [keyof FaceLandmarks, keyof FaceLandmarks][] = [
  ['LEFT_EYE',    'RIGHT_EYE'],
  ['LEFT_EYE',    'NOSE_BASE'],
  ['RIGHT_EYE',   'NOSE_BASE'],
  ['LEFT_EYE',    'MOUTH_LEFT'],
  ['RIGHT_EYE',   'MOUTH_RIGHT'],
  ['LEFT_EYE',    'MOUTH_BOTTOM'],
  ['RIGHT_EYE',   'MOUTH_BOTTOM'],
  ['LEFT_EAR',    'RIGHT_EAR'],
  ['LEFT_EAR',    'LEFT_EYE'],
  ['RIGHT_EAR',   'RIGHT_EYE'],
  ['LEFT_EAR',    'NOSE_BASE'],
  ['RIGHT_EAR',   'NOSE_BASE'],
  ['LEFT_EAR',    'MOUTH_LEFT'],
  ['RIGHT_EAR',   'MOUTH_RIGHT'],
  ['LEFT_CHEEK',  'RIGHT_CHEEK'],
  ['LEFT_CHEEK',  'LEFT_EYE'],
  ['RIGHT_CHEEK', 'RIGHT_EYE'],
  ['LEFT_CHEEK',  'NOSE_BASE'],
  ['RIGHT_CHEEK', 'NOSE_BASE'],
  ['LEFT_CHEEK',  'MOUTH_LEFT'],
  ['RIGHT_CHEEK', 'MOUTH_RIGHT'],
  ['MOUTH_LEFT',  'MOUTH_RIGHT'],
  ['MOUTH_LEFT',  'NOSE_BASE'],
  ['MOUTH_RIGHT', 'NOSE_BASE'],
  ['MOUTH_BOTTOM','NOSE_BASE'],
  ['MOUTH_BOTTOM','LEFT_EYE'],
  ['MOUTH_BOTTOM','RIGHT_EYE'],
  ['LEFT_EAR',    'RIGHT_CHEEK'],
];

// ─── Core math ────────────────────────────────────────────────────────────────

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Convert facial landmarks → normalized distance vector.
 * Returns null if face is too small or data is invalid.
 */
export function landmarksToVector(lm: FaceLandmarks): FaceVector | null {
  try {
    const base = dist(lm.LEFT_EYE, lm.RIGHT_EYE);
    if (base < 5) return null;  // face too small / too far
    return PAIRS.map(([a, b]) => dist(lm[a], lm[b]) / base);
  } catch {
    return null;
  }
}

/**
 * Average multiple vectors into one stable template.
 * More frames = more accurate and stable fingerprint.
 */
export function averageVectors(vecs: FaceVector[]): FaceVector {
  if (!vecs.length) return [];
  const len = vecs[0].length;
  const out  = new Array(len).fill(0);
  for (const v of vecs) for (let i = 0; i < len; i++) out[i] += v[i];
  return out.map(x => x / vecs.length);
}

/**
 * Compare two face vectors.
 * Returns 0.0 for identical faces, higher for different faces.
 */
export function compareFaceVectors(a: FaceVector, b: FaceVector): number {
  if (a.length !== b.length || !a.length) return 999;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

export function isSameFace(a: FaceVector, b: FaceVector): boolean {
  return compareFaceVectors(a, b) < MATCH_THRESHOLD;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export async function saveFaceVector(vector: FaceVector, frameCount: number): Promise<void> {
  const data: StoredFaceData = { vector, registeredAt: Date.now(), frameCount };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export async function loadFaceVector(): Promise<StoredFaceData | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteFaceVector(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function isFaceRegistered(): Promise<boolean> {
  return (await AsyncStorage.getItem(STORAGE_KEY)) !== null;
}
