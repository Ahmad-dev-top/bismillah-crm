# HANDOFF — Bismillah Internet ISP CRM

Everything an AI assistant or a new developer needs to pick this up. Read
`.cursor/rules/bismillah.mdc` first — it holds the invariants that must not be
broken. This file is the map and the task list.

---

## 1. What this is

A production ISP CRM for **Bismillah Super Storm Fiber**, Lahore. It manages
customers, recurring monthly billing, payments and dues, and sends automated
WhatsApp reminders two days before a customer's expiry and again at midnight
on the expiry date.

- Business timezone: **Asia/Karachi**
- Target host: Oracle Cloud Always Free **Ampere A1** (ARM64, Ubuntu 24.04)
- Stack: Node 22 (native TS stripping, no build step in dev), Fastify,
  PostgreSQL 16, Redis + BullMQ, React (not yet started), nginx
- **548 real customers are already loaded.**

### The one rule the whole design exists to enforce

A customer must never receive another customer's data. This is enforced by a
**composite foreign key**, not by careful coding:

```sql
whatsapp_notifications (customer_id, recipient_msisdn)
  REFERENCES customer_whatsapp_numbers (customer_id, msisdn)
```

Pairing customer A with customer B's number cannot be inserted by any code
path, migration, or hand-written SQL. Duplicate messages are prevented by a
partial unique index on `(invoice_id, notification_type)` — the invoice *is*
the billing cycle, so a worker killed mid-sweep retries, hits the constraint,
and skips.

---

## 2. Current state

| Phase | Status | Notes |
|-------|--------|-------|
| 1 Architecture | Done | `ARCHITECTURE.md` |
| 2 Database | Done | `ops/schema.sql` — 20 tables, applies clean, constraints verified |
| 3 Auth & RBAC | Mostly | argon2id + JWT + permission guards. **No refresh, no logout, no user CRUD.** |
| 4 Customer CRM | Done | CRUD, search, profile, soft delete |
| 5 Packages | Partial | Schema + invoice snapshots done. **No admin routes.** |
| 6 Billing | Done | Anchored cycles, invoice generation, derived status |
| 7 Payments & dues | Done | Oldest-first allocation, `customer_dues` view |
| 8 Excel import | Done | Parser, mapper, preview, commit, CLI. **No REST endpoints.** |
| 9 WhatsApp provider | Written, unrun | Cloud API client + signed webhook. Never called Meta. |
| 10 Automation | Done | Sweeps, worker, scheduler, retry |
| 11 Reports | **Not started** | |
| 12 Frontend | **Not started** | API is complete and documented |
| 13 Testing | 72 passing | 55 domain + 7 sweep + 10 import |
| 14 Security | Written, unaudited | Headers, rate limits, hardened units. No dep/secret scan run. |
| 15 Deployment | Configs only | systemd + nginx + backups. **No step-by-step runbook.** |

### Honest tiering

- **Verified by execution:** `packages/domain` (55 tests), the schema and its
  constraints, the notification sweeps (7 integration tests against real
  PostgreSQL), the Excel import (10 tests against the real 548-row file).
- **Written but never run:** API server (never booted), worker (never
  connected to Redis), WhatsApp client (never called Meta), all ops configs
  (never deployed). Expect bugs on first deploy.

---

## 3. The customer data situation

The source export had only four usable columns: serial, PPPoE username,
phone, expiry date. No header row; data starts at row 9.

After import:

| | |
|---|---|
| Customers | 548 |
| WhatsApp numbers attached | 501 |
| Billing anchor days derived | 548 |
| Invoices | **0** |
| Status | **all 548 INCOMPLETE** |

**Nothing can be billed or messaged yet.** Package and price are missing on
all 548 rows, and the eligibility gate blocks `INCOMPLETE` customers from
notifications. This is deliberate — inventing a price would be worse.

Two extra columns hold provenance:
- `legacy_username` — the exact PPPoE string, used to match a CRM record back
  to the router account and to make re-imports idempotent.
- `legacy_group` — the numeric prefix on those usernames (`10` in
  `10mwaseem`). **15 distinct groups.** If each group maps to one package,
  prices can be backfilled in 15 UPDATEs rather than 548 manual edits.

