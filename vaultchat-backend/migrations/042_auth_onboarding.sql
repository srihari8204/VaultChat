-- VaultChat: auth/onboarding re-architecture (encrypted PII at rest). Idempotent.
--
-- Moves identity PII to AES-256-GCM ciphertext (lib/vault.encrypt) with
-- deterministic HMAC lookup columns (lib/vault.emailLookup/phoneLookup), and
-- verification secrets (MPIN, security answers) to Argon2id hashes.
--
-- ADDITIVE + SAFE to deploy on its own: it only ADDs columns/tables and relaxes
-- NOT NULL. The plaintext columns (email/phone/dob/status/name, the inline
-- security_q*/a*_hash, bcrypt pin_hash) are intentionally KEPT here so the
-- currently-deployed code keeps working; they are dropped in a LATER migration
-- only after every consumer is rewritten to the cipher/lookup model (Stage 4).
-- Prod data was wiped at the Docker cutover, so there are no plaintext rows to
-- back-fill.

-- ── users: encrypted PII + lookup + new auth fields ──────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_lookup        CHAR(64);  -- HMAC-SHA256 hex
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_lookup        CHAR(64);  -- HMAC-SHA256 hex
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_cipher        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_cipher        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name_cipher   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name_cipher    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dob_cipher          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_cipher       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mpin_hash           TEXT;      -- argon2id ($argon2id$...)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;
-- profile_pic_url: the existing photo_url column is reused (R2/MinIO signed URL).

-- New encrypted-only users have no plaintext email; relax the legacy NOT NULL.
-- (The legacy UNIQUE on email still permits multiple NULLs.)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Uniqueness now lives on the lookup hashes. Partial so legacy/in-progress rows
-- without a hash don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lookup ON users(email_lookup) WHERE email_lookup IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_lookup ON users(phone_lookup) WHERE phone_lookup IS NOT NULL;

-- ── security questions (5-of-12, answers argon2id-hashed) ────────────────────
CREATE TABLE IF NOT EXISTS user_security_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_code TEXT NOT NULL,
  answer_hash   TEXT NOT NULL,                      -- argon2id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, question_code)
);
CREATE INDEX IF NOT EXISTS idx_user_security_questions_user ON user_security_questions(user_id);

-- ── auth attempt audit (lookup + mpin) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  ip_address   INET,
  attempt_type TEXT NOT NULL,                       -- 'mpin' | 'lookup'
  success      BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_user_time ON auth_attempts(user_id, created_at DESC);
