/**
 * Invoice generation and payment recording.
 *
 * Invoice generation is idempotent by way of the invoices_cycle_unique index
 * on (customer_id, period_start): running the daily job twice, or running it
 * after a crash, cannot produce a second invoice for the same cycle.
 */

import type { Sql } from "postgres";
import {
  allocatePayment,
  cycleContaining,
  cycleFor,
  deriveStatus,
  dueDateFor,
  invoiceNumber,
  nextCycle,
  paisaToRupees,
  parseIsoDate,
  rupeesToPaisa,
  todayInKarachi,
  type IsoDate,
} from "@bi/domain";

export interface GenerationResult {
  businessDate: IsoDate;
  examined: number;
  created: number;
  skippedExisting: number;
  skippedIncomplete: number;
  invoiceIds: string[];
}

interface BillableCustomer {
  id: string;
  customer_code: string;
  billing_anchor_day: number;
  subscription_id: string | null;
  package_name: string | null;
  package_speed_mbps: number | null;
  monthly_price: string | null;
  discount: string;
  carried_balance: string;
}

/**
 * Creates the invoice for each active customer's upcoming cycle, `leadDays`
 * ahead of its start so the two-day reminder always has an invoice to point
 * at. Runs daily; does nothing on days where every invoice already exists.
 */
export async function generateInvoices(
  sql: Sql,
  opts: { businessDate?: IsoDate; leadDays?: number; graceDays?: number } = {},
): Promise<GenerationResult> {
  const businessDate = opts.businessDate ?? todayInKarachi();
  const leadDays = opts.leadDays ?? 7;
  const graceDays = opts.graceDays ?? 0;

  const customers = await sql<BillableCustomer[]>`
    SELECT c.id,
           c.customer_code,
           c.billing_anchor_day,
           s.id            AS subscription_id,
           p.name          AS package_name,
           p.speed_mbps    AS package_speed_mbps,
           s.monthly_price,
           s.discount,
           COALESCE((
             SELECT SUM(i.total - i.amount_paid)
               FROM invoices i
              WHERE i.customer_id = c.id
                AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')
           ), 0) AS carried_balance
      FROM customers c
      LEFT JOIN subscriptions s ON s.customer_id = c.id AND s.ended_on IS NULL
      LEFT JOIN packages      p ON p.id = s.package_id
     WHERE c.deleted_at IS NULL
       AND c.status NOT IN ('INACTIVE','INCOMPLETE')
       AND c.billing_anchor_day IS NOT NULL
  `;

  const result: GenerationResult = {
    businessDate,
    examined: customers.length,
    created: 0,
    skippedExisting: 0,
    skippedIncomplete: 0,
    invoiceIds: [],
  };

  for (const c of customers) {
    // §58: never invent a price. A customer with no live subscription is a
    // data problem to surface, not a number to guess.
    if (!c.subscription_id || c.monthly_price === null || !c.package_name) {
      result.skippedIncomplete++;
      continue;
    }

    const current = cycleContaining(c.billing_anchor_day, businessDate);
    const upcoming = nextCycle(c.billing_anchor_day, current);

    // Only open the next cycle once we are within the lead window.
    const daysToStart =
      (Date.parse(upcoming.periodStart) - Date.parse(businessDate)) / 86_400_000;

    for (const cycle of daysToStart <= leadDays ? [current, upcoming] : [current]) {
      const monthlyPrice = rupeesToPaisa(Number(c.monthly_price));
      const discount = rupeesToPaisa(Number(c.discount));
      const total = Math.max(0, monthlyPrice - discount);
      const dueDate = dueDateFor(cycle.periodEnd, graceDays);

      try {
        const rows = await sql<{ id: string }[]>`
          INSERT INTO invoices (
            invoice_no, customer_id, subscription_id,
            package_name, package_speed_mbps,
            period_start, period_end, due_date,
            amount, previous_balance, discount, total, status
          ) VALUES (
            ${invoiceNumber(cycle.periodEnd, c.customer_code)},
            ${c.id}, ${c.subscription_id},
            ${c.package_name}, ${c.package_speed_mbps ?? 0},
            ${cycle.periodStart}, ${cycle.periodEnd}, ${dueDate},
            ${paisaToRupees(monthlyPrice)}, 0,
            ${paisaToRupees(discount)}, ${paisaToRupees(total)}, 'UNPAID'
          )
          RETURNING id
        `;
        result.created++;
        result.invoiceIds.push(rows[0]!.id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          result.skippedExisting++;
          continue;
        }
        throw err;
      }
    }
  }

  return result;
}

