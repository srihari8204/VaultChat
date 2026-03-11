// constants/faceAuth.ts — Face enrollment and verification
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface EnrolledFace {
  id: string;
  name: string;
  emoji: string;
  relation: string;
  photoBase64: string; // stored enrollment photo
  enrolledAt: number;
}

const STORAGE_KEY = 'vaultchat_enrolled_faces';

// Save enrolled faces
export const saveEnrolledFaces = async (faces: EnrolledFace[]) => {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(faces));
};

// Load enrolled faces
export const loadEnrolledFaces = async (): Promise<EnrolledFace[]> => {
  const data = await AsyncStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : [];
};

// Add a new face
export const enrollFace = async (face: EnrolledFace) => {
  const existing = await loadEnrolledFaces();
  const updated = [...existing.filter(f => f.id !== face.id), face];
  await saveEnrolledFaces(updated);
  return updated;
};

// Remove a face
export const removeFace = async (id: string) => {
  const existing = await loadEnrolledFaces();
  const updated = existing.filter(f => f.id !== id);
  await saveEnrolledFaces(updated);
  return updated;
};

// Simple pixel-based image comparison
// Returns similarity score 0-100
export const compareImages = (base64A: string, base64B: string): number => {
  if (!base64A || !base64B) return 0;
  // Compare image sizes as quick check
  const lenDiff = Math.abs(base64A.length - base64B.length);
  const avgLen = (base64A.length + base64B.length) / 2;
  const sizeSimScore = Math.max(0, 100 - (lenDiff / avgLen) * 200);

  // Sample characters at intervals for comparison
  const sampleSize = 500;
  const stepA = Math.floor(base64A.length / sampleSize);
  const stepB = Math.floor(base64B.length / sampleSize);
  let matches = 0;
  for (let i = 0; i < sampleSize; i++) {
    const charA = base64A[i * stepA] || '';
    const charB = base64B[i * stepB] || '';
    if (charA === charB) matches++;
  }
  const sampleScore = (matches / sampleSize) * 100;

  return (sizeSimScore * 0.4 + sampleScore * 0.6);
};

// Threshold for match — 72% similarity required
export const MATCH_THRESHOLD = 72;
