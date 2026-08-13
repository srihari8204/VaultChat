-- 081_broadcast_one_active.sql — one live broadcast per host, enforced by the
-- database. Idempotent.
--
-- WHY THE GO CHECK IS NOT ENOUGH
-- ------------------------------
-- broadcastStart reads "does this host already have a live broadcast?" and then
-- inserts. Those are two statements, so two requests that arrive together both
-- read "no" and both insert — the classic check-then-act race. It needs no
-- malice to happen: a double-tap on "Go Live", or a client retry after a slow
-- response, is enough.
--
-- The result is the exact state the check exists to prevent: two broadcasts,
-- two egress jobs transcoding the same room, and a host who can only ever end
-- the one their client knows about. The other keeps running — burning the only
-- CPU-bound service in the stack — until someone notices.
--
-- A partial unique index makes it impossible rather than unlikely. The loser of
-- the race gets a unique violation, which the handler already treats as
-- "already live" (errAlreadyLive), so the user sees the correct message instead
-- of a 500.
--
-- Mirrors the pattern 066 uses for calls: `UNIQUE (chat_id) WHERE ended_at IS
-- NULL`. Same problem, same shape of answer.
--
-- PRE-FLIGHT: any rows that already violate this must be resolved first, or the
-- index cannot be built. 'starting' rows older than five minutes are dead by
-- definition — a healthy start publishes in seconds — and a crashed host can
-- leave one behind forever, which is how two were found in production.
UPDATE broadcast_sessions
   SET status = 'failed', ended_at = now()
 WHERE status = 'starting'
   AND started_at < now() - interval '5 minutes';

-- Same treatment for 'live' rows nothing has touched in a long time. A host
-- whose app was killed never sends the end request, so the row stays 'live',
-- shows in every listing, and blocks that account from broadcasting again.
UPDATE broadcast_sessions
   SET status = 'failed', ended_at = now()
 WHERE status = 'live'
   AND started_at < now() - interval '12 hours';

-- Keep only the newest still-active row per host, so the index can be created
-- even if a past race already produced duplicates.
UPDATE broadcast_sessions b
   SET status = 'failed', ended_at = now()
 WHERE b.status IN ('starting', 'live')
   AND EXISTS (
     SELECT 1 FROM broadcast_sessions n
      WHERE n.host_id = b.host_id
        AND n.status IN ('starting', 'live')
        AND n.started_at > b.started_at
   );

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_one_active_per_host
  ON broadcast_sessions (host_id)
  WHERE status IN ('starting', 'live');
