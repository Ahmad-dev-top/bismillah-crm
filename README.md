# Bismillah Internet CRM

Operations system for **Bismillah Super Storm Fiber** (Lahore). Staff use it to keep customer records, issue monthly invoices, record payments, and send WhatsApp reminders before a connection expires. The business clock is **Asia/Karachi**.

The service is live at [http://bismillah-crm.duckdns.org](http://bismillah-crm.duckdns.org).

## What it does

- Customer records, search, profile, soft delete, and restore.
- Service packages and areas. A package edit never rewrites invoices already issued; each invoice stores the name, speed, and price from the moment it was created.
- Monthly billing on the customer's own anchor day. A customer who expires on the 31st stays on the 31st after February, instead of sliding to the 28th forever.
- Payments applied oldest invoice first. What a customer owes is a view over invoices, not a second balance stored beside them.
- Excel import of the legacy PPPoE export: inspect, map columns, preview, then commit. Re-running the import matches `legacy_username` and does not create duplicates.
- WhatsApp Cloud API reminders: two days before expiry (09:00) and at midnight on the expiry date. Failed sends retry hourly inside a 24-hour window.

A customer with no package or price stays `INCOMPLETE`. Incomplete customers are not billed and are not messaged. The system does not invent a price, a phone number, or an expiry date to fill a gap.

## Production

The app runs on an Oracle Cloud Ubuntu VM. nginx listens on port 80 and chooses the site by hostname, so this CRM and the portfolio site can share the machine.

| Piece | Where it runs |
| --- | --- |
| Web UI | Static build of `apps/web`, served by nginx for `bismillah-crm.duckdns.org` |
| API | `bi-api.service` — Fastify on `127.0.0.1:3010` |
| Worker | `bi-worker.service` — BullMQ consumers |
| Scheduler | `bi-scheduler.service` — registers the timetable in Redis, then exits |
| PostgreSQL | `127.0.0.1:5432` only, database `bismillah` |
| Redis | `127.0.0.1:6379` only, `appendonly yes`, eviction `noeviction` |

Secrets live in `/etc/bismillah/api.env` (`chmod 640`, `root:bismillah`). They are not in this repository and not in the database.

WhatsApp is in **dry-run**. Every send path runs and logs the payload. Nothing is delivered to Meta until `WHATSAPP_DRY_RUN` is turned off and the templates are approved. The production database has the schema and a staff login. Customer rows are loaded only when an operator imports them.

TLS is not configured yet. Sign-in travels over HTTP until a certificate is issued for the hostname. Step-by-step host setup is in [`ops/DEPLOY.md`](ops/DEPLOY.md). When adding nginx on this VM, do not mark the CRM server block as `default_server`; the portfolio hostname must keep that role.

## Guarantees

These are database constraints. A bug in a route or a hand-written query cannot bypass them.

**A message can only go to a number that belongs to that customer.**

```sql
whatsapp_notifications (customer_id, recipient_msisdn)
  REFERENCES customer_whatsapp_numbers (customer_id, msisdn)
```

A row that pairs customer A with customer B's number is rejected. A trigger also rejects a notification whose invoice belongs to someone else. `sendNotification()` takes a notification id and re-reads the recipient from that row. There is no function that accepts a phone number and sends it.

**One reminder per invoice per type.** A partial unique index on `(invoice_id, notification_type)` treats the invoice as the billing cycle. If a worker dies mid-sweep and retries, the constraint skips the duplicate.

**One WhatsApp number, one customer.**

**Money is integer paisa** inside the domain layer (`rupeesToPaisa` / `paisaToRupees`). Billing decisions use the Karachi calendar date (`todayInKarachi()`, `bi_now_karachi_date()`), never the server's UTC date and never the browser's timezone. Month arithmetic goes through `bi_cycle_end` / `@bi/domain`. Do not write `date + interval '1 month'` in a billing path.

Phone numbers are stored as E.164 after `normalizeMsisdn()`.

## Stack

Node.js 22 (native TypeScript stripping, no compile step to run the API), Fastify 5, PostgreSQL, Redis, BullMQ, React 19, Vite, Tailwind CSS 4. Passwords are argon2id. Requests are validated with Zod. SQL is written with the `postgres` driver and tagged templates. There is no ORM.

`packages/domain` has no I/O and no framework. Every rule that touches money, a phone number, a billing date, or a WhatsApp template lives there so it can be tested without a database.

## Layout

```
apps/api/          Fastify HTTP API and services
apps/worker/       BullMQ consumers and the scheduler
apps/web/          React staff UI
packages/domain/   Billing, phone, date, and template rules
ops/schema.sql     Database schema, roles, and constraints
ops/systemd/       bi-api, bi-worker, bi-scheduler
ops/nginx/         HTTP and TLS site files
ops/backup/        Nightly pg_dump with a restore check
ops/DEPLOY.md      Host setup
scripts/           Customer import and the first staff user
test/              Integration tests (sweeps and import)
```

Staff UI routes: sign-in, dashboard, customers (list, create, profile, edit), packages, areas, settings.

## Schedule

Redis holds the timetable. Restarting the scheduler re-registers the same jobs and does not fire a catch-up burst. All times are Asia/Karachi.

| Time | Job |
| --- | --- |
| 00:00 | Expiry-day reminder |
| 00:30 | Generate invoices and refresh status |
| 09:00 | Two-day reminder |
| Every hour at :15 | Retry transient failures still inside their 24-hour window |

The two-day reminder is at 09:00 because a billing message at 03:00 is treated as spam and hurts the WhatsApp template's quality rating.

## Local development

Requires Node 22, PostgreSQL, and Redis.

```bash
npm install
createdb bismillah
psql -d bismillah -f ops/schema.sql
cp .env.example .env
```

Fill `DATABASE_URL` and set `JWT_SECRET` to at least 32 random bytes (`openssl rand -base64 48`). Leave `WHATSAPP_DRY_RUN=true`.

```bash
npm test

createdb bi_test && psql -d bi_test -f ops/schema.sql
TEST_DATABASE_URL=postgres://localhost/bi_test \
  node --test --experimental-strip-types test/*.test.ts

npm run dev -w @bi/api
npm run dev -w @bi/web
```

The web dev server is [http://localhost:5173](http://localhost:5173) and proxies `/api` to port 3000. Create the first staff user with:

```bash
ADMIN_EMAIL=admin@localhost ADMIN_PASSWORD='choose-a-long-password' \
  node --env-file=.env --experimental-strip-types scripts/create-local-admin.ts
```

On a machine that is reachable from the internet, `ADMIN_PASSWORD` is required. The script will not fall back to a built-in password there.

### Importing customers

```bash
DATABASE_URL=postgres://... \
  node --experimental-strip-types scripts/import-customers.ts customers.xlsx
```

That prints a preview and writes nothing. Add `--commit` to write. The source export used for development had four usable columns (serial, PPPoE username, phone, expiry) and no package or price, so imported rows stay `INCOMPLETE` until a package is assigned. `legacy_group` is the numeric prefix on the PPPoE username and is the key for bulk package assignment (`POST /api/customers/bulk-assign-package`).

## Configuration

Copy `.env.example`. Production reads `/etc/bismillah/api.env` instead.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `PG_POOL_MAX` | API pool size |
| `JWT_SECRET` | Signs staff sessions |
| `PORT` | API port. Production uses `3010` |
| `LISTEN_HOST` | Bind address. Production uses `127.0.0.1` |
| `CORS_ORIGINS` | Browser origins allowed to call the API |
| `WHATSAPP_DRY_RUN` | `true` logs sends and does not call Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number id |
| `WHATSAPP_ACCESS_TOKEN` | Meta access token |
| `WHATSAPP_APP_SECRET` | Verifies webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification |
| `WHATSAPP_API_VERSION` | Graph API version, default `v21.0` |
| `TZ` | `Asia/Karachi` |

## WhatsApp templates

Template bodies are capped at 1,024 characters. `validateTemplateBody()` checks that limit, and it rejects Markdown headings, horizontal rules, and star bullets, which WhatsApp does not render and which Meta rejects in review. Meta also expects a verifiable HTTPS link or a call-to-action button in the body. Validate before submitting a template. Both of the original reminder drafts were over the limit.

## Roles

The schema seeds four roles: `SUPER_ADMIN`, `ADMIN`, `STAFF`, and `TECHNICIAN`. Routes check a permission code (`customer:read`, `customer:write`, `package:write`, `payment:write`, and the rest). `user:manage` and `settings:write` are not granted to every role.

## Backups

`ops/backup/pg-backup.sh` is intended to run at 02:00 Asia/Karachi. It dumps the database and checks that the archive has a table of contents. Restore with:

```bash
pg_restore -d bismillah --clean --if-exists <file>.dump
```

Practice that restore against a throwaway database. A dump that has never been restored is not a backup.

## Not finished

- HTTPS for `bismillah-crm.duckdns.org`.
- Customer import on the production database. The tooling is in the repo; the live database does not contain the legacy list until someone commits an import and assigns packages.
- Reports (revenue, dues, expiry, package) and file export.
- Refresh tokens, logout, and staff-user administration screens.
- Excel upload from the browser. The command-line import and the parser are done; the HTTP upload endpoints are not.
- Approved WhatsApp templates, and turning dry-run off.

## Tests

```bash
npm test
```

That runs the domain suite (billing dates, money, phone numbers, eligibility, templates) with no database. The files in `test/` need `TEST_DATABASE_URL` pointing at an empty database that has had `ops/schema.sql` applied. They cover notification sweeps and the Excel import.