Also outstanding in the data: **47 customers have no usable phone** (12 blank,
5 missing a digit, 30 whose number belongs to another customer), and **545 of
548 expiry dates are already in the past**. Switching on the schedulers
against this data would target nearly the whole customer base at once.

---

## 4. Running it

```bash
npm install

createdb bismillah
psql -d bismillah -f ops/schema.sql

cp .env.example .env        # then edit; JWT_SECRET: openssl rand -base64 48

npm test                    # 55 domain tests, no database needed

# integration tests
createdb bi_test && psql -d bi_test -f ops/schema.sql
TEST_DATABASE_URL=postgres://localhost/bi_test \
  node --test --experimental-strip-types --test-timeout=200000 test/*.test.ts

# load customers (preview first, --commit to write; idempotent)
DATABASE_URL=postgres://localhost/bismillah \
  node --experimental-strip-types scripts/import-customers.ts customers.xlsx

npm run dev -w @bi/api
node --experimental-strip-types apps/worker/src/scheduler.ts
node --experimental-strip-types apps/worker/src/index.ts
```

Keep `WHATSAPP_DRY_RUN=true` until templates are approved. Every send path
runs end to end and logs the exact payload without contacting Meta.

---

## 5. Ready-to-paste task prompts

Each block is self-contained. Give Cursor one at a time, in this order.

### Task A — Import REST endpoints

```
Add REST endpoints for the Excel import in apps/api/src/modules/import.routes.ts,
following the pattern in customers.routes.ts.

The parsing, preview and commit logic already exists in import.service.ts —
inspectSheet(), parseWorkbook(), commitImport(). Do not reimplement it.

Endpoints, all guarded by requirePermission("import:run"):
  POST /api/imports          multipart upload; write the file to
                             /var/lib/bismillah/imports/{batchId}, create an
                             import_batches row, return batchId + inspectSheet()
  GET  /api/imports/:id      batch status and stored column mapping
  POST /api/imports/:id/map  accept the operator's ColumnMapping and DateFormat,
                             run parseWorkbook, persist rows into import_rows,
                             return the ImportPreview counts
  POST /api/imports/:id/commit  run commitImport, update the batch counters
  GET  /api/imports/:id/errors  CSV export of ERROR and DUPLICATE rows

Requirements:
- Parsing must NOT happen in the HTTP request. Enqueue to the "imports" BullMQ
  queue (see apps/worker/src/queues.ts, ImportJob) and add the consumer in
  apps/worker/src/index.ts.
- Date format is chosen by the operator and never sniffed.
- Add tests in test/ that exercise upload -> map -> preview -> commit.
```

### Task B — Package, area and user admin routes

```
Add apps/api/src/modules/admin.routes.ts with CRUD for packages, areas and
users, following customers.routes.ts for structure and guard style.

- packages: create, edit, deactivate, reactivate. Guard package:write.
  Editing a package must NEVER alter historical invoices — they snapshot
  package_name and package_speed_mbps at issue time. Add a test proving this.
- areas: create, rename, deactivate, plus per-area customer/revenue stats.
- users: create, edit, change role, deactivate. Guard user:manage.
  Passwords hashed with argon2id. Never return password_hash.

Also add the missing auth endpoints in server.ts:
  POST /api/auth/refresh   rotate the refresh token; store only its hash in
                           refresh_tokens; revoke the old row
  POST /api/auth/logout    revoke the current refresh token

Every mutation writes an audit_logs row with before_data and after_data.
```

### Task C — Bulk price backfill

```
Add a route and a CLI script to assign packages and prices in bulk to the
548 INCOMPLETE customers, keyed on customers.legacy_group (15 distinct values).

  POST /api/customers/bulk-assign-package
  body: { legacyGroup: string, packageId: number, monthlyPrice: number }

For each matched customer: create a subscriptions row, recompute
missing_fields, and flip status from INCOMPLETE to ACTIVE only when nothing
is missing. Return a dry-run count first; require an explicit confirm flag
to write. Write one audit_logs row per customer.

Do not invent prices. If monthlyPrice is absent, reject the request.
```

### Task D — React frontend

