-- =====================================================================
-- 0027 — guarantee the Equipment Super-Admin account exists with the
--        designated phone number 0702875711 (normalized 254702875711),
--        regardless of whether the shared central `users` table is integer-
--        or UUID-keyed, and regardless of whether the demo seed ever ran.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------
--   * The demo seed (seed.sql) only runs when Equipment CREATES the users
--     table. On the shared central DB, Score created `public.users` first, so
--     the seed never ran and NO super_admin account exists for Equipment.
--   * 0014 tried to fix the phone with `UPDATE users ... WHERE id = 1`, but on
--     a UUID users table `id = 1` throws `operator does not exist: uuid = integer`
--     and is skipped — so the phone was never set on the shared DB.
--
-- This migration is id-type-agnostic: it never references `id`, matches on the
-- role/phone instead, and lets the table's own id default (BIGSERIAL or UUID
-- default) generate the primary key on INSERT. Idempotent & re-runnable.
--
-- Requested Super-Admin login: phone 0702875711  (== +254702875711 == 254702875711)
-- Default password: 1224 (legacy plaintext; verifyPassword accepts it and will
-- re-hash on first login). Change it after first sign-in.
-- =====================================================================

-- 1. Normalize any EXISTING super_admin that already uses one of the accepted
--    phone spellings to the canonical normalized form the app matches on.
UPDATE users
   SET phone = '254702875711', role = 'super_admin', status = 'active'
 WHERE role = 'super_admin'
   AND phone IN ('0702875711', '+254702875711', '254702875711', '0702875711 ');

-- 2. If an account already exists on ANY of the accepted phone spellings,
--    make sure it is an ACTIVE super_admin on the canonical phone.
UPDATE users
   SET role = 'super_admin', status = 'active', phone = '254702875711'
 WHERE phone IN ('0702875711', '+254702875711', '254702875711');

-- 3. Create the Super-Admin only if no account holds the canonical phone yet.
--    Column list is explicit so the id default (serial/uuid) fills the PK.
--    Super-Admin capability comes from role (hasPermission() short-circuits to
--    true for super_admin/admin), so permissions is just '{}' (role defaults).
INSERT INTO users (full_name, phone, email, password, role, status, region, password_set, label, permissions)
SELECT 'System Administrator', '254702875711', 'admin@farmsky.africa', '1224',
       'super_admin', 'active', 'HQ - Nairobi', 1, 'Super Admin', '{}'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE phone = '254702875711'
);
