/** WhatsApp notification centre, templates, and the Meta delivery webhook. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sql } from "../db/index.ts";
import { requirePermission } from "../server.ts";
import { validateTemplateBody, toProviderTemplate, todayInKarachi, SKIP_REASON_LABEL } from "@bi/domain";
import { verifyWebhookSignature, mapWebhookStatus } from "../lib/whatsapp.ts";

export async function registerNotificationRoutes(app: FastifyInstance, sql: Sql) {
  /** §28: notification centre with filters. */
  app.get("/api/notifications", { preHandler: requirePermission("whatsapp:read") },
    async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const limit = Math.min(Number(q.limit ?? 50), 200);
      const rows = await sql`
        SELECT n.id, n.customer_id, n.customer_name, n.recipient_msisdn,
               n.notification_type, n.status, n.scheduled_for, n.sent_at,
               n.delivered_at, n.skip_reason, n.error_code, n.error_message,
               n.retry_count, n.expiry_date_shown, n.amount_due_shown,
               c.customer_code
          FROM whatsapp_notifications n
          JOIN customers c ON c.id = n.customer_id
         WHERE 1=1
           ${q.status ? sql`AND n.status = ${q.status}` : sql``}
           ${q.type ? sql`AND n.notification_type = ${q.type}` : sql``}
           ${q.customerId ? sql`AND n.customer_id = ${q.customerId}` : sql``}
           ${q.date ? sql`AND n.scheduled_for::date = ${q.date}::date` : sql``}
         ORDER BY n.scheduled_for DESC
         LIMIT ${limit}`;
      return {
        rows: rows.map((r: any) => ({
          ...r,
          skip_reason_label: r.skip_reason
            ? SKIP_REASON_LABEL[r.skip_reason as keyof typeof SKIP_REASON_LABEL] ?? r.skip_reason
            : null,
        })),
      };
    });

  /** Full message text for one notification — what was actually sent. */
  app.get("/api/notifications/:id", { preHandler: requirePermission("whatsapp:read") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        SELECT n.*, c.customer_code, t.code AS template_code
          FROM whatsapp_notifications n
          JOIN customers c ON c.id = n.customer_id
          JOIN whatsapp_templates t ON t.id = n.template_id
         WHERE n.id = ${id}`;
      if (!row) return reply.code(404).send({ error: "Notification not found" });
      return row;
    });

  /**
   * §28: retry a failed message. Note what this endpoint does NOT accept — a
   * phone number. It flips a row back to QUEUED; the worker re-reads the
   * recipient the database already vouched for.
   */
  app.post("/api/notifications/:id/retry", { preHandler: requirePermission("whatsapp:send") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE whatsapp_notifications
           SET status = 'QUEUED', error_code = NULL, error_message = NULL
         WHERE id = ${id} AND status = 'FAILED'
         RETURNING id, customer_id, notification_type`;
      if (!row) {
        return reply.code(409).send({ error: "Only FAILED notifications can be retried" });
      }
      await sql`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
                VALUES (${(req.user as any).sub}, 'whatsapp.retry', 'notification', ${id})`;
      return { id, requeued: true };
    });

  /* --------------------------- templates ---------------------------- */

  app.get("/api/templates", { preHandler: requirePermission("whatsapp:read") },
    async () => sql`SELECT * FROM whatsapp_templates ORDER BY notification_type`);

  const templateSchema = z.object({
    code: z.string().min(1).max(64),
    notificationType: z.enum(["TWO_DAY_REMINDER","FINAL_EXPIRY_WARNING","PAYMENT_CONFIRMATION"]),
    providerName: z.string().min(1),
    languageCode: z.string().default("ur"),
    body: z.string().min(1),
  });

  /**
   * Validates against Meta's rules BEFORE saving, so a template that would be
   * rejected after days of review never reaches submission.
   */
  app.post("/api/templates/validate", { preHandler: requirePermission("whatsapp:read") },
    async (req, reply) => {
      const body = (req.body as { body?: string })?.body;
      if (typeof body !== "string") return reply.code(400).send({ error: "body is required" });
      const validation = validateTemplateBody(body);
      let provider = null;
      try {
        provider = toProviderTemplate(body);
      } catch (e) {
        validation.problems.push((e as Error).message);
        validation.ok = false;
      }
      return { ...validation, provider };
    });

  app.post("/api/templates", { preHandler: requirePermission("whatsapp:template") },
    async (req, reply) => {
      const parsed = templateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid template", issues: parsed.error.issues });
      }
      const v = validateTemplateBody(parsed.data.body);
      if (!v.ok) {
        return reply.code(422).send({ error: "Template violates WhatsApp rules", problems: v.problems });
      }
      const [row] = await sql`
        INSERT INTO whatsapp_templates (code, notification_type, provider_name, language_code, body, variables)
        VALUES (${parsed.data.code}, ${parsed.data.notificationType}, ${parsed.data.providerName},
                ${parsed.data.languageCode}, ${parsed.data.body},
                ${toProviderTemplate(parsed.data.body).order})
        RETURNING *`;
      return reply.code(201).send(row);
    });

  /* ---------------------- Meta delivery webhook --------------------- */

  /** Meta's subscription handshake. */
  app.get("/api/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(200).send(q["hub.challenge"]);
    }
    return reply.code(403).send({ error: "Verification failed" });
  });

  /**
   * Delivery receipts. Signature-verified: without this check, anyone who
   * learns the URL could mark messages delivered and hide real failures.
   */
  app.post("/api/webhooks/whatsapp", {
    config: { rawBody: true, rateLimit: { max: 1000, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const raw = Buffer.from(JSON.stringify(req.body));
    const ok = await verifyWebhookSignature(
      raw,
      req.headers["x-hub-signature-256"] as string | undefined,
      process.env.WHATSAPP_APP_SECRET ?? "",
    );
    if (!ok) return reply.code(401).send({ error: "Bad signature" });

    const body = req.body as any;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const st of change?.value?.statuses ?? []) {
          const status = mapWebhookStatus(st.status);
          if (!status) continue;
          await sql`
            UPDATE whatsapp_notifications
               SET status = ${status},
                   delivered_at = CASE WHEN ${status} IN ('DELIVERED','READ')
                                       THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
                   error_code    = ${st.errors?.[0]?.code ? String(st.errors[0].code) : null},
                   error_message = ${st.errors?.[0]?.title ?? null}
             WHERE provider_message_id = ${st.id}`;
        }
      }
    }
    return reply.code(200).send({ received: true });
  });

  /** §51 admin system health. */
  app.get("/api/system/health", { preHandler: requirePermission("audit:read") },
    async () => {
      const [queued] = await sql`
        SELECT COUNT(*) FILTER (WHERE status = 'QUEUED') AS queued,
               COUNT(*) FILTER (WHERE status = 'FAILED' AND retry_count >= 3) AS dead
          FROM whatsapp_notifications`;
      const [lastSweep] = await sql`
        SELECT MAX(created_at) AS last FROM whatsapp_notifications`;
      return { businessDate: todayInKarachi(), notifications: queued, lastQueuedAt: lastSweep?.last };
    });
}
