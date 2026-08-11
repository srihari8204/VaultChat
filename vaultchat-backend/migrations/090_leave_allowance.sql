-- VaultChat: Spaces & Operations — leave entitlements.
-- Idempotent — safe to re-run.
--
-- The Employee design shows a balance card: Casual 10 / Sick 08 / Privilege 12,
-- with "Paid 06 / Paid 06" beneath. That needs an entitlement to subtract from,
-- which 089 deliberately did not invent.
--
-- ── the policy this encodes, and the one it refuses to ──
--
-- A GRANT PER YEAR, per space, configurable, with no accrual and no carry-over.
-- Days used are counted from approved requests in the current calendar year.
--
-- That is the simplest policy that is honest. Real payroll leave has monthly
-- accrual, pro-rata joining dates, carry-over caps, encashment and statutory
-- minimums that differ by country — none of which can be guessed, and all of
-- which produce a number an employee will compare against their payslip. So
-- this stores what a space's admin SAYS the allowance is and shows what has
-- been taken against it. It is a tracker, not a payroll engine, and the API
-- says so rather than implying an authority it does not have.
--
-- Defaults are the design's own numbers so a new space matches the mockup; any
-- space can change them without a migration.

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS leave_allowance JSONB;

COMMENT ON COLUMN chats.leave_allowance IS
  'Per-space annual leave grant, e.g. {"casual":10,"sick":8,"privilege":12}. '
  'NULL means the space has not set one — the API then reports allowance as '
  'unknown rather than assuming zero, because "no days left" and "we were never '
  'told how many you get" are different answers.';

-- ── used-days, counted honestly ─────────────────────────────────────
--
-- Counts days of APPROVED leave in the given year, clipping each request to the
-- year boundary so a request spanning New Year is not counted twice.
--
-- Inclusive of both end days: a single-day leave is one day, not zero. That
-- sounds obvious and is the most common off-by-one in leave arithmetic.
--
-- Calendar days, not working days: this server does not know the space's
-- weekends or public holidays, and inventing them would produce a number that
-- is wrong in a way nobody can see. A space that needs working-day accounting
-- needs a holiday calendar first.
CREATE OR REPLACE FUNCTION space_leave_used(
  p_chat_id UUID,
  p_user_id UUID,
  p_year    INT DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INT
) RETURNS JSONB
SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(kind, days), '{}'::jsonb)
    FROM (
      SELECT l.kind,
             SUM(
               (LEAST(l.to_day,   make_date(p_year, 12, 31))
              - GREATEST(l.from_day, make_date(p_year, 1, 1))) + 1
             )::int AS days
        FROM space_leave l
       WHERE l.chat_id = p_chat_id
         AND l.user_id = p_user_id
         AND l.status = 'approved'
         AND l.from_day <= make_date(p_year, 12, 31)
         AND l.to_day   >= make_date(p_year, 1, 1)
       GROUP BY l.kind
    ) s;
$$ LANGUAGE sql STABLE;
