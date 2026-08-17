-- 108_golive_passcode.sql — a Zoom-style passcode on a Private Live, and the
-- display name the joiner is announced under. Idempotent.
--
-- WHY A PASSCODE WHEN THE LINK IS ALREADY 32 RANDOM BYTES
-- ------------------------------------------------------
-- The invite code (107) is unguessable, so it is not brute force this defends
-- against. It is FORWARDING. A link is one string in a group chat, and once it
-- leaves the intended recipient it carries its own authority — anyone holding it
-- is admitted with no further check, and the host cannot tell that it spread.
--
-- Splitting admission across two channels is the whole point of Zoom's meeting
-- ID + passcode: the host sends the link one way and the passcode another, so a
-- forwarded link alone is inert. Revoking is also finer-grained — rotating the
-- passcode locks out everyone who has not yet joined without invalidating a link
-- that has already been shared widely.
--
-- WHY IT LIVES ON THE SESSION, NOT THE LINK
-- -----------------------------------------
-- One passcode per broadcast, not per link: the host reads it aloud or types it
-- into a message, and it has to stay the same for every recipient. Putting it on
-- broadcast_invite_links would mint a new one on every rotation (the 107 rotate
-- revokes and re-inserts), silently invalidating a passcode the host had already
-- given out.
--
-- STORED HASHED, NEVER PLAINTEXT
-- -----------------------------
-- bcrypt, like every other secret in this schema (otp.js, auth.go). A passcode
-- is short and human-chosen, so a fast hash would be trivially reversible from a
-- table dump; bcrypt's work factor is what makes a 6-digit code cost something
-- to attack. The redeem endpoint is ALSO rate-limited per user (30/hour,
-- golive_invites.go) because a slow hash alone does not stop online guessing.
--
-- NULL means no passcode — every public live, and any private live whose host
-- did not set one. NULL is therefore "open to link holders", which is exactly
-- the 107 behaviour, so existing rows keep working unchanged.

ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS passcode_hash TEXT;

-- The name the joiner is shown as, captured at redeem time.
--
-- WHY NOT JUST USE THE PROFILE NAME
-- ---------------------------------
-- A broadcast is not a chat. Its audience can include people the host has never
-- messaged, and the joiner is entitled to decide what a room full of strangers
-- sees — the same reason Zoom asks. It is prefilled from the profile, so the
-- default costs the joiner nothing.
--
-- NULL means "fall back to the profile name", so every invite written before
-- this migration still resolves to something displayable.
ALTER TABLE broadcast_invites
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Length is capped in the handler; this is the backstop that holds even if a
-- future caller forgets. 64 matches the profile-name limit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'broadcast_invites_display_name_len'
  ) THEN
    ALTER TABLE broadcast_invites
      ADD CONSTRAINT broadcast_invites_display_name_len
      CHECK (display_name IS NULL OR char_length(display_name) <= 64);
  END IF;
END $$;
