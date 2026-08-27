-- 117_story_gates.sql — a status can be locked behind a puzzle or a question.
--
-- TWO GATES, AND THE DATABASE MUST NOT BLUR THEM.
--
--   'puzzle'    ENGAGEMENT ONLY. The viewer already holds the wrapped content
--               key (stories are encrypted per viewer — migration 039); solving
--               only decides when the UI reveals it. A modified client skips
--               it. Nothing stored here is a secret.
--
--   'question'  REAL. The content key is wrapped a SECOND time under a key
--               derived from the answer (scrypt, per-story salt) before it ever
--               reaches the server. Someone who does not know the answer cannot
--               decrypt, whatever client they run.
--
-- THE ANSWER IS NEVER STORED. Not in plaintext, not as a hash. A hash would be
-- a cheaper oracle for an offline guesser than the scrypt KDF it is meant to
-- protect — the server would be handing out a fast way to test guesses against
-- a low-entropy secret. The only server-side artefact is the salt, which is
-- public by design: it defeats precomputation, it is not a secret.
--
-- Wrong answers are therefore detected by DECRYPTION FAILING, client-side, and
-- the server cannot tell a wrong answer from a right one. That is the point.

ALTER TABLE stories ADD COLUMN IF NOT EXISTS gate_kind TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS gate_grid INTEGER;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS gate_prompt TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS gate_salt TEXT;

-- gate_kind is the discriminator. NULL means an ordinary, ungated status, which
-- is what every existing row is and what most rows will stay.
ALTER TABLE stories DROP CONSTRAINT IF EXISTS stories_gate_kind_ck;
ALTER TABLE stories ADD CONSTRAINT stories_gate_kind_ck
  CHECK (gate_kind IS NULL OR gate_kind IN ('puzzle', 'question'));

-- A puzzle needs its grid and nothing else; a question needs its prompt and
-- salt and no grid. Enforced here rather than trusted from the client, because
-- a half-written gate is a status nobody can open: a 'question' row with no
-- salt cannot be unwrapped by anyone, including its author.
--
-- WRITTEN AS A CASE, NOT AN OR-CHAIN, AND THAT IS THE WHOLE POINT.
--
-- A CHECK passes unless it is definitively FALSE, so SQL's three-valued logic
-- turns an OR-chain into a hole. Both halves of that bit an earlier draft here,
-- and 117_story_gates_test.sql caught both:
--
--   * `gate_grid BETWEEN 3 AND 9` is NULL when the column is NULL, so a puzzle
--     with NO GRID evaluated to FALSE OR NULL OR FALSE = NULL, and was ACCEPTED.
--   * `gate_kind = 'puzzle'` is NULL when gate_kind is NULL, poisoning the other
--     branches, so gate fields with NO KIND were ACCEPTED — a row that reads as
--     ungated and silently publishes what was meant to be locked.
--
-- coalesce() collapses the discriminator to a real value before anything is
-- compared, and ELSE FALSE makes an unrecognised kind a definite refusal rather
-- than an unknown. Do not "simplify" this back into ORs.
--
-- 3..9 matches lib/status/gate.ts GRID_MIN/GRID_MAX. If that range ever moves,
-- this constraint is the second place to change — a mismatch shows up as a
-- rejected INSERT, which is loud, rather than as an unopenable status.
ALTER TABLE stories DROP CONSTRAINT IF EXISTS stories_gate_shape_ck;
ALTER TABLE stories ADD CONSTRAINT stories_gate_shape_ck
  CHECK (
    CASE coalesce(gate_kind, 'none')
      WHEN 'none' THEN
        gate_grid IS NULL AND gate_prompt IS NULL AND gate_salt IS NULL
      WHEN 'puzzle' THEN
        gate_grid IS NOT NULL AND gate_grid BETWEEN 3 AND 9
        AND gate_prompt IS NULL AND gate_salt IS NULL
      WHEN 'question' THEN
        gate_grid IS NULL
        AND gate_prompt IS NOT NULL AND length(gate_prompt) > 0
        AND gate_salt   IS NOT NULL AND length(gate_salt)   > 0
      ELSE FALSE
    END
  );

-- No index. These columns are read only as part of a story row already being
-- fetched for the feed or by id, and are never filtered on.
