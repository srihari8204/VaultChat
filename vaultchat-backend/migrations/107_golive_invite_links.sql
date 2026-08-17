-- 107_golive_invite_links.sql — shareable invitations for a Private Live, and
-- a description for every broadcast. Idempotent.
--
-- WHY A LINK AND NOT THE EXISTING INVITE
-- --------------------------------------
-- broadcast_invites (082) requires the host to name the invitees UP FRONT:
-- POST /broadcasts/{id}/invite takes userIds[]. That works when the host already
-- knows exactly who should watch, and it is useless for the actual use case —
-- "start a private live, then send the link to whoever I want, wherever I want".
-- The host would have to pick people from a list before they had decided who to
-- tell.
--
-- So the INVITATION ITSELF becomes the access mechanism. The host gets one
-- opaque code, shares it however they like, and anyone holding it can redeem it
-- for audience access to that one broadcast.
--
-- THE CODE IS STORED AS A HASH, NOT AS ITSELF
-- -------------------------------------------
-- code_hash is sha256(code). The plaintext code exists only in the response that
-- created it and in whatever the host pasted it into. A dump of this table
-- therefore grants nothing — the same reason a password column stores a hash.
--
-- sha256 rather than bcrypt deliberately: this is a 32-byte random secret, not a
-- human-chosen password, so there is nothing to brute-force and no need for a
-- slow KDF on a path that runs per redeem. The entropy is in the code.
--
-- REDEEMING WRITES AN ORDINARY INVITE ROW
-- ---------------------------------------
-- Redemption inserts into broadcast_invites, which every existing gate already
-- consults — the watch check, the token mint, chat, polls and the HLS ticket. So
-- link-based access needs no new authorization path anywhere, and cannot drift
-- from the one the manual invite uses.
--
-- It leaves seen_at NULL, which matters: seen_at is what promotes someone to
-- SPEAKER on the 20-seat stage. Holding a link makes you a VIEWER — one of
-- unlimited — never a publisher.

-- ── description ───────────────────────────────────────────────────────
-- Optional, shown under the title in the live listing and on the player.
-- Separate from title because a title is a headline and a description is not:
-- the listing renders one and the detail view renders both.
ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

-- ── invite links ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_invite_links (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  -- sha256(code), hex. UNIQUE so a redeem is a single indexed lookup by hash
  -- rather than a scan, and so two broadcasts can never share a code.
  code_hash    TEXT NOT NULL UNIQUE,
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A link that outlives its broadcast is a credential nobody is watching.
  -- Redemption ALSO checks the broadcast is still live, so this is the outer
  -- bound rather than the only one.
  expires_at   TIMESTAMPTZ,
  -- Revocation is a timestamp, not a DELETE: "this link was turned off, and
  -- when" is the question asked after an unexpected viewer appears.
  revoked_at   TIMESTAMPTZ
);

-- ONE ACTIVE LINK PER BROADCAST. Rotating issues a new code and revokes the old
-- one; without this a host who tapped twice would have two live codes and no way
-- to tell which they had already shared.
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_invite_links_active_idx
  ON broadcast_invite_links (broadcast_id)
  WHERE revoked_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────
-- ONLY THE HOST may read or write these rows. A link is a bearer credential:
-- being able to list it is being able to use it, so audience members — even
-- invited ones — must never see it.
--
-- Redemption deliberately does NOT go through these policies. It runs on the
-- system pool in routes/golive_invites.go, because the whole point is that the
-- redeemer is NOT yet authorized for this broadcast: a policy keyed on the
-- current user would hide the very row being redeemed.
ALTER TABLE broadcast_invite_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_invite_links FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_invite_links_select ON broadcast_invite_links;
DROP POLICY IF EXISTS broadcast_invite_links_insert ON broadcast_invite_links;
DROP POLICY IF EXISTS broadcast_invite_links_update ON broadcast_invite_links;

CREATE POLICY broadcast_invite_links_select ON broadcast_invite_links FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcast_sessions b
           WHERE b.id = broadcast_invite_links.broadcast_id
             AND b.host_id = vc_current_user_id())
);
CREATE POLICY broadcast_invite_links_insert ON broadcast_invite_links FOR INSERT WITH CHECK (
  created_by = vc_current_user_id()
  AND EXISTS (SELECT 1 FROM broadcast_sessions b
               WHERE b.id = broadcast_id AND b.host_id = vc_current_user_id())
);
-- Revoking is the only update.
CREATE POLICY broadcast_invite_links_update ON broadcast_invite_links FOR UPDATE USING (
  EXISTS (SELECT 1 FROM broadcast_sessions b
           WHERE b.id = broadcast_invite_links.broadcast_id
             AND b.host_id = vc_current_user_id())
);