/**
 * Refreshes UNPAID -> OVERDUE for bills past their due date, and repairs any
 * status that has drifted from amount_paid. Derived status means the two can
 * never disagree for long.
 */
export async function refreshInvoiceStatuses(
  sql: Sql,
  businessDate: IsoDate = todayInKarachi(),
): Promise<number> {
  const rows = await sql<
    { id: string; total: string; amount_paid: string; due_date: IsoDate; status: string }[]
  >`
    SELECT id, total, amount_paid, due_date, status
      FROM invoices
     WHERE status NOT IN ('PAID','CANCELLED')
  `;

  let updated = 0;
  for (const r of rows) {
    const next = deriveStatus(
      rupeesToPaisa(Number(r.total)),
      rupeesToPaisa(Number(r.amount_paid)),
      r.due_date,
      businessDate,
    );
    if (next !== r.status) {
      await sql`UPDATE invoices SET status = ${next} WHERE id = ${r.id}`;
      updated++;
    }
  }
  return updated;
}

export interface RecordPaymentInput {
  customerId: string;
  amountRupees: number;
  paidOn: IsoDate;
  method: string;
  referenceNo?: string | null;
  notes?: string | null;
  recordedBy: string;
  /** Apply to a specific invoice; otherwise oldest-first across open bills. */
  invoiceId?: string | null;
}

export interface RecordPaymentResult {
  paymentId: string;
  receiptNo: string;
  allocations: { invoiceId: string; appliedRupees: number; settled: boolean }[];
  surplusRupees: number;
}

/**
 * Records a payment inside one transaction: allocate, update invoices,
 * refresh customer status, skip queued reminders for settled bills, write the
 * audit row. The send worker also re-checks eligibility in case a job already
 * left the queue.
 */
