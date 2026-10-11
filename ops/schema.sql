-- ===========================================================================
-- Bismillah Internet — ISP CRM, Billing & WhatsApp Automation
-- Phase 2: PostgreSQL schema (target: PostgreSQL 16+)
--
-- Business timezone: Asia/Karachi. All *dates* used for billing decisions are
-- Karachi calendar dates; all *timestamps* are timestamptz stored in UTC.
-- ===========================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy name search / dedup

-- ---------------------------------------------------------------------------
-- 0. Conventions
-- ---------------------------------------------------------------------------

CREATE DOMAIN msisdn AS text
  CHECK (VALUE ~ '^\+[1-9][0-9]{7,14}$');   -- E.164, normalized on write

CREATE DOMAIN money_pkr AS numeric(12,2)
  CHECK (VALUE >= 0);

CREATE OR REPLACE FUNCTION bi_now_karachi_date() RETURNS date
  LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'Asia/Karachi')::date $$;

-- Anchored month arithmetic. Clamps to the last day of short months WITHOUT
-- losing the customer's real billing day on the following cycle.
--   bi_cycle_end(31, 2026, 2)  -> 2026-02-28
--   bi_cycle_end(31, 2026, 3)  -> 2026-03-31   (not 2026-03-28)
--   bi_cycle_end(29, 2028, 2)  -> 2028-02-29   (leap year)
CREATE OR REPLACE FUNCTION bi_cycle_end(anchor_day int, y int, m int)
RETURNS date LANGUAGE sql IMMUTABLE AS
$$
  SELECT make_date(y, m,
           LEAST(anchor_day,
                 EXTRACT(DAY FROM (make_date(y, m, 1) + INTERVAL '1 month'
                                                     - INTERVAL '1 day'))::int))
$$;

CREATE OR REPLACE FUNCTION bi_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- 1. Enumerations
-- ---------------------------------------------------------------------------

CREATE TYPE customer_status AS ENUM
  ('ACTIVE','PAYMENT_DUE','OVERDUE','SUSPENDED','INACTIVE','INCOMPLETE');

CREATE TYPE invoice_status AS ENUM
  ('UNPAID','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED');

CREATE TYPE payment_method AS ENUM
  ('CASH','BANK_TRANSFER','JAZZCASH','EASYPAISA','RAAST','ONLINE_TRANSFER','OTHER');

CREATE TYPE connection_type AS ENUM ('FIBER','PTP_WIRELESS','CABLE','OTHER');

CREATE TYPE notification_type AS ENUM
  ('TWO_DAY_REMINDER','FINAL_EXPIRY_WARNING','PAYMENT_CONFIRMATION');

CREATE TYPE notification_status AS ENUM
  ('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED','CANCELLED');

CREATE TYPE whatsapp_number_state AS ENUM
  ('UNVERIFIED','VALID','INVALID','OPTED_OUT');

CREATE TYPE import_batch_status AS ENUM
  ('UPLOADED','PARSING','PREVIEW_READY','COMMITTING','COMPLETED','FAILED','CANCELLED');

CREATE TYPE import_row_verdict AS ENUM
  ('VALID','INCOMPLETE','DUPLICATE','ERROR');

-- ---------------------------------------------------------------------------
-- 2. Identity, roles, permissions
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id            smallserial PRIMARY KEY,
  code          text UNIQUE NOT NULL,          -- SUPER_ADMIN, ADMIN, STAFF, TECHNICIAN
  name          text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code          text PRIMARY KEY,              -- 'customer:write', 'whatsapp:send'
  description   text NOT NULL
);

