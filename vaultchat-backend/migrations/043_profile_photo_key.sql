-- VaultChat: encrypted profile photos. Idempotent.
--
-- The avatar bytes are AES-256-GCM encrypted CLIENT-side with a random per-photo
-- data key before upload, so the object store only ever holds ciphertext. That
-- data key is wrapped with the server master key (lib/vault.encrypt) and stored
-- here; on serve, the server unwraps it and stream-decrypts the image (avatars
-- must be viewable by chat peers, so the key is server-recoverable by design).
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_key_cipher TEXT;
