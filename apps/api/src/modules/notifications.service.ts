/**
 * Notification sweeps and dispatch.
 *
 * This is where spec §17, §19, §24, §25 and §26 are actually enforced at
 * runtime. The database makes a wrong send impossible; this module makes sure
 * the right sends happen, once each, at the right time.
 */

import type { Sql } from "postgres";
import {
  bindingsForCustomer,
  evaluateEligibility,
  notificationKey,
  renderTemplate,
  toProviderTemplate,
  providerParameters,
  todayInKarachi,
  type IsoDate,
  type NotificationCandidate,
  type NotificationType,
  type SkipReason,
} from "@bi/domain";

export interface SweepResult {
  type: NotificationType;
  businessDate: IsoDate;
  examined: number;
  queued: number;
  skipped: Record<string, number>;
  queuedIds: string[];
}

/**
 * One row per customer eligible for consideration. Every field the decision
 * needs comes from a SINGLE joined read, so a customer's number, invoice and
 * expiry date can never be assembled from separate queries and mismatched.
 */
interface CandidateRow {
  customer_id: string;
  customer_code: string;
  full_name: string;
  customer_status: NotificationCandidate["customerStatus"];
  recipient_msisdn: string | null;
  number_state: NotificationCandidate["numberState"];
  invoice_id: string;
  invoice_status: NotificationCandidate["invoiceStatus"];
  amount_due: string;
  expiry_date: IsoDate;
  package_name: string;
  package_speed_mbps: number;
  already_sent: boolean;
}

/**
 * Loads candidates whose expiry falls exactly `offsetDays` from the business
 * date. The SQL narrows to the right day; evaluateEligibility() makes the
 * decision. Keeping the rules in TypeScript rather than the WHERE clause is
 * deliberate — that is what lets the 55-test domain suite cover them.
 */
async function loadCandidates(
  sql: Sql,
  type: NotificationType,
  offsetDays: number,
  businessDate: IsoDate,
): Promise<CandidateRow[]> {
  return sql<CandidateRow[]>`
    SELECT c.id                       AS customer_id,
           c.customer_code,
           c.full_name,
           c.status                   AS customer_status,
           w.msisdn                   AS recipient_msisdn,
           COALESCE(w.state, 'UNVERIFIED') AS number_state,
           i.id                       AS invoice_id,
           i.status                   AS invoice_status,
           (i.total - i.amount_paid)  AS amount_due,
           i.period_end               AS expiry_date,
           i.package_name,
           i.package_speed_mbps,
           EXISTS (
             SELECT 1 FROM whatsapp_notifications n
              WHERE n.invoice_id = i.id
                AND n.notification_type = ${type}
                AND n.status <> 'CANCELLED'
           )                          AS already_sent
      FROM customers c
      JOIN invoices  i ON i.customer_id = c.id
      LEFT JOIN customer_whatsapp_numbers w
             ON w.customer_id = c.id AND w.is_primary
     WHERE c.deleted_at IS NULL
       AND i.period_end = (${businessDate}::date + ${offsetDays}::int)
       AND i.status <> 'CANCELLED'
     ORDER BY c.customer_code
  `;
}

/**
 * Queues notifications of `type` for the business date.
 *
 * Idempotent three times over: the EXISTS check skips work, the partial unique
 * index rejects a duplicate insert, and the BullMQ jobId dedupes the enqueue.
 * A worker killed mid-sweep and restarted produces no second message.
 */
