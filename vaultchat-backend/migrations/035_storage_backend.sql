-- 035_storage_backend.sql — track where an attachment's bytes live.
--
-- 'disk' (default, legacy): streamed from local UPLOAD_DIR by the Node process.
-- 's3'  : uploaded directly to / served via presigned URLs from object storage
--          (MinIO in dev, Cloudflare R2 in prod) — bytes never touch the app.
-- Idempotent.

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'disk';
