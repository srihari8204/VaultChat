-- 127_refresh_token_lookup.sql — give a refresh token an identity.
--
-- AUDIT F05/F06/F07 (2026-09-08). A refresh token could only be recognised by
-- bcrypt-comparing it against candidate rows, because bcrypt salts every hash
-- and is therefore not searchable. The code coped by selecting the newest 500
-- eligible rows ACROSS ALL USERS and comparing against each. Three defects fall
-- out of that one missing column:
--
--   F05  Past 500 live token rows, a perfectly valid older token stops being
--        found at all and the user is signed out. Rotation and multiple devices
--        make those rows accumulate quickly — it is a row limit, not a user
--        limit. An invalid token also burned up to 500 bcrypt comparisons,
--        which is a free CPU-exhaustion lever.
--   F06  "Sign out other devices" had no way to say WHICH row is the caller's,
--        so it hashed the presented token afresh and compared hashes with SQL
--        equality. Two bcrypt hashes of the same token never match — different
--        salts — so the current device matched nothing, was not excluded, and
--        signed itself out along with the others.
--   F07  Rotation reuses `revoked_at` for a 30-second grace window so a retried
--        request does not lose the race. A device revoked from the sessions
--        screen sets the same column, so it was granted the same grace and
--        could mint fresh credentials for 30 seconds after being kicked off.
--
-- token_lookup is a KEYED digest — HMAC-SHA256(VAULTCHAT_LOOKUP_PEPPER,
-- "refresh:"||token), hex; see vault.LookupHash / authRefreshLookup in
-- internal/routes/auth.go. Deterministic, so one indexed equality selects the
-- single candidate;
-- keyed, so a stolen database alone cannot be scanned against a dictionary of
-- guessed tokens the way a bare SHA-256 could. bcrypt in token_hash remains the
-- verifier, so this column widens nothing: it finds the row, it does not
-- authorise it.
--
-- NULLABLE, and no backfill is possible: the plaintext tokens are not stored,
-- which is the point of the table. Rows written before this migration keep
-- token_lookup NULL and are still found by the legacy candidate scan, so no
-- signed-in user is logged out by deploying this. Once every pre-migration
-- token has expired (JWT_REFRESH_TTL, 30 days by default) the fallback can go.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_lookup TEXT;

-- Partial + unique: two live tokens must never share a lookup value (that would
-- mean an HMAC collision or a duplicate token), while the NULL legacy rows are
-- exempt because NULLs do not collide in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_lookup
  ON refresh_tokens (token_lookup)
  WHERE token_lookup IS NOT NULL;

-- Why a row stopped being valid. 'rotated' is the ordinary refresh handoff and
-- is the ONLY reason that earns the grace window; anything else — an explicit
-- device revocation, a sign-out, an account deletion — is final immediately.
-- NULL means "still valid", matching revoked_at IS NULL.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

COMMENT ON COLUMN refresh_tokens.token_lookup IS
  'HMAC-SHA256(VAULTCHAT_LOOKUP_PEPPER, ''refresh:''||token) hex. Finds the row; token_hash still authorises it. NULL on rows predating migration 127.';
COMMENT ON COLUMN refresh_tokens.revoked_reason IS
  'Why revoked_at is set. Only ''rotated'' gets the refresh grace window; explicit revocation is immediate.';