export async function recordPayment(
  sql: Sql,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  if (input.amountRupees <= 0) throw new Error("Payment amount must be positive.");

  return sql.begin(async (tx) => {
    const openRows = await tx<
      { id: string; due_date: IsoDate; total: string; amount_paid: string }[]
    >`
      SELECT id, due_date, total, amount_paid
        FROM invoices
       WHERE customer_id = ${input.customerId}
         AND status NOT IN ('PAID','CANCELLED')
         ${input.invoiceId ? tx`AND id = ${input.invoiceId}` : tx``}
       ORDER BY due_date
         FOR UPDATE
    `;

    const open = openRows.map((r) => ({
      invoiceId: r.id,
      dueDate: r.due_date,
      total: rupeesToPaisa(Number(r.total)),
      amountPaid: rupeesToPaisa(Number(r.amount_paid)),
    }));

    const payment = rupeesToPaisa(input.amountRupees);
    const { allocations, surplus } =
      open.length > 0 ? allocatePayment(open, payment) : { allocations: [], surplus: payment };

    const receiptNo = await nextReceiptNo(tx, input.paidOn);

    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO payments (
        receipt_no, customer_id, invoice_id, amount, paid_on,
        method, reference_no, notes, recorded_by
      ) VALUES (
        ${receiptNo}, ${input.customerId},
        ${allocations[0]?.invoiceId ?? null},
        ${input.amountRupees}, ${input.paidOn},
        ${input.method}, ${input.referenceNo ?? null},
        ${input.notes ?? null}, ${input.recordedBy}
      )
      RETURNING id
    `;

    const today = todayInKarachi();
    for (const a of allocations) {
      const inv = open.find((o) => o.invoiceId === a.invoiceId)!;
      const status = deriveStatus(inv.total, a.newAmountPaid, inv.dueDate, today);
      await tx`
        UPDATE invoices
           SET amount_paid = ${paisaToRupees(a.newAmountPaid)},
               status      = ${status},
               paid_at     = ${status === "PAID" ? new Date() : null}
         WHERE id = ${a.invoiceId}
      `;
    }

    const settledIds = allocations.filter((a) => a.fullySettled).map((a) => a.invoiceId);
    if (settledIds.length > 0) {
      await tx`
        UPDATE whatsapp_notifications
           SET status = 'SKIPPED', skip_reason = 'ALREADY_PAID'
         WHERE invoice_id IN ${tx(settledIds)}
           AND status = 'QUEUED'
           AND notification_type IN ('TWO_DAY_REMINDER', 'FINAL_EXPIRY_WARNING')
      `;
    }

    await refreshCustomerStatus(tx, input.customerId, today);

    await tx`
      INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data)
      VALUES (${input.recordedBy}, 'payment.record', 'payment', ${inserted!.id},
              ${tx.json({
                amount: input.amountRupees,
                method: input.method,
                allocations: allocations.map((a) => ({
                  invoiceId: a.invoiceId,
                  applied: paisaToRupees(a.applied),
                })),
                surplus: paisaToRupees(surplus),
              })})
    `;

    return {
      paymentId: inserted!.id,
      receiptNo,
      allocations: allocations.map((a) => ({
        invoiceId: a.invoiceId,
        appliedRupees: paisaToRupees(a.applied),
        settled: a.fullySettled,
      })),
      surplusRupees: paisaToRupees(surplus),
    };
  }) as Promise<RecordPaymentResult>;
}

/**
 * Recomputes a customer's status from their open bills. ACTIVE customers move
 * to PAYMENT_DUE / OVERDUE and back; SUSPENDED and INACTIVE are administrative
 * states set by staff, so they are left alone.
 */
export async function refreshCustomerStatus(
  sql: Sql,
  customerId: string,
  businessDate: IsoDate = todayInKarachi(),
): Promise<void> {
  const [agg] = await sql<{ open_count: string; worst_due: IsoDate | null }[]>`
    SELECT COUNT(*) AS open_count, MIN(due_date) AS worst_due
      FROM invoices
     WHERE customer_id = ${customerId}
       AND status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')
  `;

  const openCount = Number(agg?.open_count ?? 0);
  const status =
    openCount === 0
      ? "ACTIVE"
      : agg?.worst_due && agg.worst_due < businessDate
        ? "OVERDUE"
        : "PAYMENT_DUE";

  await sql`
    UPDATE customers
       SET status = ${status},
           current_expiry_date = COALESCE(
             (SELECT MAX(period_end) FROM invoices WHERE customer_id = ${customerId}),
             current_expiry_date
           )
     WHERE id = ${customerId}
       AND status NOT IN ('SUSPENDED','INACTIVE','INCOMPLETE')
  `;
}

async function nextReceiptNo(sql: Sql, paidOn: IsoDate): Promise<string> {
  const { y, m } = parseIsoDate(paidOn);
  const prefix = `RCP-${y}-${String(m).padStart(2, "0")}-`;
  const [row] = await sql<{ n: string }[]>`
    SELECT COALESCE(MAX(SUBSTRING(receipt_no FROM '[0-9]+$')::int), 0) + 1 AS n
      FROM payments
     WHERE receipt_no LIKE ${prefix + "%"}
  `;
  return prefix + String(Number(row?.n ?? 1)).padStart(5, "0");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

/** Convenience for the dashboard: the cycle a customer is currently in. */
export function currentCycleFor(anchorDay: number, businessDate: IsoDate) {
  return cycleContaining(anchorDay, businessDate);
}

export { cycleFor };
