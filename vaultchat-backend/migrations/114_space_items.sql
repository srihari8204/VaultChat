-- 114_space_items.sql — shared item finder (BLE tags) for a space.
--
-- WHY A SERVER SIDE AT ALL: a tag is only findable by a phone in radio range,
-- and the phone in range is often not the owner's. A family is exactly the set
-- of phones that are plausibly near each other's things, so pooling sightings
-- inside the space turns "my keys are somewhere" into "your keys are with
-- Mother, last heard at Home". That pooling is the ONLY thing a commercial
-- tracker's network buys, and inside a family it needs no network at all.
--
-- ONE ROW PER ITEM, newest sighting denormalised onto it — the same shape as
-- space_locations_latest, and for the same reason: nobody wants a history of
-- where their keys have been, they want the last place they were heard.
--
-- WHAT THE SERVER LEARNS, stated plainly: the tag's BLE address, the name the
-- owner gave it, and the coordinate of whoever last heard it. The coordinate
-- is not new — space_locations already holds every member's position under the
-- same membership gate (migration 103). The BLE address is new, and is why
-- this table is space-scoped and membership-gated rather than global: an
-- address is only useful to someone standing next to the tag.

CREATE TABLE IF NOT EXISTS space_items (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The BLE peripheral address. Stable per tag, which is what makes a sighting
  -- by another member's phone attributable to this item.
  ble_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT 'key',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Newest sighting (any member's phone).
  last_seen_at TIMESTAMPTZ NULL,
  last_seen_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  lat          DOUBLE PRECISION NULL,
  lng          DOUBLE PRECISION NULL,
  -- The finder's OWN saved-place name when they were inside one. Derived on
  -- their device; the place's coordinate never travels (same doctrine as the
  -- family reference distances).
  place_name   TEXT NULL,

  CONSTRAINT space_items_ble_ck  CHECK (length(ble_id) BETWEEN 1 AND 64),
  CONSTRAINT space_items_name_ck CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT space_items_lat_ck  CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  CONSTRAINT space_items_lng_ck  CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  -- One registration per tag per space: a second member pairing the same tag
  -- updates the shared row instead of forking it.
  CONSTRAINT space_items_uq UNIQUE (chat_id, ble_id)
);

-- The list read is always "every item in this space, newest sighting first".
CREATE INDEX IF NOT EXISTS space_items_chat_idx
  ON space_items (chat_id, last_seen_at DESC NULLS LAST);
