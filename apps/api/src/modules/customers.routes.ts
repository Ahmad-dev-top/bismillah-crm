/** Customer CRUD, search and profile. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sql } from "../db/index.ts";
import { normalizeMsisdn, todayInKarachi } from "@bi/domain";
import { requirePermission } from "../server.ts";
import {
  bulkAssignPackage,
  bulkAssignSchema,
  BulkAssignError,
} from "./bulk-assign.service.ts";
import { computeMissingFields } from "./completeness.ts";
import { refreshCustomerStatus } from "./billing.service.ts";

const customerCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, numbers, dots, hyphens, or underscores");

const customerSchema = z.object({
  customerCode: customerCodeSchema.optional(),
  fullName: z.string().min(1).max(200),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  cnic: z
    .string()
    .trim()
    .optional()
    .nullable()
    .refine((v) => !v || /^\d{5}-\d{7}-\d$/.test(v), "CNIC must look like 35202-1234567-1"),
  address: z.string().max(500).optional(),
  areaId: z.number().int().optional().nullable(),
  packageId: z.number().int().optional().nullable(),
  monthlyPrice: z.number().nonnegative().optional().nullable(),
  billingAnchorDay: z.number().int().min(1).max(31).optional().nullable(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  installationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  connectionType: z.enum(["FIBER","PTP_WIRELESS","CABLE","OTHER"]).optional().nullable(),
  ipAddress: z.string().ip().optional().nullable().or(z.literal("")),
  macAddress: z.string().optional().nullable(),
  routerModel: z.string().optional().nullable(),
  onuSerial: z.string().optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

async function nextCustomerCode(sql: Sql): Promise<string> {
  const [row] = await sql<{ n: string }[]>`
    SELECT COALESCE(MAX(SUBSTRING(customer_code FROM '[0-9]+$')::int), 0) + 1 AS n
      FROM customers WHERE customer_code LIKE 'BI-%'`;
  return "BI-" + String(Number(row?.n ?? 1)).padStart(6, "0");
}

type PurgeCounts = {
  customers: number;
  notifications: number;
  payments: number;
  invoices: number;
  subscriptions: number;
};

/** Child tables use ON DELETE RESTRICT, so they must go before the customer row. */
async function deleteCustomerDependents(tx: Sql, customerId: string | null): Promise<Omit<PurgeCounts, "customers">> {
  const notifications = customerId
    ? await tx`DELETE FROM whatsapp_notifications WHERE customer_id = ${customerId} RETURNING 1`
    : await tx`DELETE FROM whatsapp_notifications RETURNING 1`;
  const payments = customerId
    ? await tx`DELETE FROM payments WHERE customer_id = ${customerId} RETURNING 1`
    : await tx`DELETE FROM payments RETURNING 1`;
  const invoices = customerId
    ? await tx`DELETE FROM invoices WHERE customer_id = ${customerId} RETURNING 1`
    : await tx`DELETE FROM invoices RETURNING 1`;
  const subscriptions = customerId
    ? await tx`DELETE FROM subscriptions WHERE customer_id = ${customerId} RETURNING 1`
    : await tx`DELETE FROM subscriptions RETURNING 1`;
  if (customerId) {
    await tx`DELETE FROM customer_whatsapp_numbers WHERE customer_id = ${customerId}`;
    await tx`DELETE FROM customer_notes WHERE customer_id = ${customerId}`;
    await tx`UPDATE import_rows SET created_customer = NULL WHERE created_customer = ${customerId}`;
    await tx`UPDATE import_rows SET duplicate_of = NULL WHERE duplicate_of = ${customerId}`;
  } else {
    await tx`DELETE FROM customer_whatsapp_numbers`;
    await tx`DELETE FROM customer_notes`;
    await tx`UPDATE import_rows SET created_customer = NULL, duplicate_of = NULL`;
  }
  return {
    notifications: notifications.length,
    payments: payments.length,
    invoices: invoices.length,
    subscriptions: subscriptions.length,
  };
}

