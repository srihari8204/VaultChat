-- VaultChat: per-viewer story encryption keys (W7). Idempotent.
--
-- Closes the "Phase-3b" gap noted in 020_stories.sql, now that real E2EE has
-- landed. An encrypted story's media is uploaded as opaque AES-256-GCM
-- ciphertext (server stores bytes it cannot read). The single content key is
-- wrapped SEPARATELY for each authorized viewer using the author↔viewer E2EE
-- session, and the per-viewer wrapped keys are stored here. The server only ever
-- holds opaque ciphertext + opaque wrapped keys — it can never read a story.
--
-- A viewer fetches ONLY their own wrapped key (GET /stories/:id/key), unwraps it
-- with their device key, and decrypts the media locally. Viewers who weren't in
-- the audience at post time have no wrapped key and cannot decrypt — the correct
-- outcome for an ephemeral, audience-scoped post.

-- Mark which stories are E2E-encrypted (legacy/plaintext stories stay false).
ALTER TABLE stories ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT FALSE;

-- One opaque wrapped content-key per (story, viewer).
CREATE TABLE IF NOT EXISTS story_keys (
  story_id     BIGINT      NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  wrapped_key  TEXT        NOT NULL,   -- E2EE envelope carrying the media key (opaque)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_story_keys_viewer
  ON story_keys(viewer_id);
