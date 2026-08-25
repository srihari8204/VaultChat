-- 116_broadcast_share_geometry.sql — tell HLS viewers what SHAPE the share is.
--
-- WHY THIS EXISTS AT ALL
-- ----------------------
-- A low-latency viewer subscribes to the publisher's own track, so the SFU
-- hands them its real geometry and the client can decide everything from it:
-- whether filling the panel would crop anything worth keeping, and whether a
-- landscape mobile game means the phone should turn. Measured on device
-- 2026-08-25 — an Honor sharing its screen arrives as exactly 1200x2664.
--
-- An HLS viewer gets none of that. Room-composite egress paints every broadcast
-- onto ONE FIXED LANDSCAPE CANVAS (internal/livekit/egress.go), so a portrait
-- phone is pillarboxed inside it and a landscape game fills it — and the two are
-- indistinguishable downstream. The player can report the canvas; the canvas
-- does not describe the content. So the public path could not do what the
-- private path does, and a shared game was a strip across the middle of the
-- screen with no way for the client to know it should not be.
--
-- WHY NOT JUST MAKE THE CANVAS MATCH
-- ----------------------------------
-- That was the first idea and it is worse. The canvas is fixed when egress
-- STARTS, and the interesting case is a host who goes live on camera (portrait)
-- and then shares a game (landscape) — which would need the egress restarted
-- mid-broadcast. Restarting egress is the single most dangerous operation in
-- this stack: a >20s gap is already enough to end a broadcast permanently, and
-- egress_failed terminates it before any client reconnects. Two integers on a
-- row cost nothing and cannot take a stream down.
--
-- WHAT THESE ARE
-- --------------
-- The publisher's screen-share geometry in PHYSICAL PIXELS, as LiveKit reports
-- it on track_published. NOT the canvas, NOT the encoder's output after
-- scaling — the shape of the thing being shared, which is the only question the
-- client is asking.
--
-- NULL is meaningful and is the default: no share is running. The client has a
-- correct behaviour for "unknown" and must never be handed a guess instead —
-- guessing landscape would spin every viewer's phone sideways for a broadcast
-- that is a face.
--
-- CAMERA GEOMETRY IS DELIBERATELY NOT STORED HERE. A camera track reports its
-- CAPTURE geometry, not its display geometry: the same handset publishes
-- 1280x720 while drawing 720x1280, because the sensor is landscape and the
-- rotation rides on the frames rather than on the dimensions. Screen capture
-- carries no such rotation. Storing both in one pair of columns would make the
-- honest number indistinguishable from the misleading one.
ALTER TABLE broadcast_sessions
  ADD COLUMN IF NOT EXISTS share_w INT,
  ADD COLUMN IF NOT EXISTS share_h INT;

-- Both or neither. A half-written pair would be read as a shape.
ALTER TABLE broadcast_sessions
  DROP CONSTRAINT IF EXISTS broadcast_sessions_share_geometry_ck;
ALTER TABLE broadcast_sessions
  ADD CONSTRAINT broadcast_sessions_share_geometry_ck
  CHECK ((share_w IS NULL) = (share_h IS NULL)
         AND (share_w IS NULL OR (share_w > 0 AND share_h > 0)));

-- No index. These columns are read only as part of a row already being fetched
-- by primary key, and never filtered on.
