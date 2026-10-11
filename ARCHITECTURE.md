# Bismillah Internet — ISP CRM, Billing & WhatsApp Automation

## Phase 1: Architecture

Target: Oracle Cloud Always Free Ampere A1 (ARM64, Ubuntu 24.04), single VM,
`Asia/Karachi` business timezone, 24/7 unattended operation.

---

## 1. Runtime topology (single VM)

```
                    DuckDNS (YOURSUB.duckdns.org → this VM IPv4)
                                  │
                                  ▼
  ┌───────────────────────────────────────────────────────────┐
  │  Ubuntu 24.04 · Ampere A1 (Always Free, ARM64)             │
  │                                                            │
  │  nginx :443 ──┬── /            → static React bundle       │
  │               └── /api         → api (Fastify, Node :3000) │
  │                                                            │
  │  systemd units:                                            │
  │    bi-api.service      Fastify HTTP                        │
  │    bi-worker.service   BullMQ workers (billing/whatsapp/…) │
  │    bi-scheduler.service BullMQ repeatable-job registrar    │
  │                                                            │
  │  postgres 16   listen 127.0.0.1 only                       │
  │  redis         listen 127.0.0.1 only, appendonly yes       │
  │                                                            │
  │  ufw + VCN: 22 (key auth only), 80, 443. Nothing else.     │
  └───────────────────────────────────────────────────────────┘
```

Only three processes matter for uptime. If the admin's laptop is off, the
`worker` and `scheduler` units keep running — nothing about the notification
path touches a browser.

**Scheduler vs worker split.** The scheduler process only *registers* BullMQ
repeatable jobs and exits its registration phase; Redis owns the cron state.
This means two scheduler instances cannot double-fire, and a restart re-registers
idempotently by `jobId`.

---

## 2. Repository layout

```
bismillah-crm/
├── apps/
│   ├── api/                 NestJS — HTTP + shared domain modules
│   │   └── src/modules/
│   │       ├── auth/        JWT access + refresh, argon2id
│   │       ├── rbac/        roles, permissions, guards
│   │       ├── customers/
│   │       ├── packages/
│   │       ├── subscriptions/
│   │       ├── billing/     invoice generation, cycle math
│   │       ├── payments/
│   │       ├── dues/        read-model over invoices
│   │       ├── imports/     xlsx/csv ingest
│   │       ├── whatsapp/    provider client, templates, send guard
│   │       ├── notifications/ scheduling + logging
│   │       ├── reports/
│   │       ├── areas/
│   │       ├── audit/
│   │       └── settings/
│   ├── worker/              BullMQ consumers, imports NestJS modules
│   └── web/                 React 19 + TS + Vite + Tailwind
├── packages/
│   ├── domain/              pure TS: date math, phone normalization,
│   │                        template rendering, eligibility rules
│   ├── contracts/           zod schemas + inferred DTO types (shared FE/BE)
│   └── db/                  drizzle schema + migrations
├── ops/
│   ├── nginx/  systemd/  backup/  README-deploy.md
└── docs/
```

`packages/domain` holds every rule that has money or a customer's phone number
attached to it, as pure functions with no I/O. That is what the test suite in
Phase 13 targets, and it is what makes billing-date and eligibility logic
verifiable without a database.

**ORM choice: Drizzle over TypeORM/Prisma.** Prisma's ARM64 query engine adds
memory overhead and fights the composite-FK design below; Drizzle emits plain
SQL, supports composite foreign keys and partial unique indexes natively, and
lets the schema file *be* the migration source.

---

## 3. The recipient-integrity design

Section 61 of the spec asks that mis-sends be "technically difficult or
impossible." That should be a database constraint, not a code convention.

WhatsApp numbers live in their own table:

```
customer_whatsapp_numbers (customer_id, msisdn, ...)
    UNIQUE (customer_id, msisdn)
```

Every notification row carries a **composite foreign key**:

```
whatsapp_notifications (customer_id, recipient_msisdn, ...)
    FOREIGN KEY (customer_id, recipient_msisdn)
        REFERENCES customer_whatsapp_numbers (customer_id, msisdn)
```

