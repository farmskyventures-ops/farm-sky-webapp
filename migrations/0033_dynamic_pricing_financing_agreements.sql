-- ============================================================================
-- 0033 — Dynamic Pricing & Markup, Dynamic Financing Types, Agreement Engine
-- ============================================================================
-- Adds the schema needed for:
--   1. Dynamic pricing modes for BOTH cash and financed selling prices
--      (percentage markup / fixed-amount markup / manual overwrite).
--   2. Flexible tenure parameters (monthly / yearly / custom cycle) with a
--      rate-or-amount per cycle and a cycle count / length.
--   3. A dynamic, admin-managed catalogue of financing types (create / edit /
--      remove) that automatically become selectable during inventory listing.
--   4. A templating engine for per-financing-type sale agreements
--      (overview header + auto-populated details table + rich-text body).
--   5. Deprecation of the TransUnion product code (column kept nullable for
--      backwards-compatibility but no longer surfaced or required).
-- Idempotent: safe to run repeatedly (db-init applies it on every boot).
-- ----------------------------------------------------------------------------

-- 1. Pricing-mode columns on products ---------------------------------------
--    *_price_mode ∈ ('percentage','fixed','manual')
--    percentage → selling = buying * (1 + markup_pct/100)
--    fixed      → selling = buying + markup_amount
--    manual     → selling = the explicitly entered price (markup ignored)
ALTER TABLE products ADD COLUMN IF NOT EXISTS cash_price_mode TEXT DEFAULT 'percentage';
ALTER TABLE products ADD COLUMN IF NOT EXISTS cash_markup_amount REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS credit_price_mode TEXT DEFAULT 'percentage';
ALTER TABLE products ADD COLUMN IF NOT EXISTS credit_markup_amount REAL DEFAULT 0;

-- 2. Flexible tenure parameters ---------------------------------------------
--    financing_tenure_unit ∈ ('monthly','yearly','custom')
--    financing_rate_per_cycle   → % charged per cycle (percentage financing)
--    financing_amount_per_cycle → fixed money charged per cycle (fixed financing)
--    financing_cycle_count      → total number of cycles (months / years / cycles)
--    financing_cycle_length_days → length of ONE custom cycle, in days
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_tenure_unit TEXT DEFAULT 'monthly';
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_rate_per_cycle REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_amount_per_cycle REAL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_cycle_count INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_cycle_length_days INTEGER DEFAULT 30;

-- financing_type_key links a product to a row in financing_types (dynamic).
ALTER TABLE products ADD COLUMN IF NOT EXISTS financing_type_key TEXT;

-- 3. Dynamic financing-type catalogue ---------------------------------------
CREATE TABLE IF NOT EXISTS financing_types (
  id           SERIAL PRIMARY KEY,
  type_key     TEXT UNIQUE NOT NULL,          -- machine key, e.g. 'murabaha'
  label        TEXT NOT NULL,                 -- display name, e.g. 'Murabaha'
  description  TEXT,
  charge_mode  TEXT DEFAULT 'percentage',     -- percentage | fixed | none
  is_system    INTEGER DEFAULT 0,             -- system defaults cannot be deleted
  active       INTEGER DEFAULT 1,
  sort_order   INTEGER DEFAULT 100,
  created_by   TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed the built-in financing types. 'cash' is a payment path, not a financing
-- type, so it is intentionally NOT listed here.
INSERT INTO financing_types (type_key, label, description, charge_mode, is_system, sort_order)
VALUES
  ('loan_interest', 'Financing (with interest)', 'Standard installment financing with an interest / finance charge.', 'percentage', 1, 10),
  ('paygo',         'PAYGO',                     'Pay-as-you-go financing billed per cycle until fully settled.',       'percentage', 1, 20),
  ('murabaha',      'Murabaha',                  'Sharia-compliant cost-plus-markup financing (no interest, no penalties).', 'percentage', 1, 30)
ON CONFLICT (type_key) DO NOTHING;

-- 4. Agreement templates (one per financing type / payment path) ------------
--    path_key matches either a financing_types.type_key OR the literal 'cash'.
CREATE TABLE IF NOT EXISTS agreement_templates (
  id             SERIAL PRIMARY KEY,
  path_key       TEXT UNIQUE NOT NULL,         -- 'cash' | financing type_key
  title          TEXT NOT NULL,                -- e.g. 'MURABAHA SALE AGREEMENT'
  overview_html  TEXT,                         -- dynamic header (rich text)
  body_html      TEXT,                         -- terms & body (rich text)
  style_json     TEXT,                         -- optional style overrides
  updated_by     TEXT,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed sensible default templates so every path has a usable agreement.
INSERT INTO agreement_templates (path_key, title, overview_html, body_html)
VALUES
  ('cash', 'CASH SALE AGREEMENT',
   '<p>This Cash Sale Agreement is made between Farmsky and the purchasing farmer for the outright cash purchase of the asset described below.</p>',
   '<p>The buyer agrees to pay the disclosed cash price in full. Ownership of the asset transfers to the buyer upon receipt of full payment. All sales are subject to Farmsky''s standard terms of service.</p>'),
  ('loan_interest', 'FINANCING SALE AGREEMENT',
   '<p>This Financing Sale Agreement is made between Farmsky and the purchasing farmer for the financed purchase of the asset described below.</p>',
   '<p>The buyer agrees to pay the disclosed financed price, the agreed deposit, and the installment repayment schedule until the outstanding balance is fully settled. Ownership transfers per the executed financing agreement.</p>'),
  ('paygo', 'PAYGO SALE AGREEMENT',
   '<p>This PAYGO Sale Agreement governs the pay-as-you-go financing of the asset described below.</p>',
   '<p>The buyer agrees to pay per billing cycle until the total financed amount is settled. Service may be suspended for missed cycles per the PAYGO terms. Ownership transfers upon full settlement.</p>'),
  ('murabaha', 'MURABAHA SALE AGREEMENT',
   '<p>This Murabaha Sale Agreement is a Sharia-compliant cost-plus-markup sale between Farmsky and the purchasing farmer.</p>',
   '<p>Farmsky discloses the cost price and the agreed profit (markup). The buyer repays the total in equal installments over the agreed term with no interest (riba), no penalties, and no compounding. Ownership transfers per the executed Murabaha agreement.</p>')
ON CONFLICT (path_key) DO NOTHING;
