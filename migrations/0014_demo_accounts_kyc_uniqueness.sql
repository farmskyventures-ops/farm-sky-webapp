-- =====================================================================
-- 0014 — Demo account phone refresh, KYC gating flags, and uniqueness
--   * Refresh the four demo/login accounts to the new phone numbers.
--   * Add a customers.kyc_completed_at marker so we can gate FINANCED
--     checkouts behind completed KYC (ID docs + liveliness + TransUnion),
--     while still allowing CASH checkouts without it.
--   * Enforce national_id uniqueness (phone is already UNIQUE on users).
-- These statements are idempotent and safe to re-run on an existing DB.
-- =====================================================================

-- --- Demo account phone numbers (kept in sync with seed.sql) -----------
UPDATE users SET phone = '+254702875711' WHERE id = 1 AND role = 'super_admin';
UPDATE users SET phone = '+254729436383' WHERE id = 2 AND role = 'agent';
UPDATE users SET phone = '+254716401463' WHERE id = 3 AND role = 'customer';
UPDATE users SET phone = '+254712612489' WHERE id = 4 AND role = 'support';

-- Keep the linked customer record's mobile aligned with the farmer login.
UPDATE customers SET mobile = '+254716401463' WHERE user_id = 3;

-- --- KYC gating marker -------------------------------------------------
-- Set once a customer completes ID upload + liveliness + TransUnion. Used to
-- block financed checkout until KYC is done (cash checkout is always allowed).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_completed_at TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS liveliness_passed INTEGER DEFAULT 0;

-- --- Uniqueness --------------------------------------------------------
-- national_id must be unique across customers (ignoring NULL/empty).
-- A partial unique index keeps legacy NULL/blank rows valid.
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_national_id
  ON customers (national_id)
  WHERE national_id IS NOT NULL AND national_id <> '';
