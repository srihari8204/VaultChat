-- Contact safety-number verification state (#101). Idempotent.
--
-- Records that a user has verified another contact's safety number out-of-band
-- (read aloud / QR compare). No key material lives here — only the verified
-- relationship, so the green "Verified" badge can sync across the user's devices.

CREATE TABLE IF NOT EXISTS contact_verifications (
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_id)
);