The consequence: a row pairing customer A with customer B's number cannot be
inserted. Not by a buggy job, not by an import, not by a hand-written SQL
statement. The provider client is then written so that its **only** input is a
`whatsapp_notifications.id` — it reads the recipient and the rendered body from
the row it was given and has no parameter for an arbitrary number.

The same rule covers dynamic values. The rendered message body is frozen into
the notification row at queue time, generated from a single `SELECT` against
one customer's invoice. There is no path where a template is rendered with one
customer's data and dispatched against another's number, because the render and
the recipient come from the same row insert.

Duplicate protection is likewise structural:

```
UNIQUE INDEX ON whatsapp_notifications (invoice_id, notification_type)
    WHERE status <> 'CANCELLED'
```

The invoice *is* the billing cycle, so this expresses "one two-day reminder and
one final expiry warning per cycle" exactly. A worker restart mid-batch retries
the insert, hits the constraint, and skips — idempotent by construction.

---

## 4. Billing and expiry date math

Never `date + interval '1 month'` on a stored expiry — that silently walks
31 Jan → 28 Feb → 28 Mar and loses the customer's real billing day.

Store an immutable `billing_anchor_day` (1–31) on the customer. Each cycle is
computed from the anchor, not from the previous expiry:

```
expiry(anchor, year, month) = make_date(year, month,
                                LEAST(anchor, days_in_month(year, month)))
```

31 Jan → 28 Feb (or 29 in a leap year) → **31 Mar**, not 28 Mar. The SQL helper
`bi_cycle_end()` in the schema implements this, and the same function is
mirrored in `packages/domain` so the API and the database agree.

All scheduler comparisons run on `date` values in `Asia/Karachi`, obtained via
`(now() AT TIME ZONE 'Asia/Karachi')::date` — never the browser's timezone, and
never a naive UTC date, which would fire the midnight job five hours early.

**Midnight means 00:00.** The final expiry job runs at `0 0 * * *` Asia/Karachi
— the first minute of the expiry date. The UI must render this as
"12:00 AM (Midnight)"; the API stores and returns 24-hour `00:00` to avoid the
AM/PM ambiguity entirely.

---

## 5. Notification pipeline

```
scheduler (cron, Asia/Karachi)
   │
   ├── 09:00  two-day reminder sweep
   │     SELECT customers WHERE cycle_end = today + 2
   │       AND invoice.status IN (UNPAID, PARTIALLY_PAID, OVERDUE)
   │       AND whatsapp number verified AND opted in
   │       AND customer.status NOT IN (INACTIVE, INCOMPLETE)
   │
   └── 00:00  final expiry sweep
         SELECT customers WHERE cycle_end = today  (same guards)
   │
   ▼
INSERT whatsapp_notifications  → status QUEUED, body rendered & frozen
   │   (composite FK + partial unique index enforce correctness here)
   ▼
BullMQ 'whatsapp' queue, job payload = { notificationId }
   │
   ▼
worker: RE-CHECK payment status  ← spec §25: the bill may have been
   │                                 paid between queue and send
   ├── still unpaid → provider POST → SENT + provider_message_id
   └── now paid     → status SKIPPED, reason 'PAID_BEFORE_SEND'
   │
   ▼
provider delivery webhook → DELIVERED / FAILED
   │
   └── FAILED + retryable → backoff retry, max 3, then terminal FAILED
```

The re-check before dispatch is the part most implementations get wrong. The
sweep and the send are minutes apart; a cash payment recorded at the counter in
that window must suppress the message.

---

## 6. Import pipeline

Uploads never parse inline in the HTTP request. The endpoint writes the file to
`/var/lib/bismillah/imports/{batch_id}`, creates an `import_batches` row, and
enqueues. The worker streams rows into `import_rows` with a per-row validation
verdict, then the UI shows the preview (total / valid / incomplete / duplicate /
error) and the admin commits or cancels. Commit is a second job that promotes
`import_rows` into `customers`.

Missing data does not reject a row. Per spec §30, the customer is created with
`status = INCOMPLETE` and a `missing_fields text[]`, which drives both the
warning badge and the "Incomplete" navigation filter. Nothing is invented to
fill a gap.

