-- =====================================================================
-- Normalize boolean-ish flag columns to INTEGER for PostgreSQL.
--
-- The application stores/reads these flags as INTEGER 1/0 (SQLite style):
--   issueOtp()  : UPDATE otp_codes SET consumed=1 WHERE ... AND consumed=0
--   verifyOtp() : ... WHERE consumed=0 ; UPDATE ... SET attempts=attempts+1
--
-- On a SHARED PostgreSQL database, otp_codes may have been created by a
-- different migration/app with `consumed BOOLEAN`. Because Equipment's
-- `CREATE TABLE IF NOT EXISTS otp_codes (... consumed INTEGER ...)` silently
-- skips an existing table, the app then ran `... consumed = 0` against a
-- BOOLEAN column and PostgreSQL aborted with:
--     operator does not exist: boolean = integer   (SQLSTATE 42883)
--     at issueOtp (dist-node/server.js)
--
-- This migration is CONDITIONAL + IDEMPOTENT: it inspects the current column
-- type and only rewrites BOOLEAN flag columns to INTEGER (TRUE->1, FALSE->0).
-- Columns that are already INTEGER/numeric are left untouched, and re-runs are
-- no-ops. Written as PL/pgSQL DO blocks (matches 0007_widen_epoch_columns.sql).
-- =====================================================================

DO $$
DECLARE
  t record;
  col_type text;
BEGIN
  -- (table, column) pairs the app treats as INTEGER 1/0 flags.
  FOR t IN
    SELECT * FROM (VALUES
      ('otp_codes', 'consumed'),
      ('otp_codes', 'attempts')
    ) AS v(tbl, col)
  LOOP
    -- Skip if the table/column does not exist yet (fresh DB creates them as
    -- INTEGER via 0003, so there is nothing to fix).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col
    ) THEN
      CONTINUE;
    END IF;

    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = t.col;

    IF col_type = 'boolean' THEN
      RAISE NOTICE '[0022] %.% is boolean -> converting to integer (TRUE=1, FALSE=0)', t.tbl, t.col;
      -- Drop any boolean default first so the type change is clean, convert
      -- using a CASE expression, then restore a numeric default of 0.
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', t.tbl, t.col);
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE integer USING (CASE WHEN %I THEN 1 ELSE 0 END)',
        t.tbl, t.col, t.col
      );
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT 0', t.tbl, t.col);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', t.tbl, t.col);
    ELSE
      RAISE NOTICE '[0022] %.% is % (not boolean) -> leaving as-is', t.tbl, t.col, col_type;
    END IF;
  END LOOP;
END $$;
