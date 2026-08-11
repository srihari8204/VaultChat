-- VaultChat: Spaces & Operations — tracked devices and theft protection.
-- Idempotent — safe to re-run.
--
-- The design's Devices tab (screens 14, 15, 17) and Mobile Theft Protection
-- (18): a car, a bike, a laptop bag, a pet tracker, a phone — each with a
-- status, an alert history, and remote actions.
--
-- ── WHAT THIS DOES NOT STORE, AND WHY ──
--
-- No coordinates. Not one.
--
-- A device's position travels the same way a member's and a vehicle's does:
-- sealed on the live-location channel, which this server relays and cannot
-- read. What lives here is IDENTITY and STATE — what the thing is, who it
-- belongs to, when it last reported, what happened to it.
--
-- That is a deliberate limit with a real consequence, and it is better said
-- here than discovered later: a THIRD-PARTY GPS TRACKER (an OBD dongle, a pet
-- collar, a Chinese vehicle tracker) cannot participate. Those devices post
-- plaintext coordinates to whatever server they are told to, and accepting that
-- feed would mean this database holding the live position of a family's car in
-- the clear — the exact thing the sealed-ping design exists to prevent.
--
-- So `last_seen_at` is a timestamp, exactly like runs.last_ping_at. A device
-- backed by a phone running VaultChat works fully. A device backed by someone
-- else's tracker can be REGISTERED and its events recorded, but its position is
-- not here, and no endpoint accepts one. Supporting those trackers is a product
-- decision about plaintext location, not a schema gap, and it needs to be taken
-- deliberately rather than by adding a lat/lng column one afternoon.

