/**
 * HTTP API. Runs as bi-api.service behind nginx.
 *
 * Architecture note: the Phase 1 document specified NestJS. Moving to code, I
 * switched to Fastify. NestJS's decorator/DI layer costs roughly 40 MB of
 * resident memory per instance and several files of boilerplate per module,
 * neither of which buys anything here — the domain logic already lives in a
 * framework-free package, so the HTTP layer only needs routing, validation and
 * auth. On a shared Ampere A1 that memory is better spent on Postgres cache.
 * The module boundaries from the architecture doc are unchanged.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import argon2 from "argon2";
import { z } from "zod";
import { createSql, requireEnv } from "./db/index.ts";
import { recordPayment } from "./modules/billing.service.ts";
import { todayInKarachi, normalizeMsisdn, toNationalDisplay } from "@bi/domain";
import { registerCustomerRoutes } from "./modules/customers.routes.ts";
import { registerNotificationRoutes } from "./modules/notifications.routes.ts";
import { registerAdminRoutes } from "./modules/admin.routes.ts";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: string; permissions: string[] };
    user: { sub: string; role: string; permissions: string[] };
  }
}

const sql = createSql();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Never let a token or a password reach the log files.
    redact: ["req.headers.authorization", "req.body.password", "*.accessToken"],
  },
  trustProxy: true, // behind nginx
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, {
  origin: (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean),
  credentials: true,
});
await app.register(jwt, {
  secret: requireEnv("JWT_SECRET"),
  sign: { expiresIn: "15m" },
});
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

/* ------------------------------ auth -------------------------------- */

/** Guard factory. Checks PERMISSIONS, never role names, so adding a role
 *  never requires editing a route. */
export function requirePermission(...needed: string[]) {
  return async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const held: string[] = req.user.permissions ?? [];
    const missing = needed.filter((p) => !held.includes(p));
    if (missing.length) {
      return reply.code(403).send({ error: "Forbidden", missing });
    }
  };
}

const loginSchema = z.object({
  // z.string().email() rejects admin@localhost (no dot in the host).
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1),
});

app.post("/api/auth/login", {
  config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
}, async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid credentials" });

  const [user] = await sql<
    { id: string; password_hash: string; role_code: string; is_active: boolean;
      locked_until: Date | null; permissions: string[] }[]
  >`
    SELECT u.id, u.password_hash, r.code AS role_code, u.is_active, u.locked_until,
           COALESCE(ARRAY_AGG(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE u.email = ${parsed.data.email}
     GROUP BY u.id, r.code
  `;

  // Uniform failure: never reveal whether the email exists.
  const GENERIC = { error: "Invalid email or password" };
  if (!user || !user.is_active) return reply.code(401).send(GENERIC);
  if (user.locked_until && user.locked_until > new Date()) {
    return reply.code(423).send({ error: "Account temporarily locked" });
  }

  const ok = await argon2.verify(user.password_hash, parsed.data.password);
  if (!ok) {
    await sql`
      UPDATE users
         SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= 5
                                 THEN now() + interval '15 minutes' ELSE NULL END
       WHERE id = ${user.id}`;
    return reply.code(401).send(GENERIC);
  }

  await sql`UPDATE users SET failed_logins = 0, locked_until = NULL,
             last_login_at = now() WHERE id = ${user.id}`;

  const token = app.jwt.sign({
    sub: user.id, role: user.role_code, permissions: user.permissions,
  });
  return { token, role: user.role_code, permissions: user.permissions };
});

app.get("/api/auth/me", { preHandler: requirePermission() }, async (req) => {
  const [u] = await sql<{
    id: string; email: string; full_name: string; last_login_at: Date | null;
  }[]>`
    SELECT id, email, full_name, last_login_at
      FROM users WHERE id = ${(req.user as any).sub}`;
  return {
    ...u,
    role: (req.user as any).role,
    permissions: (req.user as any).permissions,
  };
});

const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(3).max(320).optional(),
  currentPassword: z.string().min(1),
});

app.patch("/api/auth/profile", { preHandler: requirePermission() }, async (req, reply) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Check the fields and try again." });
  if (!parsed.data.fullName && !parsed.data.email) {
    return reply.code(400).send({ error: "Nothing to update." });
  }

  const userId = (req.user as any).sub as string;
  const [row] = await sql<{ id: string; password_hash: string }[]>`
    SELECT id, password_hash FROM users WHERE id = ${userId} AND is_active = true`;
  if (!row) return reply.code(401).send({ error: "Unauthorized" });

  const ok = await argon2.verify(row.password_hash, parsed.data.currentPassword);
  if (!ok) return reply.code(400).send({ error: "Current password is incorrect." });

  if (parsed.data.email) {
    const [taken] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${parsed.data.email} AND id <> ${userId}`;
    if (taken) return reply.code(409).send({ error: "That email is already in use." });
  }

  const [updated] = await sql<{ id: string; email: string; full_name: string; last_login_at: Date | null }[]>`
    UPDATE users SET
      full_name = COALESCE(${parsed.data.fullName ?? null}, full_name),
      email     = COALESCE(${parsed.data.email ?? null}, email)
    WHERE id = ${userId}
    RETURNING id, email, full_name, last_login_at`;
  return {
    ...updated,
    role: (req.user as any).role,
    permissions: (req.user as any).permissions,
  };
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

app.patch("/api/auth/password", { preHandler: requirePermission() }, async (req, reply) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "New password must be at least 10 characters." });
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return reply.code(400).send({ error: "New password must be different from the current one." });
  }

  const userId = (req.user as any).sub as string;
  const [row] = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${userId} AND is_active = true`;
  if (!row) return reply.code(401).send({ error: "Unauthorized" });

  const ok = await argon2.verify(row.password_hash, parsed.data.currentPassword);
  if (!ok) return reply.code(400).send({ error: "Current password is incorrect." });

  const hash = await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id });
  await sql`UPDATE users SET password_hash = ${hash}, failed_logins = 0, locked_until = NULL WHERE id = ${userId}`;
  return { ok: true };
});

