-- 109_family_relations.sql — who each member IS to you, inside one space.
--
-- "Mother", "Father", "Brother". The Family screens showed a display name and
-- nothing else, so a roster of ten people said nothing about the family it
-- described.
--
-- WHY THE VIEWER IS PART OF THE KEY, and it is the whole design: a relationship
-- is not a property of a person, it is a property of a PAIR. The same woman is
-- "Mother" to one member, "Wife" to another and "Daughter" to a third, all in
-- the same space and all correct simultaneously. Storing one label on the
-- member — the obvious shape — would force those three to disagree, and
-- whoever wrote last would win. So the row is (chat, viewer, member) and each
-- viewer sees their own truth.
--
-- This lives server-side rather than on the device (owner directive: maximum
-- logic in the backend, keep the app light) so the roster arrives ready to
-- render: the app prints member.relation and computes nothing. It also means a
-- family that labels its circle once keeps those labels across reinstalls and
-- new devices, which a device-local map never could.
--
-- NOT sensitive the way a coordinate is: this is a label a viewer chose for a
-- person they already share a space with. It carries no location, and the read
-- is gated by membership of that space exactly like every other roster read.

-- UUID, not BIGINT: chats.id, users.id and chat_members.{chat_id,user_id} are
-- all uuid in this schema. Declaring these BIGINT fails at CREATE TABLE with
-- "foreign key constraint cannot be implemented … bigint and uuid" — caught by
-- dry-running this file inside a rolled-back transaction on the local bench
-- before it went anywhere near prod.
CREATE TABLE IF NOT EXISTS family_relations (
  chat_id    UUID        NOT NULL REFERENCES chats(id)  ON DELETE CASCADE,
  -- The person DOING the labelling. Deleting them removes only their labels.
  viewer_id  UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  -- The person BEING labelled.
  member_id  UUID        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  -- Free text, not an enum. Families do not fit a fixed list — "Chinnanna",
  -- "Bava", "Step-mum" are all real answers, and a CHECK constraint here would
  -- be a product decision hiding in the schema. Length-capped instead; the app
  -- offers presets and accepts anything.
  relation   TEXT        NOT NULL CHECK (length(relation) BETWEEN 1 AND 40),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, viewer_id, member_id)
);

-- The only read shape that exists: "every label I hold in this space", joined
-- onto the roster. The primary key already leads with (chat_id, viewer_id), so
-- that lookup is covered and no second index is warranted.

-- Labelling yourself is meaningless and the UI never offers it; refuse it here
-- too so a malformed client cannot create a row nothing will ever read.
ALTER TABLE family_relations
  ADD CONSTRAINT family_relations_not_self CHECK (viewer_id <> member_id);
