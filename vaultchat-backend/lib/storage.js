// lib/storage.js — object storage (S3-compatible: MinIO in dev, Cloudflare R2 in
// prod). Presigned URLs let clients upload/download bytes DIRECTLY to/from the
// object store, so media never streams through the Node app.
//
// Gated on S3_ENDPOINT + S3_ACCESS_KEY: when unset, enabled() is false and the
// upload route falls back to local-disk storage (unchanged legacy behaviour).
//
// Env:
//   S3_ENDPOINT         internal endpoint the server uses for bucket ops
//   S3_PUBLIC_ENDPOINT  endpoint encoded into presigned URLs (what CLIENTS hit);
//                       defaults to S3_ENDPOINT. For R2 this is the public R2 URL;
//                       for MinIO behind Docker set it to the host-reachable URL.
//   S3_BUCKET (default vaultchat-media), S3_REGION (default auto),
//   S3_ACCESS_KEY, S3_SECRET_KEY

const {
  S3Client, PutObjectCommand, GetObjectCommand,
  HeadBucketCommand, CreateBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET || 'vaultchat-media';
const REGION = process.env.S3_REGION || 'auto';
const SIGN_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || '';

let s3 = null;

function enabled() {
  return !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY);
}

function client() {
  if (!enabled()) return null;
  if (!s3) {
    s3 = new S3Client({
      endpoint: SIGN_ENDPOINT,
      region: REGION,
      forcePathStyle: true, // MinIO + most S3-compatible stores need path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      },
    });
  }
  return s3;
}

// Idempotently ensure the bucket exists (dev/MinIO convenience; R2 buckets are
// created out-of-band but HeadBucket is harmless).
async function ensureBucket() {
  const c = client();
  if (!c) return;
  try {
    await c.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    try { await c.send(new CreateBucketCommand({ Bucket: BUCKET })); }
    catch (e) { console.warn('[storage] ensureBucket:', e.message); }
  }
}

// Presigned PUT — the client uploads the bytes directly to the object store.
async function presignPut(key, contentType, expiresIn = 900) {
  const c = client();
  if (!c) return null;
  return getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || 'application/octet-stream' }),
    { expiresIn },
  );
}

// Presigned GET — short-lived download URL handed out AFTER the access check.
async function presignGet(key, expiresIn = 3600) {
  const c = client();
  if (!c) return null;
  return getSignedUrl(c, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

module.exports = { enabled, client, ensureBucket, presignPut, presignGet, BUCKET };
