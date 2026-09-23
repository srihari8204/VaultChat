-- 138_pet_care_cap.sql — raise the pet_care group cap to 20, which 084 meant to do.
--
-- THE DEFECT
-- ----------
-- 084_space_roles.sql intended to raise pet_care from 10 to 20. It tried to do
-- it with an INSERT:
--
--   INSERT INTO group_type_config (group_type, …, max_members, …) VALUES
--     ('pet_care', 'Pet Care', 'paw', '#F59E0B', 20, …)
--   ON CONFLICT (group_type) DO NOTHING;
--
-- pet_care already existed — 073_membership_v2.sql inserted it at 10 — so the
-- conflict fired and the row was DISCARDED. The 20 never landed. The same
-- migration raised school and business/office with explicit UPDATE statements,
-- and those worked; only pet_care went in through the insert path and was
-- silently dropped.
--
-- VERIFIED AGAINST PRODUCTION 2026-09-22: group_type_config still reports
-- pet_care = 10. This is the whole of the defect — no other type is affected,
-- riders at 10 is deliberate (073) and is left alone.
--
-- WHY AN UPDATE, NOT ANOTHER INSERT
-- ---------------------------------
-- Exactly the lesson 084 paid for. The row exists; only an UPDATE can change
-- it. `ON CONFLICT DO NOTHING` on a row that is already there is a no-op that
-- reports success, which is why this went unnoticed for weeks.
--
-- SAFETY
-- ------
-- A cap RAISE is always safe. The enforcement trigger from 070 fires only on
-- insert and on rejoin, so no existing member is affected and nothing is
-- evicted. A pet_care group sitting at 10 simply gains ten more seats.
--
-- Scoped by the current value so a re-run, or an operator who has already
-- tuned this group type by hand, is not overwritten.

UPDATE group_type_config
   SET max_members = 20
 WHERE group_type = 'pet_care'
   AND max_members = 10;
