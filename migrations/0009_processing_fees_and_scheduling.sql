-- =====================================================================
-- Processing fees, role scheduling (time-based access), and expanded
-- granular permissions (feature config + data visibility).
-- =====================================================================

-- Global application settings (key/value JSON store) — used for the
-- financing markup + processing-fee configuration managed by Super Admin.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed the default processing-fee configuration (disabled by default).
INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES
  ('processing_fee', '{"enabled":false,"mode":"percentage","percentage_rate":0,"tiers":[]}'),
  ('financing_markup', '{"default_cash_markup_pct":10,"default_credit_markup_pct":20}');

-- Time-based login window controls, per role template.
-- access_days is a JSON array e.g. ["mon","tue"]; access_start/end use "HH:MM".
ALTER TABLE role_templates ADD COLUMN access_days TEXT;
ALTER TABLE role_templates ADD COLUMN access_start TEXT;
ALTER TABLE role_templates ADD COLUMN access_end TEXT;
ALTER TABLE role_templates ADD COLUMN schedule_enabled INTEGER DEFAULT 0;

-- Per-user override of the login window (optional; falls back to role).
ALTER TABLE users ADD COLUMN access_days TEXT;
ALTER TABLE users ADD COLUMN access_start TEXT;
ALTER TABLE users ADD COLUMN access_end TEXT;
ALTER TABLE users ADD COLUMN schedule_enabled INTEGER DEFAULT 0;

-- New granular permission catalog entries: feature config + data visibility.
INSERT OR IGNORE INTO permission_catalog (permission_key, label, description, category) VALUES
  ('manage_processing_fees', 'Manage Processing Fees', 'Set up and alter processing fee structures (percentage vs range)', 'feature_config'),
  ('manage_markup_pct', 'Manage Markup Percentage', 'Set up and alter the financing markup percentages', 'feature_config'),
  ('view_cash_sales', 'View Cash Sales', 'See cash sales / purchases', 'sales_visibility'),
  ('view_financed_sales', 'View Financed Sales', 'See financed / credit sales', 'sales_visibility'),
  ('view_farmer_profile_data', 'View Farmer Profile Data', 'See farmer profile fields (name, county, value chain, etc.)', 'data_visibility'),
  ('view_financial_data', 'View Financial Data', 'See financial data (loans, deposits, pricing, credit)', 'data_visibility'),
  ('view_document_attachments', 'View Document Attachments', 'See Front ID, Back ID and passport / selfie photos', 'data_visibility');

-- Grant the new permissions to full-access system roles so nothing breaks.
UPDATE role_templates
   SET permissions = '{"view":true,"edit":true,"delete":true,"deactivate":true,"approve":true,"dispatch":true,"add_farmer":true,"view_farmers":true,"view_credit_purchases":true,"manage_users":true,"request_admin_action":true,"manage_processing_fees":true,"manage_markup_pct":true,"view_cash_sales":true,"view_financed_sales":true,"view_farmer_profile_data":true,"view_financial_data":true,"view_document_attachments":true}'
 WHERE role_key IN ('super_admin','admin');