app.get("/api/settings/workspace", { preHandler: requirePermission() }, async () => ({
  timezone: "Asia/Karachi",
  expiryNotice: "12:00 AM (Midnight)",
  whatsappDryRun: process.env.WHATSAPP_DRY_RUN !== "false",
  businessName: "Bismillah Super Storm Fiber",
}));


/* ---------------------------- dashboard ------------------------------ */

app.get("/api/dashboard", { preHandler: requirePermission("customer:read") }, async () => {
  const today = todayInKarachi();

  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'INACTIVE')                   AS total,
      COUNT(*) FILTER (WHERE status = 'ACTIVE')                      AS active,
      COUNT(*) FILTER (WHERE status = 'PAYMENT_DUE')                 AS payment_due,
      COUNT(*) FILTER (WHERE status = 'OVERDUE')                     AS overdue,
      COUNT(*) FILTER (WHERE status = 'SUSPENDED')                   AS suspended,
      COUNT(*) FILTER (WHERE status = 'INACTIVE')                    AS inactive,
      COUNT(*) FILTER (WHERE status = 'INCOMPLETE')                  AS incomplete,
      COUNT(*) FILTER (WHERE current_expiry_date = ${today}::date)             AS expiring_today,
      COUNT(*) FILTER (WHERE current_expiry_date = ${today}::date + 1)         AS expiring_tomorrow,
      COUNT(*) FILTER (WHERE current_expiry_date = ${today}::date + 2)         AS expiring_in_2_days
    FROM customers`;

  const [money] = await sql`
    SELECT
      COALESCE(SUM(total - amount_paid) FILTER
        (WHERE status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')), 0) AS outstanding,
      COUNT(DISTINCT customer_id) FILTER
        (WHERE status IN ('UNPAID','PARTIALLY_PAID','OVERDUE'))     AS customers_with_dues
    FROM invoices`;

  const [today_payments] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
      FROM payments WHERE paid_on = ${today}::date AND reversed_at IS NULL`;

  const [notifs] = await sql`
    SELECT COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ')) AS sent,
           COUNT(*) FILTER (WHERE status = 'FAILED')                     AS failed,
           COUNT(*) FILTER (WHERE status = 'SKIPPED')                    AS skipped,
           COUNT(*) FILTER (WHERE status = 'QUEUED')                     AS queued
      FROM whatsapp_notifications
     WHERE scheduled_for::date = ${today}::date`;

  return { businessDate: today, customers: counts, billing: money,
           todayPayments: today_payments, notifications: notifs };
});

/* ---------------------------- payments ------------------------------- */

const paymentSchema = z.object({
  customerId: z.string().uuid(),
  amountRupees: z.coerce.number().positive().max(10_000_000),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  method: z.enum(["CASH","BANK_TRANSFER","JAZZCASH","EASYPAISA","RAAST","ONLINE_TRANSFER","OTHER"]),
  referenceNo: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  invoiceId: z.string().uuid().optional(),
});

app.post("/api/payments", { preHandler: requirePermission("payment:write") },
  async (req, reply) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid payment", issues: parsed.error.issues });
    }
    const result = await recordPayment(sql, {
      ...parsed.data,
      paidOn: parsed.data.paidOn ?? todayInKarachi(),
      recordedBy: (req.user as any).sub,
      referenceNo: parsed.data.referenceNo ?? null,
      notes: parsed.data.notes ?? null,
      invoiceId: parsed.data.invoiceId ?? null,
    });
    return reply.code(201).send(result);
  });

app.get("/api/dues", { preHandler: requirePermission("invoice:read") }, async (req) => {
  const q = req.query as { area?: string; limit?: string; offset?: string };
  const limit = Math.min(Number(q.limit ?? 50), 200);
  const offset = Number(q.offset ?? 0);
  const rows = await sql`
    SELECT * FROM customer_dues
     ${q.area ? sql`WHERE area_id = ${Number(q.area)}` : sql``}
     ORDER BY days_overdue DESC, amount_due DESC
     LIMIT ${limit} OFFSET ${offset}`;
  return { rows, limit, offset };
});

/* ------------------------- module routes ----------------------------- */

await registerCustomerRoutes(app, sql);
await registerNotificationRoutes(app, sql);
await registerAdminRoutes(app, sql);

/* ----------------------------- health -------------------------------- */

app.get("/api/health", async (_req, reply) => {
  const checks: Record<string, string> = {};
  try {
    await sql`SELECT 1`;
    checks.postgres = "ok";
  } catch (e) {
    checks.postgres = `fail: ${(e as Error).message}`;
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  return reply.code(healthy ? 200 : 503).send({
    status: healthy ? "ok" : "degraded",
    businessDate: todayInKarachi(),
    checks,
  });
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error({ err }, "unhandled error");
  // Never leak a SQL message or a stack trace to a browser.
  reply.code(err.statusCode ?? 500).send({
    error: err.statusCode && err.statusCode < 500 ? err.message : "Internal server error",
  });
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.LISTEN_HOST ?? "127.0.0.1";
await app.listen({ port, host });
app.log.info({ port, host, tz: "Asia/Karachi" }, "bi-api started");

export { app, sql, normalizeMsisdn, toNationalDisplay };
