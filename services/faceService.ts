import * as Crypto from "expo-crypto";

// Cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Transform face vector using PIN as key (cancelable biometrics)
export async function transformFaceVector(
  vector: number[],
  pin: string
): Promise<string> {
  const pinHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    pin.trim()
  );
  // XOR-based transform using PIN hash as seed
  const transformed = vector.map((v, i) => {
    const seed = parseInt(pinHash.slice((i * 2) % 60, (i * 2) % 60 + 2), 16) / 255;
    return v * seed + (1 - seed) * 0.5;
  });
  return JSON.stringify(transformed);
}

// Compare two transformed vectors
export function compareFaceVectors(
  vectorA: number[],
  vectorB: number[]
): number {
  return cosineSimilarity(vectorA, vectorB);
}

// Check if match score passes threshold
export function isFaceMatch(score: number): boolean {
  return score >= 0.82; // 82% similarity threshold
}

// Encrypt face template for server storage
export async function encryptFaceTemplate(
  template: string,
  uid: string,
  pin: string
): Promise<string> {
  const key = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    uid + pin + "vaultchat_face_salt_v1"
  );
  // Simple XOR encryption with key (production: use AES-256-GCM via react-native-quick-crypto)
  const bytes = template.split("").map((c, i) =>
    c.charCodeAt(0) ^ parseInt(key.slice(i % 60, i % 60 + 2), 16)
  );
  return btoa(String.fromCharCode(...bytes));
}

// Decrypt face template from server
export async function decryptFaceTemplate(
  encrypted: string,
  uid: string,
  pin: string
): Promise<string> {
  const key = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    uid + pin + "vaultchat_face_salt_v1"
  );
  const bytes = atob(encrypted).split("").map((c, i) =>
    c.charCodeAt(0) ^ parseInt(key.slice(i % 60, i % 60 + 2), 16)
  );
  return String.fromCharCode(...bytes);
}

// Mock face vector generator (replace with real TF FaceMesh in production)
// In production: use react-native-vision-camera + @tensorflow-models/face-landmarks-detection
export function generateMockFaceVector(): number[] {
  // Returns 128-dimensional normalized vector
  const vec = Array.from({ length: 128 }, () => Math.random());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}