function firstIssueMessage(parsed: { error: z.ZodError }, fallback: string): string {
  const codeIssue = parsed.error.issues.find((i) => i.path[0] === "customerCode");
  if (codeIssue) return codeIssue.message;
  const first = parsed.error.issues[0];
  if (!first) return fallback;
  const field = String(first.path[0] ?? "");
  return field ? `${field}: ${first.message}` : first.message;
}

function uniqueViolationKind(err: unknown): "customer_code" | "whatsapp" | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  if ((err as { code: string }).code !== "23505") return null;
  const constraint = (err as { constraint?: string }).constraint ?? "";
  if (constraint.includes("customer_code")) return "customer_code";
  return "whatsapp";
}

export async function registerCustomerRoutes(app: FastifyInstance, sql: Sql) {
  /**
   * Assign a package and price to every INCOMPLETE customer in a legacy_group.
   * Dry-run unless confirm is true. monthlyPrice is required — never taken
   * from the package list price.
   */
  app.post("/api/customers/bulk-assign-package",
    { preHandler: requirePermission("customer:write") },
    async (req, reply) => {
      const parsed = bulkAssignSchema.safeParse(req.body);
      if (!parsed.success) {
        const missingPrice = parsed.error.issues.some((i) => i.path[0] === "monthlyPrice");
        if (missingPrice) {
          return reply.code(400).send({
            error: "monthlyPrice is required; refusing to invent a price.",
            issues: parsed.error.issues,
          });
        }
        return reply.code(400).send({ error: "Invalid request", issues: parsed.error.issues });
      }
      try {
        return await bulkAssignPackage(sql, {
          ...parsed.data,
          actorId: (req.user as { sub: string }).sub,
        });
      } catch (err) {
        if (err instanceof BulkAssignError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    });

  /**
   * Permanent delete of every customer. Requires an exact confirmation phrase.
   * Packages, areas, users, and WhatsApp templates are left in place.
   */
  app.post("/api/customers/purge-all",
    { preHandler: requirePermission("customer:delete") },
    async (req, reply) => {
      const parsed = z.object({ confirm: z.literal("DELETE ALL CUSTOMERS") }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Type DELETE ALL CUSTOMERS to confirm. This cannot be undone.',
        });
      }
      const actorId = (req.user as { sub: string }).sub;
      const result = await sql.begin(async (tx) => {
        const [countRow] = await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM customers`;
        const n = countRow?.n ?? 0;
        const dependents = await deleteCustomerDependents(tx as unknown as Sql, null);
        const deleted = await tx`DELETE FROM customers RETURNING 1`;
        await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                 VALUES (${actorId}, 'customer.purge_all', 'customer', 'all',
                         ${tx.json({ ...dependents, customers: deleted.length })})`;
        return { ...dependents, customers: n };
      });
      return result;
    });

  /** Global search across every field §10, using the trigram indexes. */
  app.get("/api/customers", { preHandler: requirePermission("customer:read") },
    async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const limit = Math.min(Number(q.limit ?? 50), 200);
      const offset = Number(q.offset ?? 0);
      const term = q.q?.trim();

      // Search terms that look like phone numbers are normalized first, so
      // "0300 123 4567" finds the customer stored as +923001234567.
      const asPhone = term ? normalizeMsisdn(term) : null;
      const phoneTerm = asPhone?.ok ? asPhone.msisdn : null;

      const rows = await sql`
        SELECT c.id, c.customer_code, c.full_name, c.primary_phone, c.status,
               c.current_expiry_date, c.missing_fields, a.name AS area_name,
               p.id AS package_id, p.name AS package_name, p.speed_mbps, s.monthly_price,
               w.msisdn AS whatsapp, w.state AS whatsapp_state,
               COALESCE((SELECT SUM(i.total - i.amount_paid) FROM invoices i
                          WHERE i.customer_id = c.id
                            AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')), 0) AS amount_due
          FROM customers c
          LEFT JOIN areas a ON a.id = c.area_id
          LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.ended_on IS NULL
          LEFT JOIN packages p ON p.id = s.package_id
          LEFT JOIN customer_whatsapp_numbers w ON w.customer_id = c.id AND w.is_primary
         WHERE true
           ${q.status ? sql`AND c.status = ${q.status}` : sql`AND c.status <> 'INACTIVE'`}
           ${q.area ? sql`AND c.area_id = ${Number(q.area)}` : sql``}
           ${q.package ? sql`AND s.package_id = ${Number(q.package)}` : sql``}
           ${q.expiringInDays
              ? sql`AND c.current_expiry_date = ${todayInKarachi()}::date + ${Number(q.expiringInDays)}::int`
              : sql``}
           ${term
              ? sql`AND (
                     c.customer_code ILIKE ${"%" + term + "%"}
                  OR c.full_name     ILIKE ${"%" + term + "%"}
                  OR c.cnic          ILIKE ${"%" + term + "%"}
                  OR c.address       ILIKE ${"%" + term + "%"}
                  OR host(c.ip_address) ILIKE ${"%" + term + "%"}
                  ${phoneTerm ? sql`OR c.primary_phone = ${phoneTerm} OR w.msisdn = ${phoneTerm}` : sql``}
                 )`
              : sql``}
         ORDER BY
           COALESCE(NULLIF(substring(c.customer_code from '[0-9]+$'), '')::bigint, 999999999999),
           c.customer_code
         LIMIT ${limit} OFFSET ${offset}`;

      const [{ count }] = await sql<{ count: string }[]>`
        SELECT COUNT(*) FROM customers c
          LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.ended_on IS NULL
          LEFT JOIN customer_whatsapp_numbers w ON w.customer_id = c.id AND w.is_primary
         WHERE true
           ${q.status ? sql`AND c.status = ${q.status}` : sql`AND c.status <> 'INACTIVE'`}
           ${q.area ? sql`AND c.area_id = ${Number(q.area)}` : sql``}
           ${q.package ? sql`AND s.package_id = ${Number(q.package)}` : sql``}
           ${q.expiringInDays
              ? sql`AND c.current_expiry_date = ${todayInKarachi()}::date + ${Number(q.expiringInDays)}::int`
              : sql``}
           ${term
              ? sql`AND (
                     c.customer_code ILIKE ${"%" + term + "%"}
                  OR c.full_name     ILIKE ${"%" + term + "%"}
                  OR c.cnic          ILIKE ${"%" + term + "%"}
                  OR c.address       ILIKE ${"%" + term + "%"}
                  OR host(c.ip_address) ILIKE ${"%" + term + "%"}
                  ${phoneTerm ? sql`OR c.primary_phone = ${phoneTerm} OR w.msisdn = ${phoneTerm}` : sql``}
                 )`
              : sql``}`;

      return { rows, total: Number(count), limit, offset };
    });

  /** Full profile §9 — one request, all sections. */
  app.get("/api/customers/:id", { preHandler: requirePermission("customer:read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [customer] = await sql`
        SELECT c.*, a.name AS area_name, p.name AS package_name, p.speed_mbps,
               s.id AS subscription_id, s.package_id, s.monthly_price, s.discount
          FROM customers c
          LEFT JOIN areas a ON a.id = c.area_id
          LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.ended_on IS NULL
          LEFT JOIN packages p ON p.id = s.package_id
         WHERE c.id = ${id}`;
      if (!customer) return reply.code(404).send({ error: "Customer not found" });

      const [whatsapp, invoices, payments, notifications, notes, timeline] = await Promise.all([
        sql`SELECT msisdn, state, is_primary, verified_at, opted_out_at
              FROM customer_whatsapp_numbers WHERE customer_id = ${id}`,
        sql`SELECT id, invoice_no, period_start, period_end, due_date, total,
                   amount_paid, status, paid_at
              FROM invoices WHERE customer_id = ${id}
             ORDER BY period_start DESC LIMIT 24`,
        sql`SELECT id, receipt_no, amount, paid_on, method, reference_no, reversed_at
              FROM payments WHERE customer_id = ${id}
             ORDER BY paid_on DESC LIMIT 50`,
        sql`SELECT id, notification_type, status, scheduled_for, sent_at,
                   delivered_at, skip_reason, error_message, recipient_msisdn
              FROM whatsapp_notifications WHERE customer_id = ${id}
             ORDER BY scheduled_for DESC LIMIT 50`,
        sql`SELECT id, body, created_at FROM customer_notes
             WHERE customer_id = ${id} ORDER BY created_at DESC`,
        sql`SELECT action, entity_type, created_at, after_data
              FROM audit_logs WHERE entity_id = ${id}
             ORDER BY created_at DESC LIMIT 50`,
      ]);

      return { customer, whatsapp, invoices, payments, notifications, notes, timeline };
    });

  app.post("/api/customers", { preHandler: requirePermission("customer:write") },
    async (req, reply) => {
      const parsed = customerSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: firstIssueMessage(parsed, "Invalid customer"),
          issues: parsed.error.issues,
        });
      }
      const input = parsed.data;

      // Numbers are normalized before they can reach the msisdn domain, which
      // would reject them anyway — this turns a 500 into a useful 400.
      let phone: string | null = null;
      let whatsapp: string | null = null;
      if (input.phone) {
        const r = normalizeMsisdn(input.phone);
        if (!r.ok) return reply.code(400).send({ error: `Invalid phone: ${r.reason}` });
        phone = r.msisdn;
      }
      if (input.whatsapp) {
        const r = normalizeMsisdn(input.whatsapp);
        if (!r.ok) return reply.code(400).send({ error: `Invalid WhatsApp number: ${r.reason}` });
        whatsapp = r.msisdn;
      }
      whatsapp ??= phone;

      const expiryDate = input.expiryDate ?? null;
      const billingAnchorDay =
        input.billingAnchorDay ?? (expiryDate ? Number(expiryDate.slice(8, 10)) : null);
      const cnic = input.cnic || null;
      const ipAddress = input.ipAddress || null;

      const missing = computeMissingFields({
        fullName: input.fullName,
        primaryPhone: phone,
        billingAnchorDay,
        hasSubscription: Boolean(input.packageId && input.monthlyPrice != null),
      });
      const status = missing.length ? "INCOMPLETE" : "ACTIVE";

      try {
      return await sql.begin(async (tx) => {
        const code = input.customerCode ?? await nextCustomerCode(tx as unknown as Sql);
        if (input.customerCode) {
          const [taken] = await tx<{ id: string; status: string; full_name: string }[]>`
            SELECT id, status, full_name FROM customers WHERE lower(customer_code) = lower(${code})`;
          if (taken) {
            const extra = taken.status === "INACTIVE"
              ? ` ${taken.full_name} is deactivated — open them from Deactivated and activate again.`
              : "";
            return reply.code(409).send({ error: `Customer code ${code} is already in use.${extra}` });
          }
        }
        if (whatsapp) {
          const [claimed] = await tx<{ id: string; customer_code: string; full_name: string; status: string }[]>`
            SELECT c.id, c.customer_code, c.full_name, c.status
              FROM customer_whatsapp_numbers w
              JOIN customers c ON c.id = w.customer_id
             WHERE w.msisdn = ${whatsapp}`;
          if (claimed) {
            const extra = claimed.status === "INACTIVE"
              ? ` ${claimed.full_name} (${claimed.customer_code}) is deactivated — open them from Deactivated and activate again.`
              : ` It belongs to ${claimed.full_name} (${claimed.customer_code}).`;
            return reply.code(409).send({ error: `That phone / WhatsApp number is already in use.${extra}` });
          }
        }
        const [c] = await tx<{ id: string }[]>`
          INSERT INTO customers (customer_code, full_name, cnic, address, area_id,
            primary_phone, status, missing_fields, installation_date, current_expiry_date,
            billing_anchor_day, connection_type, ip_address, mac_address,
            router_model, onu_serial, notes, created_by)
          VALUES (${code}, ${input.fullName}, ${cnic}, ${input.address ?? null},
            ${input.areaId ?? null}, ${phone}, ${status}, ${missing},
            ${input.installationDate ?? null}, ${expiryDate},
            ${billingAnchorDay},
            ${input.connectionType ?? null}, ${ipAddress},
            ${input.macAddress ?? null}, ${input.routerModel ?? null},
            ${input.onuSerial ?? null}, ${input.notes ?? null}, ${(req.user as any).sub})
          RETURNING id`;

        if (whatsapp) {
          await tx`INSERT INTO customer_whatsapp_numbers (customer_id, msisdn, state, is_primary)
                   VALUES (${c!.id}, ${whatsapp}, 'UNVERIFIED', true)
                   ON CONFLICT (msisdn) DO NOTHING`;
        }
        if (input.packageId && input.monthlyPrice != null) {
          await tx`INSERT INTO subscriptions (customer_id, package_id, monthly_price, started_on)
                   VALUES (${c!.id}, ${input.packageId}, ${input.monthlyPrice},
                           ${input.installationDate ?? todayInKarachi()})`;
        }
        await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                 VALUES (${(req.user as any).sub}, 'customer.create', 'customer', ${c!.id},
                         ${tx.json({ code, status, missing })})`;

        return reply.code(201).send({ id: c!.id, customerCode: code, status, missingFields: missing });
      });
      } catch (err) {
        if (uniqueViolationKind(err) === "customer_code") {
          return reply.code(409).send({ error: "That customer code is already in use." });
        }
        if (uniqueViolationKind(err) === "whatsapp") {
          return reply.code(409).send({ error: "That WhatsApp number already belongs to another customer." });
        }
        throw err;
      }
    });

  /**
   * Staff fill gaps in the app here. Omitted fields are left as they are.
   * Package list price is never copied onto the customer — monthlyPrice must
   * be supplied by the operator when assigning a package for the first time.
   */
  app.patch("/api/customers/:id", { preHandler: requirePermission("customer:write") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = customerSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: firstIssueMessage(parsed, "Invalid update"),
          issues: parsed.error.issues,
        });
      }
      const u = parsed.data;
      const actorId = (req.user as { sub: string }).sub;

      try {
        const result = await sql.begin(async (tx) => {
          const [before] = await tx`
            SELECT * FROM customers WHERE id = ${id} FOR UPDATE`;
          if (!before) return { notFound: true as const };

          let phone = (before as { primary_phone: string | null }).primary_phone;
          if (u.phone) {
            const r = normalizeMsisdn(u.phone);
            if (!r.ok) {
              return { error: `Invalid phone: ${r.reason}`, statusCode: 400 as const };
            }
            phone = r.msisdn;
          }

          let whatsapp: string | null = null;
          if (u.whatsapp) {
            const r = normalizeMsisdn(u.whatsapp);
            if (!r.ok) {
              return { error: `Invalid WhatsApp number: ${r.reason}`, statusCode: 400 as const };
            }
            whatsapp = r.msisdn;
          } else if (u.phone && phone) {
            whatsapp = phone;
          }

          if (u.customerCode) {
            const [taken] = await tx<{ id: string }[]>`
              SELECT id FROM customers
               WHERE lower(customer_code) = lower(${u.customerCode}) AND id <> ${id}`;
            if (taken) {
              return {
                error: `Customer code ${u.customerCode} is already in use.`,
                statusCode: 409 as const,
              };
            }
          }

          const expiryDate = u.expiryDate ?? null;
          const billingAnchorDay =
            u.billingAnchorDay ?? (expiryDate ? Number(expiryDate.slice(8, 10)) : null);

          await tx`
            UPDATE customers SET
              customer_code      = COALESCE(${u.customerCode ?? null}, customer_code),
              full_name          = COALESCE(${u.fullName ?? null}, full_name),
              cnic               = COALESCE(${u.cnic || null}, cnic),
              address            = COALESCE(${u.address ?? null}, address),
              area_id            = COALESCE(${u.areaId ?? null}, area_id),
              primary_phone      = COALESCE(${phone}, primary_phone),
              billing_anchor_day = COALESCE(${billingAnchorDay}, billing_anchor_day),
              current_expiry_date = COALESCE(${expiryDate}, current_expiry_date),
              installation_date  = COALESCE(${u.installationDate ?? null}, installation_date),
              connection_type    = COALESCE(${u.connectionType ?? null}, connection_type),
              ip_address         = COALESCE(${u.ipAddress || null}, ip_address),
              mac_address        = COALESCE(${u.macAddress ?? null}, mac_address),
              router_model       = COALESCE(${u.routerModel ?? null}, router_model),
              onu_serial         = COALESCE(${u.onuSerial ?? null}, onu_serial),
              notes              = COALESCE(${u.notes ?? null}, notes)
            WHERE id = ${id}`;

          if (whatsapp) {
            const [claimed] = await tx<{ customer_id: string }[]>`
              SELECT customer_id FROM customer_whatsapp_numbers WHERE msisdn = ${whatsapp}`;
            if (claimed && claimed.customer_id !== id) {
              return {
                error: "That WhatsApp number already belongs to another customer.",
                statusCode: 409 as const,
              };
            }
            const [hasPrimary] = await tx<{ exists: boolean }[]>`
              SELECT EXISTS (
                SELECT 1 FROM customer_whatsapp_numbers
                 WHERE customer_id = ${id} AND is_primary
              ) AS exists`;
            await tx`
              INSERT INTO customer_whatsapp_numbers (customer_id, msisdn, state, is_primary)
              VALUES (${id}, ${whatsapp}, 'UNVERIFIED', ${!hasPrimary?.exists})
              ON CONFLICT (msisdn) DO NOTHING`;
          }

          const [currentSub] = await tx<{ id: string; package_id: number; monthly_price: string }[]>`
            SELECT id, package_id, monthly_price
              FROM subscriptions
             WHERE customer_id = ${id} AND ended_on IS NULL`;

          const assigningPackage = u.packageId != null;
          const assigningPrice = u.monthlyPrice != null;
          if (assigningPackage && !assigningPrice && !currentSub) {
            return {
              error: "monthlyPrice is required; refusing to invent a price.",
              statusCode: 400 as const,
            };
          }
          if (assigningPrice && !assigningPackage && !currentSub) {
            return {
              error: "packageId is required when setting a monthly price.",
              statusCode: 400 as const,
            };
          }

          if (assigningPackage || assigningPrice) {
            if (currentSub) {
              await tx`
                UPDATE subscriptions SET
                  package_id    = COALESCE(${u.packageId ?? null}, package_id),
                  monthly_price = COALESCE(${u.monthlyPrice ?? null}, monthly_price)
                WHERE id = ${currentSub.id}`;
            } else {
              await tx`
                INSERT INTO subscriptions (customer_id, package_id, monthly_price, started_on)
                VALUES (
                  ${id},
                  ${u.packageId!},
                  ${u.monthlyPrice!},
                  ${u.installationDate ?? (before as { installation_date: string | null }).installation_date ?? todayInKarachi()}
                )`;
            }
          }

          const [row] = await tx<{
            full_name: string;
            primary_phone: string | null;
            billing_anchor_day: number | null;
            status: string;
          }[]>`
            SELECT full_name, primary_phone, billing_anchor_day, status
              FROM customers WHERE id = ${id}`;
          const [subNow] = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM subscriptions WHERE customer_id = ${id} AND ended_on IS NULL
            ) AS exists`;

          const missing = computeMissingFields({
            fullName: row!.full_name,
            primaryPhone: row!.primary_phone,
            billingAnchorDay: row!.billing_anchor_day,
            hasSubscription: Boolean(subNow?.exists),
          });

          const protectedStatus = row!.status === "SUSPENDED" || row!.status === "INACTIVE";
          let status = row!.status;
          if (!protectedStatus) {
            status = missing.length ? "INCOMPLETE" : "ACTIVE";
          }

          const [after] = await tx`
            UPDATE customers SET missing_fields = ${missing}, status = ${status}
             WHERE id = ${id} RETURNING *`;

          if (!protectedStatus && missing.length === 0) {
            await refreshCustomerStatus(tx as unknown as Sql, id);
            const [refreshed] = await tx`SELECT * FROM customers WHERE id = ${id}`;
            await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
                     VALUES (${actorId}, 'customer.update', 'customer', ${id},
                             ${tx.json(before as object)}, ${tx.json(refreshed as object)})`;
            return { after: refreshed, missing, status: (refreshed as { status: string }).status };
          }

          await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
                   VALUES (${actorId}, 'customer.update', 'customer', ${id},
                           ${tx.json(before as object)}, ${tx.json(after as object)})`;
          return { after, missing, status };
        });

        if (result && "notFound" in result) {
          return reply.code(404).send({ error: "Customer not found" });
        }
        if (result && "error" in result) {
          return reply.code(result.statusCode).send({ error: result.error });
        }
        return result;
      } catch (err) {
        const kind = uniqueViolationKind(err);
        if (kind === "customer_code") {
          return reply.code(409).send({ error: "That customer code is already in use." });
        }
        if (kind === "whatsapp") {
          return reply.code(409).send({ error: "That WhatsApp number already belongs to another customer." });
        }
        throw err;
      }
    });

  /** Deactivate: stays in the CRM as INACTIVE, can be activated again. */
  app.delete("/api/customers/:id", { preHandler: requirePermission("customer:delete") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE customers SET deleted_at = NULL, status = 'INACTIVE'
         WHERE id = ${id} RETURNING id`;
      if (!row) return reply.code(404).send({ error: "Customer not found" });
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
                VALUES (${(req.user as any).sub}, 'customer.deactivate', 'customer', ${id})`;
      return { id, deactivated: true };
    });

  /** Permanent delete of one customer and their billing / WhatsApp rows. */
  app.post("/api/customers/:id/purge", { preHandler: requirePermission("customer:delete") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "Invalid customer id" });
      }
      const parsed = z.object({ confirm: z.literal("DELETE") }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Type DELETE to confirm permanent removal." });
      }
      const actorId = (req.user as { sub: string }).sub;
      const result = await sql.begin(async (tx) => {
        const [customer] = await tx<{ id: string; customer_code: string; full_name: string }[]>`
          SELECT id, customer_code, full_name FROM customers WHERE id = ${id} FOR UPDATE`;
        if (!customer) return { notFound: true as const };
        const dependents = await deleteCustomerDependents(tx as unknown as Sql, id);
        await tx`DELETE FROM customers WHERE id = ${id}`;
        await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
                 VALUES (${actorId}, 'customer.purge', 'customer', ${id},
                         ${tx.json(customer)}, ${tx.json(dependents)})`;
        return { id, customerCode: customer.customer_code, ...dependents, customers: 1 };
      });
      if (result && "notFound" in result) {
        return reply.code(404).send({ error: "Customer not found" });
      }
      return result;
    });

  app.post("/api/customers/:id/restore", { preHandler: requirePermission("customer:delete") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await sql.begin(async (tx) => {
        const [row] = await tx<{
          id: string;
          full_name: string;
          primary_phone: string | null;
          billing_anchor_day: number | null;
        }[]>`SELECT id, full_name, primary_phone, billing_anchor_day FROM customers WHERE id = ${id} FOR UPDATE`;
        if (!row) return { notFound: true as const };
        const [sub] = await tx<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM subscriptions WHERE customer_id = ${id} AND ended_on IS NULL
          ) AS exists`;
        const missing = computeMissingFields({
          fullName: row.full_name,
          primaryPhone: row.primary_phone,
          billingAnchorDay: row.billing_anchor_day,
          hasSubscription: Boolean(sub?.exists),
        });
        const status = missing.length ? "INCOMPLETE" : "ACTIVE";
        await tx`
          UPDATE customers
             SET deleted_at = NULL, missing_fields = ${missing}, status = ${status}
           WHERE id = ${id}`;
        if (!missing.length) {
          await refreshCustomerStatus(tx as unknown as Sql, id);
        }
        await tx`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
                 VALUES (${(req.user as { sub: string }).sub}, 'customer.restore', 'customer', ${id},
                         ${tx.json({ status, missing })})`;
        return { id, restored: true, status, missingFields: missing };
      });
      if (result && "notFound" in result) {
        return reply.code(404).send({ error: "Customer not found" });
      }
      return result;
    });
}
