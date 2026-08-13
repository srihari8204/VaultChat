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
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand,
  HeadBucketCommand, CreateBucketCommand,
  CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET || 'vaultchat-media';
const REGION = process.env.S3_REGION || 'auto';
// SIGN_ENDPOINT is baked into presigned URLs (what CLIENTS hit) → must be the
// public, device-reachable endpoint. SERVER_ENDPOINT is what the SERVER uses for
// its own network ops (bucket head/create, direct I/O) → must be the INTERNAL
// endpoint (e.g. minio:9000 inside Docker). Using the public endpoint for server
// ops makes the container dial the host's public IP and time out.
const SIGN_ENDPOINT   = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || '';
const SERVER_ENDPOINT = process.env.S3_ENDPOINT || SIGN_ENDPOINT;

let s3Server = null;
let s3Sign   = null;

function enabled() {
  return !!(process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY);
}

function mkClient(endpoint) {
  return new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true, // MinIO + most S3-compatible stores need path-style
    // AWS SDK ≥3.729 defaults to signing x-amz-checksum-crc32 into presigned
    // PUTs — a plain PUT (device → R2) without that exact header then 403s
    // (SignatureDoesNotMatch). WHEN_REQUIRED restores the legacy behaviour.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
}

// Server-side client (bucket ops + direct I/O) over the INTERNAL endpoint.
function client() {
  if (!enabled()) return null;
  if (!s3Server) s3Server = mkClient(SERVER_ENDPOINT);
  return s3Server;
}

// Signing client — its endpoint is encoded into the presigned URL, so it uses
// the PUBLIC endpoint. Signing does no network I/O, so reachability is moot here.
function signClient() {
  if (!enabled()) return null;
  if (!s3Sign) s3Sign = mkClient(SIGN_ENDPOINT);
  return s3Sign;
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
  const c = signClient();
  if (!c) return null;
  return getSignedUrl(
    c,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || 'application/octet-stream' }),
    { expiresIn },
  );
}

// Presigned GET — short-lived download URL handed out AFTER the access check.
async function presignGet(key, expiresIn = 3600) {
  const c = signClient();
  if (!c) return null;
  return getSignedUrl(c, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

// Server-side download → Buffer. Used to stream-decrypt encrypted avatars
// (the server must touch those bytes; everything else is served presigned-direct).
async function getObject(key) {
  const c = client();
  if (!c) return null;
  const out = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Server-side download → STREAM (never buffers the object). Used by GET
// /uploads/:id to relay media through the API: R2/S3 rejects a request that
// carries BOTH a presigned query signature and an Authorization header, and RN's
// fetch/downloadAsync/Image forward our Bearer header across a 302 redirect —
// so redirecting clients to a presigned URL 400s (worked on MinIO, which
// tolerated the double auth). Returns { body, contentLength, contentType } or null.
async function getObjectStream(key) {
  const c = client();
  if (!c) return null;
  try {
    const out = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return { body: out.Body, contentLength: out.ContentLength ?? null, contentType: out.ContentType ?? null };
  } catch { return null; }
}

// Server-side upload of a Buffer → object store, for bytes the server itself
// produces rather than proxies from a client (so the URLs are ours and expire
// on the bucket lifecycle).
async function putObject(key, buffer, contentType = 'application/octet-stream') {
  const c = client();
  if (!c) return false;
  await c.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return true;
}

// ── Resumable multipart upload (S3 multipart API; R2-compatible) ──────────
// Big media uploads a part at a time; an interrupted upload resumes by asking
// listParts() which parts already landed and skipping them. R2 keeps the parts
// server-side under the uploadId until complete/abort, so resume state lives in
// the store — the client only needs {key, uploadId}. Used by routes/uploads.js.

// Begin a multipart upload → returns the uploadId (or null if storage is off).
async function createMultipart(key, contentType) {
  const c = client();
  if (!c) return null;
  const out = await c.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET, Key: key, ContentType: contentType || 'application/octet-stream',
  }));
  return out.UploadId || null;
}

// Presign a single UploadPart PUT — the client uploads that part's bytes direct.
async function presignUploadPart(key, uploadId, partNumber, expiresIn = 900) {
  const c = signClient();
  if (!c) return null;
  return getSignedUrl(
    c,
    new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn },
  );
}

// Which parts are already uploaded — the resume oracle. [{PartNumber, ETag, Size}].
async function listParts(key, uploadId) {
  const c = client();
  if (!c) return [];
  const parts = [];
  let marker;
  do {
    const out = await c.send(new ListPartsCommand({
      Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker,
    }));
    for (const p of out.Parts || []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
    marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

// Assemble the uploaded parts into the final object. `parts` = [{PartNumber, ETag}]
// ascending. Returns true on success.
async function completeMultipart(key, uploadId, parts) {
  const c = client();
  if (!c) return false;
  await c.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
  }));
  return true;
}

// Discard an in-progress multipart upload (its parts are freed).
async function abortMultipart(key, uploadId) {
  const c = client();
  if (!c) return;
  try { await c.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId })); }
  catch (e) { console.warn('[storage] abortMultipart:', e.message); }
}

// Delete an object (used to purge media after it's been delivered to everyone).
async function deleteObject(key) {
  const c = client();
  if (!c) return;
  try { await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); }
  catch (e) { console.warn('[storage] deleteObject:', e.message); }
}

// Does an object exist? (server-side confirm that a sender actually uploaded a
// VaultBeam relay block before we let the recipient fetch it.)
async function objectExists(key) {
  const c = client();
  if (!c) return false;
  try { await c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

// Delete every object under a prefix, in batches of 1000 (S3 DeleteObjects cap).
// Used to purge a whole VaultBeam relay transfer (`vault_relay/<id>/…`) the moment
// the recipient confirms full download, or on abort — the 24h lifecycle rule is
// the backstop, this is the queue-only-retention active purge.
async function deletePrefix(prefix) {
  const c = client();
  if (!c) return;
  let token;
  try {
    do {
      const list = await c.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
      }));
      const objs = (list.Contents || []).map(o => ({ Key: o.Key }));
      if (objs.length) {
        await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs, Quiet: true } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  } catch (e) { console.warn('[storage] deletePrefix:', e.message); }
}

module.exports = {
  enabled, client, ensureBucket, presignPut, presignGet, getObject, getObjectStream,
  putObject, deleteObject, objectExists, deletePrefix, BUCKET,
  createMultipart, presignUploadPart, listParts, completeMultipart, abortMultipart,
};