Duplicate detection keys on normalized `msisdn` first, then `customer_code`,
then trigram similarity on `name` scoped to the same `area_id`.

---

## 7. Security posture

- argon2id password hashing; JWT access (15 min) + rotating refresh (30 d,
  stored hashed, revocable per-session).
- RBAC as permission strings (`customer:write`, `payment:refund`,
  `whatsapp:send`), roles are named bundles. Guards check permissions, never
  role names — so a new role never requires touching a controller.
- Provider credentials and DB passwords live in a systemd
  `EnvironmentFile` at `/etc/bismillah/api.env`, mode `0600`, owned by the
  service user. Nothing secret enters the repository or the `system_settings`
  table in plaintext.
- Rate limiting at nginx (connection/req zones) and in-app on `/auth/*`.
- Postgres and Redis bind to loopback only; no public port beyond 22/80/443.
- Audit log rows are insert-only; no `UPDATE`/`DELETE` grant on `audit_logs`
  for the application role.

---

## 8. Two findings that need a decision before Phase 9

### 8.1 Both message templates exceed WhatsApp's limit

Meta's template body is capped at 1,024 characters, counting letters, numbers,
special characters and emoji. Measured with markdown converted to WhatsApp
formatting and the `---` rules removed:

| Template            | Characters | Limit | Status  |
|---------------------|-----------:|------:|---------|
| Two-day reminder    |      1,219 | 1,024 | Over    |
| Final expiry notice |      ~1,150 | 1,024 | Over    |

Also inapplicable inside a template body: `#` headings, `*` bullet lists and
`---` horizontal rules do not render — WhatsApp supports only bold, italic,
strikethrough and monospace. Tabs and runs of more than four spaces cause
rejection at review.

Each template needs roughly 200 characters removed. The cheapest cuts, in order:
collapse the three identical payment numbers into one line
(`JazzCash / EasyPaisa / Raast: 0335-7287782`), drop the duplicated greeting,
and shorten the English paragraph, which currently restates the Urdu one at
full length. A trimmed final-expiry variant preserving every functional element
measures 617 characters, leaving generous headroom.

Recommendation: keep the full text as the CRM's stored template and submit the
trimmed version to Meta, or split into header + body + footer, which buys 120
extra characters (60 + 60) outside the body count.

### 8.2 The HTTPS URL requirement

Meta announced that from 1 January 2026 templates must carry a valid,
verifiable HTTPS URL in the body or in a call-to-action button. Neither
template currently has one. Since the ISP will have a domain anyway for the
CRM, the natural fix is a customer-facing bill page — a CTA button pointing at
`https://<domain>/pay/{{2}}` with a per-invoice token — which also gives
customers somewhere to upload the payment receipt instead of WhatsApping it
manually. Verify this against Meta's current documentation before submission,
as template policy changes frequently.

Both items are provider-side constraints, so they block template approval
rather than development. Phases 2–8 can proceed in parallel.

---

## 9. Phase sequence and gate criteria

| Phase | Deliverable | Gate |
|-------|-------------|------|
| 1 | Architecture | this document |
| 2 | Schema + migrations | `schema.sql` applies clean; constraint tests pass |
| 3 | Auth + RBAC | permission guard blocks an under-privileged token |
| 4 | Customer CRM | full CRUD + soft delete preserves invoices |
| 5 | Packages | price change does not mutate historical invoices |
| 6 | Billing | month-end/leap-year suite green |
| 7 | Payments + dues | payment updates invoice, customer status, audit |
| 8 | Excel import | 1,250-row fixture: preview counts match commit results |
| 9 | WhatsApp provider | sandbox send with frozen body |
| 10 | Automation | worker kill mid-batch produces zero duplicates |
| 11 | Reports | exports match dashboard aggregates |
| 12 | Dashboard/UI polish | — |
| 13 | Testing | domain package at full branch coverage |
| 14 | Security | dependency audit, header scan, secret scan |
| 15 | Deployment | reboot the VM; notifications still fire |

Phase 10's gate is the one that matters most: kill `bi-worker` mid-sweep,
restart it, and confirm no customer received two messages.