-- ── the devices ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS space_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  -- The person answerable for it. NULL for a shared asset (a pool car).
  owner_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other',
  -- Free text: "Honda City", "TN 01 AB 1234". Never parsed by the server.
  identifier    TEXT,
  -- Proof of life only. No position — see the header.
  last_seen_at  TIMESTAMPTZ,
  battery       SMALLINT,
  -- Whether a VaultChat client backs this device. FALSE means events can be
  -- recorded but nothing can be commanded, and the API says so rather than
  -- offering a Lock button that will never do anything.
  app_backed    BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT space_devices_kind_check CHECK (kind IN
    ('phone', 'car', 'bike', 'bag', 'pet', 'vehicle', 'other')),
  CONSTRAINT space_devices_label_len CHECK (char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT space_devices_battery CHECK (battery IS NULL OR battery BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_space_devices_chat
  ON space_devices(chat_id) WHERE archived_at IS NULL;

-- ── what happened to them ───────────────────────────────────────────
-- Screens 13 and 17: device history and device alerts. Append-only.
--
-- Detection happens on the DEVICE for the same reason it does for a run: the
-- server cannot see a position, so it cannot judge speed, a zone crossing or a
-- route deviation. The one thing it can judge is silence, which needs no
-- plaintext — see 'disconnected'.
CREATE TABLE IF NOT EXISTS space_device_events (
  id         BIGSERIAL PRIMARY KEY,
  device_id  UUID NOT NULL REFERENCES space_devices(id) ON DELETE CASCADE,
  chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  -- Rendered for a human by the device that detected it. Carries the FACT and
  -- never a coordinate, the same rule lib/spaces/detect.ts follows.
  text       TEXT,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail     JSONB,
  CONSTRAINT space_device_events_kind_check CHECK (kind IN
    ('overspeed', 'left_zone', 'entered_zone', 'low_battery', 'shock',
     'disconnected', 'moved', 'powered_off', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_space_device_events
  ON space_device_events(device_id, at DESC);

-- ── theft protection ────────────────────────────────────────────────
-- Screen 18: lock, ring, show a message, capture a photo, wipe.
--
-- A COMMAND QUEUE, not an action. The server records an instruction and the
-- device executes it when it next connects; this table is the record of who
-- asked for what and whether it happened.
--
-- It is modelled this way because the server genuinely cannot do any of these
-- things — every one needs Android Device Admin on the handset. A design that
-- pretended otherwise would show a Lock button that reports success while the
-- phone is off in a drawer.
--
-- `result` closes the loop honestly: 'executed' is written by the DEVICE, not by
-- the server, so an unacknowledged command stays 'issued' forever rather than
-- being assumed to have worked.
CREATE TABLE IF NOT EXISTS space_device_commands (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES space_devices(id) ON DELETE CASCADE,
  chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  -- For 'message': the text to show. Never credentials, never a location.
  payload     TEXT,
  issued_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result      TEXT NOT NULL DEFAULT 'issued',
  CONSTRAINT space_device_commands_action_check CHECK (action IN
    ('lock', 'ring', 'message', 'photo', 'wipe', 'locate')),
  CONSTRAINT space_device_commands_result_check CHECK (result IN
    ('issued', 'delivered', 'executed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_space_device_commands_open
  ON space_device_commands(device_id, issued_at DESC)
  WHERE result IN ('issued', 'delivered');

-- ── row level security ──────────────────────────────────────────────
ALTER TABLE space_devices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_devices         FORCE  ROW LEVEL SECURITY;
ALTER TABLE space_device_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_device_events   FORCE  ROW LEVEL SECURITY;
ALTER TABLE space_device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_device_commands FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS space_devices_select         ON space_devices;
DROP POLICY IF EXISTS space_devices_write          ON space_devices;
DROP POLICY IF EXISTS space_device_events_select   ON space_device_events;
DROP POLICY IF EXISTS space_device_events_insert   ON space_device_events;
DROP POLICY IF EXISTS space_device_commands_select ON space_device_commands;
DROP POLICY IF EXISTS space_device_commands_write  ON space_device_commands;

-- Your own devices always; the space's if you run it. A colleague cannot browse
-- your phone's history because you share an office.
CREATE POLICY space_devices_select ON space_devices FOR SELECT USING (
  vc_is_chat_member(chat_id)
  AND (owner_id = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
);
CREATE POLICY space_devices_write ON space_devices FOR ALL
  USING (
    vc_is_chat_member(chat_id)
    AND (owner_id = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
  )
  WITH CHECK (
    vc_is_chat_member(chat_id)
    AND (owner_id = vc_current_user_id() OR vc_space_ops_viewer(chat_id))
  );

CREATE POLICY space_device_events_select ON space_device_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM space_devices d
     WHERE d.id = device_id
       AND vc_is_chat_member(d.chat_id)
       AND (d.owner_id = vc_current_user_id() OR vc_space_ops_viewer(d.chat_id))
  )
);
-- Events are reported BY the device, so only its owner may file them. Ops can
-- read every event and write none: an alert nobody's device raised is not an
-- alert, it is an assertion.
CREATE POLICY space_device_events_insert ON space_device_events FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM space_devices d
     WHERE d.id = device_id AND d.owner_id = vc_current_user_id()
       AND vc_is_chat_member(d.chat_id)
  )
);

CREATE POLICY space_device_commands_select ON space_device_commands FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM space_devices d
     WHERE d.id = device_id
       AND vc_is_chat_member(d.chat_id)
       AND (d.owner_id = vc_current_user_id() OR vc_space_ops_viewer(d.chat_id))
  )
);
-- Commanding a device is the OWNER's right. Deliberately not extended to ops:
-- "wipe" and "capture a photo" aimed at an employee's personal phone by their
-- manager is a different product with different consent, and if a fleet ever
-- needs it, it should be an explicit grant rather than something that arrived
-- because ops could already see the device.
CREATE POLICY space_device_commands_write ON space_device_commands FOR ALL
  USING (
    EXISTS (SELECT 1 FROM space_devices d
             WHERE d.id = device_id AND d.owner_id = vc_current_user_id()
               AND vc_is_chat_member(d.chat_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM space_devices d
             WHERE d.id = device_id AND d.owner_id = vc_current_user_id()
               AND vc_is_chat_member(d.chat_id))
  );

-- ── device status, derived ──────────────────────────────────────────
-- Silence is the one judgement the server can make without a position, which is
-- exactly why it is the one it makes. Everything else about a device — where it
-- is, how fast, whether it left a zone — is detected on the device itself.
CREATE OR REPLACE FUNCTION space_device_stale(p_last_seen TIMESTAMPTZ, p_minutes INT DEFAULT 15)
RETURNS BOOLEAN AS $$
  SELECT p_last_seen IS NULL OR p_last_seen < NOW() - make_interval(mins => p_minutes);
$$ LANGUAGE sql IMMUTABLE;