```
Build the React 19 + TypeScript + Vite + Tailwind frontend in apps/web.

UI language is ENGLISH ONLY — no RTL, no i18n framework. Urdu appears only
inside WhatsApp message templates, which are data, not UI.

Screens, in build order:
 1. Login
 2. Dashboard — consumes GET /api/dashboard as-is
 3. Customers list — server-side pagination, search, status/area/package
    filters, expiring-in-N-days filter. Never load all 548 into the browser.
 4. Customer profile — the six sections returned by GET /api/customers/:id
 5. Add/edit customer — show missing_fields prominently as an INCOMPLETE badge
 6. Record payment
 7. Dues centre — GET /api/dues
 8. WhatsApp notification centre — filters, message preview, retry button
 9. Template editor — call POST /api/templates/validate on every keystroke and
    show the live character count against the 1024 limit
10. Import wizard — upload, column mapping, preview counts, commit
11. Packages / areas / users admin

Design: deep navy, black, electric blue, emerald; red-orange for warnings.
Professional SaaS, restrained colour. Read /mnt/skills/public/frontend-design
if available.

Constraints:
- JWT in memory, not localStorage.
- Every destructive action gets a confirmation dialog.
- Show loading, empty and error states for every list.
- The expiry notification time must render as "12:00 AM (Midnight)".
```

### Task E — Reports

```
Add apps/api/src/modules/reports.routes.ts. All aggregation in SQL, never in
JavaScript over fetched rows.

  GET /api/reports/customers   totals by status
  GET /api/reports/revenue     daily/weekly/monthly/yearly, from payments
                               where reversed_at IS NULL
  GET /api/reports/dues        outstanding, overdue, customer count
  GET /api/reports/expiry      today, tomorrow, 2 days, 7 days, this month
  GET /api/reports/packages    customers and revenue per package

Each supports ?format=json|csv|xlsx. Use the xlsx package already installed.
All date bucketing in Asia/Karachi — use bi_now_karachi_date(), never UTC.
Guard report:read. Add tests asserting report totals match the dashboard.
```

### Task F — Deployment runbook

```
Write ops/DEPLOY.md: a step-by-step runbook for Oracle Cloud Ampere A1,
Ubuntu 24.04, ARM64. Assume the reader has a fresh VM and nothing else.

Cover: user and directory creation, Node 22 on ARM64, PostgreSQL 16 and Redis
(both bound to 127.0.0.1 only), ufw (22/80/443 only), SSH key-only auth,
deploying to /opt/bismillah/current, /etc/bismillah/api.env at mode 0600,
running ops/schema.sql, installing the three systemd units, nginx + certbot,
DuckDNS (not Cloudflare), log rotation, the backup cron, and a restore drill.

End with a verification checklist. The last item must be: reboot the VM and
confirm notifications still fire without anyone logging in.
```

---

## 6. Blocked on Meta, not on code

WhatsApp is **not set up at all yet**, and it is the longest lead time in the
project. The chain is: Meta Business Portfolio → business verification → WABA
→ register a number → display name approval → submit templates → approval.
Two of those are human reviews at Meta. Start it in parallel with development.

Three things to get right:

1. **Use a separate new number for automated sending.** Meta's docs state that
   numbers already in use with WhatsApp cannot be registered unless deleted
   first, and deleting loses the message history and locks you out of the
   Business app for that number. 0335-7287782 is the human receipt line and
   should stay that way.
2. **Both supplied templates exceed the 1024-character body limit** (two-day
   reminder measured at 1,219). Markdown headings, `---` rules and `*` bullets
   do not render in WhatsApp and cause review rejection. Meta also requires a
   verifiable HTTPS URL in the body or a CTA button.
   `POST /api/templates/validate` reports exactly how many characters to cut.
3. **A webhook cannot send messages.** It is inbound only — delivery receipts
   and incoming replies. It is already built and signature-verified. Sending
   still requires the full Cloud API chain above.

---

## 7. Suggested order

1. Task C (prices) — without it nothing can be billed or messaged
2. Task A (import endpoints) — so staff stop needing the CLI
3. Task D (frontend) — largest chunk; unblocks everyone else
4. Task B (admin routes)
5. Task E (reports)
6. Task F (deploy) — once there is something worth deploying

Tasks A, B, C and E are each a session's work. Task D is several.
