-- 122_shopbook_audit_cascade.sql
-- Shop Book: let a shop be deleted again without letting anybody delete its
-- audit trail. Idempotent. No table, column or row changes — one function.
--
-- THE BUG
--
--   095 made shopbook_audit append-only with
--
--     CREATE TRIGGER shopbook_audit_no_update
--       BEFORE UPDATE OR DELETE ON shopbook_audit ...
--
--   while shop_id is `REFERENCES shopbook_shop(id) ON DELETE CASCADE`. A
--   cascade is not a special case in Postgres: deleting the shop issues real
--   row-level DELETEs against every child table, this trigger fires on them,
--   and its exception propagates all the way back out. So a shop that has ever
--   recorded a single audited action — a price change, a stock adjustment, a
--   khata entry, which is every shop that has traded — CANNOT BE DELETED AT
--   ALL. Reproduced on the bench before this file was written:
--
--     ERROR: shopbook_audit is append-only (attempted DELETE)
--     CONTEXT: SQL statement "DELETE FROM ONLY public.shopbook_audit
--              WHERE $1 OPERATOR(pg_catalog.=) shop_id"
--
--   It has been latent only because nothing deletes shops yet. It stops being
--   latent the first time a shop closes, an owner asks to be erased, or a test
--   fixture tries to clean up after itself.
--
--   110 hit the identical shape on shopbook_invoice and fixed it by narrowing
--   the trigger to BEFORE UPDATE — giving up delete protection entirely,
--   which is right for an invoice (its CONTENT is the thing being protected).
--
-- WHY THIS FILE DOES NOT SIMPLY COPY THAT
--
--   For an audit log, deletion IS the attack. "Nobody may edit a row" while
--   anybody may delete it protects nothing: the audited party just removes the
--   line instead of rewriting it. So the guarantee is kept and the cascade is
--   let through, by asking WHO is doing the deleting.
--
--   pg_trigger_depth() is 1 when a statement fires this trigger directly, and
--   greater than 1 when the DELETE was issued from inside another trigger —
--   which is exactly what a foreign key's ON DELETE CASCADE is. So:
--
--     depth  = 1  →  someone ran DELETE FROM shopbook_audit. Refused.
--     depth  > 1  →  the row is going because its shop is going. Allowed.
--
--   Both halves are asserted in tests/122_shopbook_audit_cascade_test.sql
--   against a copy of this schema, because a guarantee nobody has fired is a
--   guess. The honest limit of the rule: a DELETE issued from inside any other
--   trigger also reads as depth > 1. Nothing in this schema does that today,
--   and the alternative — dropping delete protection outright — is strictly
--   weaker.
--
-- UPDATE is untouched: no row, ever, at any depth.

CREATE OR REPLACE FUNCTION shopbook_audit_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  -- Deleted as part of its parent going away (ON DELETE CASCADE), not by
  -- someone reaching into the log.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'shopbook_audit is append-only (attempted %)', TG_OP;
END $$ LANGUAGE plpgsql;

-- The trigger itself is unchanged (095 already binds BEFORE UPDATE OR DELETE);
-- restated so this migration is complete on a database where 095 ran but the
-- trigger was later dropped by hand.
DROP TRIGGER IF EXISTS shopbook_audit_no_update ON shopbook_audit;
CREATE TRIGGER shopbook_audit_no_update
  BEFORE UPDATE OR DELETE ON shopbook_audit
  FOR EACH ROW EXECUTE FUNCTION shopbook_audit_is_append_only();