CREATE TABLE role_permissions (
  role_id         smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE NOT NULL,
  full_name       text NOT NULL,
  password_hash   text NOT NULL,               -- argon2id
  role_id         smallint NOT NULL REFERENCES roles(id),
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  failed_logins   smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,          -- never store the token itself
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Areas and packages
-- ---------------------------------------------------------------------------

CREATE TABLE areas (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE packages (
  id                serial PRIMARY KEY,
  code              text NOT NULL UNIQUE,      -- 'PKG-20M'
  name              text NOT NULL,
  speed_mbps        integer NOT NULL CHECK (speed_mbps > 0),
  monthly_price     money_pkr NOT NULL,
  description       text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER packages_touch BEFORE UPDATE ON packages
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

-- Packages are never deleted. Editing a package must not rewrite history:
-- invoices snapshot name/speed/price at issue time (see §5).

-- ---------------------------------------------------------------------------
-- 4. Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code       text NOT NULL UNIQUE,          -- 'BI-000124'
  full_name           text NOT NULL,
  cnic                text CHECK (cnic IS NULL OR cnic ~ '^[0-9]{5}-[0-9]{7}-[0-9]$'),
  address             text,
  area_id             integer REFERENCES areas(id),

  primary_phone       msisdn,                        -- may be NULL if INCOMPLETE

  status              customer_status NOT NULL DEFAULT 'INCOMPLETE',
  missing_fields      text[] NOT NULL DEFAULT '{}',  -- drives the INCOMPLETE badge

  installation_date   date,
  -- Immutable billing day-of-month. Cycle ends are derived from this, never
  -- from the previous expiry, so 31 Jan -> 28 Feb -> 31 Mar stays correct.
  billing_anchor_day  smallint CHECK (billing_anchor_day BETWEEN 1 AND 31),
  current_expiry_date date,                          -- denormalized read model

  -- technical
  connection_type     connection_type,
  ip_address          inet,
  mac_address         macaddr,
  router_model        text,
  onu_serial          text,
  technical_notes     text,

  notes               text,

  -- Provenance from the legacy PPPoE/router export. Kept verbatim because it
  -- is how a CRM record is matched back to the account on the router; the
  -- display name above gets cleaned up by staff, this must not.
  legacy_username     text,
  -- The numeric prefix carried on those usernames ("10" in "10mwaseem").
  -- Almost certainly a pole/box/area code. Stored as-is rather than guessed
  -- at, so it can be mapped onto areas once the meaning is confirmed.
  legacy_group        text,

  deleted_at          timestamptz,                   -- soft delete only
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

CREATE INDEX customers_status_idx        ON customers (status) WHERE deleted_at IS NULL;
CREATE INDEX customers_expiry_idx        ON customers (current_expiry_date) WHERE deleted_at IS NULL;
CREATE INDEX customers_area_idx          ON customers (area_id);
CREATE INDEX customers_phone_idx         ON customers (primary_phone);
CREATE INDEX customers_name_trgm_idx     ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX customers_address_trgm_idx  ON customers USING gin (address gin_trgm_ops);
CREATE INDEX customers_ip_idx            ON customers (ip_address);
-- Makes re-running an import idempotent: the second run updates rather than
-- creating a second copy of every customer.
CREATE UNIQUE INDEX customers_legacy_username_idx ON customers (legacy_username)
  WHERE legacy_username IS NOT NULL;
CREATE INDEX customers_legacy_group_idx ON customers (legacy_group);
CREATE INDEX customers_mac_idx           ON customers (mac_address);

-- === The recipient-integrity table ========================================
-- A WhatsApp number always belongs to exactly one customer record. The
-- composite UNIQUE below is the target of the composite FK on
-- whatsapp_notifications, which is what makes a cross-customer send
-- impossible at the storage layer rather than merely discouraged in code.
CREATE TABLE customer_whatsapp_numbers (
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  msisdn        msisdn NOT NULL,
  state         whatsapp_number_state NOT NULL DEFAULT 'UNVERIFIED',
  is_primary    boolean NOT NULL DEFAULT true,
  opted_out_at  timestamptz,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, msisdn)
);

-- One number cannot be shared across customers: prevents the classic
-- "two records, same phone" mis-send and doubles as duplicate detection.
CREATE UNIQUE INDEX customer_whatsapp_msisdn_unique
  ON customer_whatsapp_numbers (msisdn);

-- Exactly one primary number per customer.
CREATE UNIQUE INDEX customer_whatsapp_one_primary
  ON customer_whatsapp_numbers (customer_id) WHERE is_primary;

CREATE TABLE customer_notes (
  id            bigserial PRIMARY KEY,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  body          text NOT NULL,
  author_id     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON customer_notes (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Subscriptions, invoices, payments
-- ---------------------------------------------------------------------------

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  package_id        integer NOT NULL REFERENCES packages(id),
  monthly_price     money_pkr NOT NULL,       -- snapshot; may differ from package
  discount          money_pkr NOT NULL DEFAULT 0,
  started_on        date NOT NULL,
  ended_on          date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE UNIQUE INDEX subscriptions_one_current
  ON subscriptions (customer_id) WHERE ended_on IS NULL;
CREATE INDEX ON subscriptions (package_id);

CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no          text NOT NULL UNIQUE,        -- 'INV-2026-09-000124'
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id     uuid REFERENCES subscriptions(id),

  -- Snapshots. Editing a package later must never alter a past invoice.
  package_name        text NOT NULL,
  package_speed_mbps  integer NOT NULL,

  period_start        date NOT NULL,
  period_end          date NOT NULL,               -- == expiry date for the cycle
  due_date            date NOT NULL,

  amount              money_pkr NOT NULL,
  previous_balance    money_pkr NOT NULL DEFAULT 0,
  discount            money_pkr NOT NULL DEFAULT 0,
  total               money_pkr NOT NULL,
  amount_paid         money_pkr NOT NULL DEFAULT 0,

  status              invoice_status NOT NULL DEFAULT 'UNPAID',
  paid_at             timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start),
  CHECK (amount_paid <= total),
  CHECK ((status = 'PAID') = (paid_at IS NOT NULL))
);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

-- One invoice per customer per billing cycle. This is also the anchor for
-- notification duplicate-prevention below: invoice == billing cycle.
CREATE UNIQUE INDEX invoices_cycle_unique
  ON invoices (customer_id, period_start);

CREATE INDEX invoices_status_idx    ON invoices (status);
CREATE INDEX invoices_period_end_idx ON invoices (period_end);
CREATE INDEX invoices_due_open_idx  ON invoices (due_date)
  WHERE status IN ('UNPAID','PARTIALLY_PAID','OVERDUE');
CREATE INDEX invoices_customer_idx  ON invoices (customer_id, period_start DESC);

CREATE TABLE invoice_items (
  id            bigserial PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description   text NOT NULL,
  quantity      numeric(8,2) NOT NULL DEFAULT 1,
  unit_price    money_pkr NOT NULL,
  line_total    money_pkr NOT NULL
);
CREATE INDEX ON invoice_items (invoice_id);

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no        text NOT NULL UNIQUE,
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_id        uuid REFERENCES invoices(id),      -- NULL = advance/on-account
  amount            money_pkr NOT NULL CHECK (amount > 0),
  paid_on           date NOT NULL,
  method            payment_method NOT NULL,
  reference_no      text,
  notes             text,
  recorded_by       uuid NOT NULL REFERENCES users(id),
  reversed_at       timestamptz,
  reversal_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (customer_id, paid_on DESC);
CREATE INDEX ON payments (invoice_id) WHERE reversed_at IS NULL;
CREATE INDEX ON payments (paid_on) WHERE reversed_at IS NULL;

-- Payments are never hard-deleted; corrections are reversals, so revenue
-- reports over a closed period stay reproducible.

-- Dues are derived, not stored — a stored balance is a second source of truth.
CREATE VIEW customer_dues AS
SELECT
  c.id                                   AS customer_id,
  c.customer_code,
  c.full_name,
  c.area_id,
  i.id                                   AS invoice_id,
  i.invoice_no,
  i.due_date,
  i.period_end,
  (i.total - i.amount_paid)              AS amount_due,
  GREATEST(0, bi_now_karachi_date() - i.due_date) AS days_overdue
FROM customers c
JOIN invoices  i ON i.customer_id = c.id
WHERE c.deleted_at IS NULL
  AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')
  AND i.total > i.amount_paid;

-- ---------------------------------------------------------------------------
-- 6. WhatsApp templates and notifications
-- ---------------------------------------------------------------------------

CREATE TABLE whatsapp_templates (
  id                  serial PRIMARY KEY,
  code                text NOT NULL UNIQUE,      -- 'two_day_reminder'
  notification_type   notification_type NOT NULL,
  provider_name       text NOT NULL,             -- name registered with Meta
  language_code       text NOT NULL DEFAULT 'ur',
  body                text NOT NULL,
  variables           text[] NOT NULL DEFAULT '{}',
  is_active           boolean NOT NULL DEFAULT true,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Meta caps the template body at 1024 characters including emoji.
  CHECK (length(body) <= 1024)
);
CREATE TRIGGER wa_templates_touch BEFORE UPDATE ON whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

CREATE UNIQUE INDEX whatsapp_templates_one_active_per_type
  ON whatsapp_templates (notification_type, language_code) WHERE is_active;

-- === The central safety table ==============================================
CREATE TABLE whatsapp_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  customer_id         uuid NOT NULL,
  recipient_msisdn    msisdn NOT NULL,

  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  notification_type   notification_type NOT NULL,
  template_id         integer NOT NULL REFERENCES whatsapp_templates(id),

  -- Snapshots taken at queue time, from the SAME row-level read as the
  -- recipient. The worker never re-renders and never re-resolves a number.
  customer_name       text NOT NULL,
  rendered_body       text NOT NULL,
  -- Ordered provider parameters for {{1}},{{2}}... frozen at queue time.
  template_params     text[] NOT NULL DEFAULT '{}',
  expiry_date_shown   date NOT NULL,
  amount_due_shown    money_pkr,

  scheduled_for       timestamptz NOT NULL,
  sent_at             timestamptz,
  delivered_at        timestamptz,

  status              notification_status NOT NULL DEFAULT 'QUEUED',
  provider_message_id text,
  error_code          text,
  error_message       text,
  skip_reason         text,
  retry_count         smallint NOT NULL DEFAULT 0,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- >>> The constraint the whole design rests on. <<<
  -- The (customer, number) pair must exist as a registered number for THAT
  -- customer. A row pairing customer A with customer B's number cannot be
  -- inserted by any code path, migration, or manual statement.
  CONSTRAINT whatsapp_recipient_belongs_to_customer
    FOREIGN KEY (customer_id, recipient_msisdn)
    REFERENCES customer_whatsapp_numbers (customer_id, msisdn)
    ON DELETE RESTRICT,

  CONSTRAINT whatsapp_sent_has_provider_id
    CHECK (status <> 'SENT' OR provider_message_id IS NOT NULL),
  CONSTRAINT whatsapp_skipped_has_reason
    CHECK (status <> 'SKIPPED' OR skip_reason IS NOT NULL)
);
CREATE TRIGGER wa_notifications_touch BEFORE UPDATE ON whatsapp_notifications
  FOR EACH ROW EXECUTE FUNCTION bi_touch_updated_at();

-- Duplicate prevention. The invoice IS the billing cycle, so this reads as
-- "at most one reminder and one expiry warning per customer per cycle".
-- A worker restarting mid-sweep re-inserts, violates this, and skips —
-- idempotency by constraint rather than by careful coding.
CREATE UNIQUE INDEX whatsapp_one_per_cycle
  ON whatsapp_notifications (invoice_id, notification_type)
  WHERE status <> 'CANCELLED';

CREATE INDEX wa_notif_customer_idx  ON whatsapp_notifications (customer_id, created_at DESC);
CREATE INDEX wa_notif_status_idx    ON whatsapp_notifications (status, scheduled_for);
CREATE INDEX wa_notif_provider_idx  ON whatsapp_notifications (provider_message_id);
CREATE INDEX wa_notif_retry_idx     ON whatsapp_notifications (scheduled_for)
  WHERE status = 'FAILED' AND retry_count < 3;

-- Also validate the invoice actually belongs to the named customer, closing
-- the last theoretical mismatch (right number, wrong invoice).
CREATE OR REPLACE FUNCTION bi_check_notification_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE inv_customer uuid;
BEGIN
  SELECT customer_id INTO inv_customer FROM invoices WHERE id = NEW.invoice_id;
  IF inv_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION
      'Invoice % belongs to customer %, not % — refusing cross-customer notification',
      NEW.invoice_id, inv_customer, NEW.customer_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER whatsapp_notification_invoice_guard
  BEFORE INSERT OR UPDATE ON whatsapp_notifications
  FOR EACH ROW EXECUTE FUNCTION bi_check_notification_invoice();

-- ---------------------------------------------------------------------------
-- 7. Imports
-- ---------------------------------------------------------------------------

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          text NOT NULL,
  storage_path      text NOT NULL,
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  column_mapping    jsonb,
  status            import_batch_status NOT NULL DEFAULT 'UPLOADED',
  total_rows        integer NOT NULL DEFAULT 0,
  valid_rows        integer NOT NULL DEFAULT 0,
  incomplete_rows   integer NOT NULL DEFAULT 0,
  duplicate_rows    integer NOT NULL DEFAULT 0,
  error_rows        integer NOT NULL DEFAULT 0,
  imported_count    integer NOT NULL DEFAULT 0,
  updated_count     integer NOT NULL DEFAULT 0,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX ON import_batches (created_at DESC);

CREATE TABLE import_rows (
  id                bigserial PRIMARY KEY,
  batch_id          uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number        integer NOT NULL,
  raw               jsonb NOT NULL,
  normalized        jsonb,
  verdict           import_row_verdict NOT NULL,
  missing_fields    text[] NOT NULL DEFAULT '{}',
  duplicate_of      uuid REFERENCES customers(id),
  resolution        text,                       -- SKIP | UPDATE_EXISTING | CREATE_NEW
  error_message     text,
  created_customer  uuid REFERENCES customers(id),
  UNIQUE (batch_id, row_number)
);
CREATE INDEX ON import_rows (batch_id, verdict);

-- ---------------------------------------------------------------------------
-- 8. Audit log and settings
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_id      uuid REFERENCES users(id),      -- NULL = system/scheduler
  action        text NOT NULL,                  -- 'customer.update'
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  before_data   jsonb,
  after_data    jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX ON audit_logs (actor_id, created_at DESC);
CREATE INDEX ON audit_logs (created_at DESC);

-- Insert-only in practice: grant only INSERT/SELECT to the app role.
-- REVOKE UPDATE, DELETE ON audit_logs FROM bismillah_app;

CREATE TABLE system_settings (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  description   text,
  is_secret     boolean NOT NULL DEFAULT false,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Provider credentials do NOT live here. They come from the systemd
-- EnvironmentFile at /etc/bismillah/api.env (mode 0600). is_secret marks
-- values that must be redacted in API responses and logs, not encrypted-at-rest
-- substitutes for real secret storage.

COMMIT;

-- ===========================================================================
-- Seed: roles and permissions (idempotent)
-- ===========================================================================

BEGIN;

INSERT INTO roles (code, name, is_system) VALUES
  ('SUPER_ADMIN','Super Admin', true),
  ('ADMIN','Admin',             true),
  ('STAFF','Staff',             true),
  ('TECHNICIAN','Technician',   true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, description) VALUES
  ('customer:read',    'View customers'),
  ('customer:write',   'Create and edit customers'),
  ('customer:delete',  'Deactivate or soft-delete customers'),
  ('customer:tech',    'Edit technical connection fields'),
  ('package:read',     'View packages'),
  ('package:write',    'Create and edit packages'),
  ('invoice:read',     'View invoices'),
  ('invoice:write',    'Create, adjust or cancel invoices'),
  ('payment:read',     'View payments'),
  ('payment:write',    'Record payments'),
  ('payment:reverse',  'Reverse a recorded payment'),
  ('whatsapp:read',    'View notification logs and templates'),
  ('whatsapp:send',    'Trigger or retry a notification'),
  ('whatsapp:template','Edit WhatsApp templates'),
  ('import:run',       'Upload and commit customer imports'),
  ('report:read',      'View and export reports'),
  ('area:write',       'Manage areas'),
  ('user:manage',      'Manage staff accounts and roles'),
  ('audit:read',       'View audit logs'),
  ('settings:write',   'Change system settings')
ON CONFLICT (code) DO NOTHING;

-- SUPER_ADMIN: everything
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;

-- ADMIN: everything except user management and settings
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ADMIN'
  AND p.code NOT IN ('user:manage','settings:write')
ON CONFLICT DO NOTHING;

-- STAFF: customers and payments
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'STAFF'
  AND p.code IN ('customer:read','customer:write','package:read',
                 'invoice:read','payment:read','payment:write',
                 'whatsapp:read','report:read')
ON CONFLICT DO NOTHING;

-- TECHNICIAN: technical fields only
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code = 'TECHNICIAN'
  AND p.code IN ('customer:read','customer:tech','package:read')
ON CONFLICT DO NOTHING;

COMMIT;

-- ===========================================================================
-- Constraint verification — run these against a scratch database.
-- Each must FAIL. If any succeeds, the safety model is broken.
-- ===========================================================================
--
--  1. Cross-customer recipient:
--       INSERT INTO whatsapp_notifications (customer_id, recipient_msisdn, ...)
--       VALUES ('<customer A>', '<customer B''s number>', ...);
--       expected: violates whatsapp_recipient_belongs_to_customer
--
--  2. Wrong invoice for the customer:
--       ... customer_id = A, invoice_id = <B's invoice>
--       expected: raised by whatsapp_notification_invoice_guard
--
--  3. Duplicate reminder for one cycle:
--       two inserts, same invoice_id + TWO_DAY_REMINDER
--       expected: violates whatsapp_one_per_cycle
--
--  4. Un-normalized phone number:
--       INSERT ... msisdn '03001234567'
--       expected: violates domain msisdn check (needs +923001234567)
--
--  5. Over-length template:
--       INSERT INTO whatsapp_templates (body = repeat('ا', 1100), ...)
--       expected: violates the 1024-character check
--
--  6. Month-end billing math:
--       SELECT bi_cycle_end(31, 2026, 2);  -- 2026-02-28
--       SELECT bi_cycle_end(31, 2026, 3);  -- 2026-03-31, NOT 2026-03-28
--       SELECT bi_cycle_end(29, 2028, 2);  -- 2028-02-29
-- ===========================================================================
