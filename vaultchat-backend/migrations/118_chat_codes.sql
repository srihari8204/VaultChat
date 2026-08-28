-- 118_chat_codes.sql — start a chat with someone whose number you do not have.
-- Idempotent.
--
-- WHY THIS EXISTS
-- ---------------
-- Every existing way to open a direct chat (POST /chats type=direct) needs a
-- userId, an email or a phone number — all of which mean you ALREADY know the
-- person. There was no way to say "here, chat with me" to someone standing in
-- front of you without handing over your number first.
--
-- A six-digit code is that missing handle: short enough to read across a table
-- or over a phone, and dead two minutes later.
--
-- SIX DIGITS IS A DELIBERATE TRADE, AND IT IS THE SHORT LIFE THAT PAYS FOR IT
-- --------------------------------------------------------------------------
-- A million combinations is not a lot. What makes that survivable is that a
-- guess is only ever tested against the codes that are LIVE AT THAT INSTANT,
-- and a code lives for two minutes — so the pool a guesser is shooting at is
-- whatever was minted in the last two minutes, not every code ever issued.
--
-- Three things hold that property up, and none of them are optional:
--
--   1. chat_codes_live_code_idx — no two LIVE codes may share six digits, so
--      one guess can hit at most one person.
--   2. The expiry sweep in routes/chat_codes.go, which revokes timed-out rows
--      BEFORE minting. Without it, expired rows still count as live to the two
--      partial indexes below, the digit space fills up, and minting starts
--      failing. chat_codes_expiry_idx is what makes that sweep cheap.
--   3. The rate limits on redeeming (per user, per day, per IP). With this
--      little entropy they are load-bearing, not belt-and-braces.
--
-- If chatCodeLife is ever raised, the live pool grows in proportion and all
-- three need revisiting together.
--
-- THE CODE IS STORED IN PLAINTEXT, ON PURPOSE
-- -------------------------------------------
-- broadcast_invite_links (107) hashes its codes, and that is right there: those
-- are 32 random bytes, so the hash is a real one-way step. Six digits is not.
-- A million sha256 calls is under a second, so hashing here would be theatre —
-- it would look like protection while providing none, which is worse than being
-- plain about it.
--
-- What actually limits a dump of this table is that every row in it is either
-- spent, revoked, or expiring within two minutes. And because the code is here
-- to read back, someone who taps away from the screen can return to their live
-- code instead of being told to make another one.
--
-- WHAT REDEEMING GRANTS
-- ---------------------
-- An ordinary direct chat and nothing else — same rows, same block check, same
-- E2E key exchange, via the same directChatEnsure that POST /chats uses. A code
-- decides WHO may open a chat; it is never a key to anything inside one.

CREATE TABLE IF NOT EXISTS chat_codes (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Exactly six digits, leading zeros included — hence TEXT, not an integer.
  -- '004271' and '4271' are different codes to a person reading them out, and
  -- an integer column would quietly turn the first into the second.
  code         TEXT NOT NULL,
  -- Disappearing timer to stamp on the chat this code opens. NULL means the
  -- messages stay until somebody deletes them ("Until I delete" and "Save this
  -- contact" both land here). This is the CHAT's clock; expires_at below is the
  -- CODE's, and they are deliberately unrelated.
  ttl_seconds  INTEGER,
  -- "Save this contact": treat whoever redeems as an ordinary contact instead
  -- of a stranger. The only thing it changes is that routes/chat_codes.go skips
  -- the automatic Ghost Mode defaults, so online, typing, read receipts and
  -- last-seen behave the way they do with anyone else you talk to.
  keep_contact BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Two minutes. Read the code out, they type it in, it is gone. See the header
  -- above for why this number is the security story and not an ergonomic knob.
  expires_at   TIMESTAMPTZ NOT NULL,
  -- Revocation is a timestamp, not a DELETE: "I stopped it, and when" is the
  -- question asked after an unexpected chat appears. The expiry sweep also
  -- writes here, so this doubles as "no longer live, for either reason".
  revoked_at   TIMESTAMPTZ,
  -- Single use. Set together, and only ever from NULL — routes/chat_codes.go
  -- relies on that UPDATE affecting exactly one row to settle a race between
  -- two people redeeming the same code at once.
  used_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  used_at      TIMESTAMPTZ,
  CONSTRAINT chat_codes_code_ck    CHECK (code ~ '^[0-9]{6}$'),
  CONSTRAINT chat_codes_ttl_ck     CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  CONSTRAINT chat_codes_used_ck    CHECK ((used_by IS NULL) = (used_at IS NULL))
);

-- ONE LIVE CODE PER PERSON. Generating again revokes the previous one in the
-- same transaction; without this index a double tap would leave two live codes
-- and no way to tell which one had already been read out.
CREATE UNIQUE INDEX IF NOT EXISTS chat_codes_active_idx
  ON chat_codes (owner_id)
  WHERE revoked_at IS NULL AND used_at IS NULL;

-- NO TWO LIVE CODES SHARE SIX DIGITS. This is what stops one guess from being
-- tested against every live code at once — the difference between an attacker
-- needing a million guesses and needing a million divided by however many codes
-- happen to be live. Minting retries on the unique violation this raises.
CREATE UNIQUE INDEX IF NOT EXISTS chat_codes_live_code_idx
  ON chat_codes (code)
  WHERE revoked_at IS NULL AND used_at IS NULL;

-- The sweep's index. "Live" above means un-revoked and unused, which an expired
-- row still is until something says otherwise — so the sweep is what keeps the
-- two indexes above honest, and this is what keeps the sweep cheap.
CREATE INDEX IF NOT EXISTS chat_codes_expiry_idx
  ON chat_codes (expires_at)
  WHERE revoked_at IS NULL AND used_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
-- ONLY THE OWNER. The code is readable in this table, so being able to SELECT
-- someone else's row would be the whole attack.
--
-- Redemption and the expiry sweep deliberately do NOT go through these policies:
-- they run on the system pool in routes/chat_codes.go. The redeemer is by
-- definition not the owner, so a policy keyed on the current user would hide the
-- very row being redeemed; and the sweep must reach every user's expired rows,
-- not just its own caller's, or the digit space never frees up.
ALTER TABLE chat_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_codes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_codes_select ON chat_codes;
DROP POLICY IF EXISTS chat_codes_insert ON chat_codes;
DROP POLICY IF EXISTS chat_codes_update ON chat_codes;

CREATE POLICY chat_codes_select ON chat_codes FOR SELECT USING (owner_id = vc_current_user_id());
CREATE POLICY chat_codes_insert ON chat_codes FOR INSERT WITH CHECK (owner_id = vc_current_user_id());
-- Revoking is the only owner-side update.
CREATE POLICY chat_codes_update ON chat_codes FOR UPDATE USING (owner_id = vc_current_user_id());