export async function runSweep(
  sql: Sql,
  type: "TWO_DAY_REMINDER" | "FINAL_EXPIRY_WARNING",
  opts: {
    businessDate?: IsoDate;
    /** Called for each queued notification; enqueue to BullMQ here. */
    onQueued?: (notificationId: string, jobKey: string) => Promise<void>;
  } = {},
): Promise<SweepResult> {
  const businessDate = opts.businessDate ?? todayInKarachi();
  const offsetDays = type === "TWO_DAY_REMINDER" ? 2 : 0;

  const template = (
    await sql<{ id: number; body: string }[]>`
      SELECT id, body FROM whatsapp_templates
       WHERE notification_type = ${type} AND is_active
       LIMIT 1
    `
  )[0];

  if (!template) {
    throw new Error(`No active template for ${type}. Refusing to sweep.`);
  }

  const { order } = toProviderTemplate(template.body);
  const rows = await loadCandidates(sql, type, offsetDays, businessDate);

  const result: SweepResult = {
    type,
    businessDate,
    examined: rows.length,
    queued: 0,
    skipped: {},
    queuedIds: [],
  };

  for (const row of rows) {
    const amountDue = Number(row.amount_due);

    const candidate: NotificationCandidate = {
      customerId: row.customer_id,
      customerStatus: row.customer_status,
      recipientMsisdn: row.recipient_msisdn,
      numberState: row.number_state,
      invoiceId: row.invoice_id,
      invoiceStatus: row.invoice_status,
      amountDue,
      expiryDate: row.expiry_date,
      alreadySent: row.already_sent,
    };

    const decision = evaluateEligibility(type, candidate, businessDate);
    if (!decision.eligible) {
      countSkip(result, decision.reason);
      continue;
    }

    // Non-null after the eligibility gates, but assert rather than assume.
    if (!row.recipient_msisdn) {
      countSkip(result, "NO_WHATSAPP_NUMBER");
      continue;
    }

    // Bindings and recipient are constructed together from this one row.
    const bindings = bindingsForCustomer({
      recipientMsisdn: row.recipient_msisdn,
      customerName: row.full_name,
      customerCode: row.customer_code,
      expiryDate: row.expiry_date,
      amountDue,
      packageName: row.package_name,
      speedMbps: row.package_speed_mbps,
    });

    const renderedBody = renderTemplate(template.body, bindings);
    const params = providerParameters(order, bindings);
    const scheduledFor =
      type === "FINAL_EXPIRY_WARNING"
        ? midnightOf(businessDate)
        : new Date();

    try {
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO whatsapp_notifications (
          customer_id, recipient_msisdn, invoice_id, notification_type,
          template_id, customer_name, rendered_body, template_params,
          expiry_date_shown, amount_due_shown, scheduled_for, status
        ) VALUES (
          ${row.customer_id}, ${bindings.recipientMsisdn}, ${row.invoice_id}, ${type},
          ${template.id}, ${bindings.customer_name}, ${renderedBody}, ${params},
          ${row.expiry_date}, ${amountDue}, ${scheduledFor}, 'QUEUED'
        )
        RETURNING id
      `;

      const id = inserted[0]!.id;
      result.queued++;
      result.queuedIds.push(id);
      await opts.onQueued?.(id, notificationKey(row.invoice_id, type));
    } catch (err) {
      // The partial unique index fired: another sweep beat us to this cycle.
      if (isUniqueViolation(err)) {
        countSkip(result, "ALREADY_SENT");
        continue;
      }
      throw err;
    }
  }

  return result;
}

/**
 * §25 re-check. Called by the send worker immediately before dispatch, because
 * a payment taken at the counter between queue and send must suppress the
 * message. Returns null when the send may proceed.
 */
export async function recheckBeforeSend(
  sql: Sql,
  notificationId: string,
  businessDate: IsoDate = todayInKarachi(),
): Promise<SkipReason | null> {
  const rows = await sql<
    {
      notification_type: NotificationType;
      customer_status: NotificationCandidate["customerStatus"];
      number_state: NotificationCandidate["numberState"];
      recipient_msisdn: string;
      invoice_id: string;
      invoice_status: NotificationCandidate["invoiceStatus"];
      amount_due: string;
      expiry_date: IsoDate;
      customer_id: string;
    }[]
  >`
    SELECT n.notification_type,
           c.status                   AS customer_status,
           w.state                    AS number_state,
           n.recipient_msisdn,
           n.invoice_id,
           i.status                   AS invoice_status,
           (i.total - i.amount_paid)  AS amount_due,
           i.period_end               AS expiry_date,
           c.id                       AS customer_id
      FROM whatsapp_notifications n
      JOIN customers c ON c.id = n.customer_id
      JOIN invoices  i ON i.id = n.invoice_id
      LEFT JOIN customer_whatsapp_numbers w
             ON w.customer_id = n.customer_id AND w.msisdn = n.recipient_msisdn
     WHERE n.id = ${notificationId}
       FOR UPDATE OF n
  `;

  const row = rows[0];
  if (!row) return "ALREADY_SENT";

  const decision = evaluateEligibility(
    row.notification_type,
    {
      customerId: row.customer_id,
      customerStatus: row.customer_status,
      recipientMsisdn: row.recipient_msisdn,
      numberState: row.number_state ?? "UNVERIFIED",
      invoiceId: row.invoice_id,
      invoiceStatus: row.invoice_status,
      amountDue: Number(row.amount_due),
      expiryDate: row.expiry_date,
      alreadySent: false, // this row IS the send; do not self-block
    },
    businessDate,
  );

  return decision.eligible ? null : decision.reason;
}

export async function markSkipped(
  sql: Sql,
  notificationId: string,
  reason: SkipReason,
): Promise<void> {
  await sql`
    UPDATE whatsapp_notifications
       SET status = 'SKIPPED', skip_reason = ${reason}
     WHERE id = ${notificationId} AND status = 'QUEUED'
  `;
}

export async function markSent(
  sql: Sql,
  notificationId: string,
  providerMessageId: string,
): Promise<void> {
  await sql`
    UPDATE whatsapp_notifications
       SET status = 'SENT', provider_message_id = ${providerMessageId}, sent_at = now()
     WHERE id = ${notificationId}
  `;
}

export async function markFailed(
  sql: Sql,
  notificationId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await sql`
    UPDATE whatsapp_notifications
       SET status = 'FAILED',
           error_code = ${errorCode},
           error_message = ${errorMessage},
           retry_count = retry_count + 1
     WHERE id = ${notificationId}
  `;
}

function countSkip(result: SweepResult, reason: string): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

/** 00:00 Asia/Karachi on the given date, as a UTC instant. */
function midnightOf(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5 * 3_600_000);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}
