-- VaultChat Day 17: phone OTP support.
-- Adds phone_hash column to otp_codes so the same table covers both
-- channels. Email becomes nullable; rows must have exactly one of
-- (email, phone_hash) set. Idempotent.

ALTER TABLE otp_codes
  ADD COLUMN IF NOT EXISTS phone_hash TEXT;

ALTER TABLE otp_codes
  ALTER COLUMN email DROP NOT NULL;

-- Exactly one channel per row. CHECK constraint added if missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_one_channel'
  ) THEN
    ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_one_channel
      CHECK ( (email IS NOT NULL AND phone_hash IS NULL)
           OR (email IS NULL AND phone_hash IS NOT NULL) );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_otp_phone_unconsumed
  ON otp_codes(phone_hash, expires_at)
  WHERE consumed_at IS NULL AND phone_hash IS NOT NULL;
