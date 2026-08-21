-- 112_shopbook_khata_credit_limit.sql
-- Shop Book: a credit ceiling for a walk-in khata.
-- Idempotent. ADDITIVE ONLY — no existing row changes, no backfill, no rewrite.
--
-- WHAT IS MISSING
--
--   111 gave the ledger a walk-in party, and sbCreditCheck already derives that
--   party's outstanding balance the same way it derives an account customer's:
--   SUM over the ledger, never a stored total. What it CANNOT do is compare
--   that balance against anything, because a walk-in has nowhere to keep a
--   limit.
--
--   credit_limit lives on shopbook_customer, whose primary key is
--   (shop_id, customer_user_id) and whose customer_user_id is
--   FOREIGN KEY REFERENCES users(id). A walk-in has no users row by definition,
--   so Postgres refuses that shape outright — the limit cannot be stored there
--   under any encoding, and forcing a khata id into a users-FK column would
--   corrupt every query that reads shopbook_customer.
--
--   So the column has to exist here. That is the entire content of this file.
--
-- WHY THE DEFAULT IS 0 AND NOT NULL
--
--   sbCreditCheck treats `limit <= 0` as "no ceiling configured" and returns
--   early. Defaulting to 0 therefore means every existing and future walk-in
--   keeps EXACTLY the behaviour it has today — unconstrained — until an owner
--   sets a limit deliberately. A NULL default would need a second branch in the
--   comparison for no gain. Nothing is backfilled because 0 already is the
--   current semantics.
--
-- SAME REPRESENTATION AS THE ACCOUNT-CUSTOMER COLUMN: NUMERIC rupees, read
-- through sbCents() into integer paise, with the same >= 0 guard
-- (shopbook_customer_limit_ok). Two money columns that mean the same thing must
-- not be stored two different ways.

ALTER TABLE shopbook_khata_customer
  ADD COLUMN IF NOT EXISTS credit_limit NUMERIC NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shopbook_khata_customer_limit_ok'
  ) THEN
    ALTER TABLE shopbook_khata_customer
      ADD CONSTRAINT shopbook_khata_customer_limit_ok CHECK (credit_limit >= 0);
  END IF;
END $$;
