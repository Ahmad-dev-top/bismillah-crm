/**
 * Notification eligibility — the single decision function for "may we send
 * this customer this message right now?"
 *
 * Every gate the spec lists (§2, §19, §25) lives here as a pure function so it
 * can be exhaustively tested without a database or a WhatsApp provider. The
 * sweep job and the send worker both call it: the sweep to decide what to
 * queue, the worker to RE-CHECK immediately before dispatch, because a cash
 * payment recorded at the counter between queue and send must suppress the
 * message.
 *
 * A decision is never a bare boolean. Every refusal carries a reason, which is
 * written to whatsapp_notifications.skip_reason so the notification centre can
 * explain why a customer was passed over.
 */

import { type IsoDate, daysUntilExpiry, todayInKarachi } from "./dates.ts";
import { isNormalizedMsisdn } from "./phone.ts";

export type NotificationType =
  | "TWO_DAY_REMINDER"
  | "FINAL_EXPIRY_WARNING"
  | "PAYMENT_CONFIRMATION";

export type CustomerStatus =
  | "ACTIVE"
  | "PAYMENT_DUE"
  | "OVERDUE"
  | "SUSPENDED"
  | "INACTIVE"
  | "INCOMPLETE";

export type InvoiceStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "OVERDUE"
  | "CANCELLED";

export type WhatsappNumberState = "UNVERIFIED" | "VALID" | "INVALID" | "OPTED_OUT";

export type SkipReason =
  | "NO_WHATSAPP_NUMBER"
  | "NUMBER_NOT_NORMALIZED"
  | "NUMBER_INVALID"
  | "OPTED_OUT"
  | "CUSTOMER_INACTIVE"
  | "CUSTOMER_INCOMPLETE"
  | "INVOICE_CANCELLED"
  | "ALREADY_PAID"
  | "NOT_DUE_YET"
  | "WINDOW_PASSED"
  | "ALREADY_SENT";

/** Everything the decision needs. Assembled from ONE customer's row set. */
export interface NotificationCandidate {
  customerId: string;
  customerStatus: CustomerStatus;
  /** The number as stored in customer_whatsapp_numbers for THIS customer. */
  recipientMsisdn: string | null;
  numberState: WhatsappNumberState;
  invoiceId: string;
  invoiceStatus: InvoiceStatus;
  /** total - amount_paid, in PKR. */
  amountDue: number;
  /** period_end of the invoice: the customer's expiry date for this cycle. */
  expiryDate: IsoDate;
  /** True if a row already exists for (invoiceId, type) and is not CANCELLED. */
  alreadySent: boolean;
}

export type EligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: SkipReason };

const SEND_BLOCKING_CUSTOMER_STATUS: ReadonlySet<CustomerStatus> = new Set([
  "INACTIVE",
  "INCOMPLETE",
]);

const SETTLED_INVOICE_STATUS: ReadonlySet<InvoiceStatus> = new Set(["PAID", "CANCELLED"]);

/**
 * Gates common to every automated notification.
 * Ordered cheapest-first, and so that the returned reason is the most
 * actionable one for staff (a missing number is more useful to surface than
 * "not due yet").
 */
function commonGates(c: NotificationCandidate): EligibilityDecision {
  if (c.alreadySent) return { eligible: false, reason: "ALREADY_SENT" };

  if (SEND_BLOCKING_CUSTOMER_STATUS.has(c.customerStatus)) {
    return {
      eligible: false,
      reason:
        c.customerStatus === "INCOMPLETE" ? "CUSTOMER_INCOMPLETE" : "CUSTOMER_INACTIVE",
    };
  }

  if (!c.recipientMsisdn) return { eligible: false, reason: "NO_WHATSAPP_NUMBER" };
  if (!isNormalizedMsisdn(c.recipientMsisdn)) {
    return { eligible: false, reason: "NUMBER_NOT_NORMALIZED" };
  }
  if (c.numberState === "OPTED_OUT") return { eligible: false, reason: "OPTED_OUT" };
  if (c.numberState === "INVALID") return { eligible: false, reason: "NUMBER_INVALID" };

  if (c.invoiceStatus === "CANCELLED") {
    return { eligible: false, reason: "INVOICE_CANCELLED" };
  }

  return { eligible: true };
}

/**
 * §25: payment-aware. A bill that is settled suppresses both the reminder and
 * the expiry warning. PARTIALLY_PAID still owes money, so it still sends.
 */
function unpaidGate(c: NotificationCandidate): EligibilityDecision {
  if (SETTLED_INVOICE_STATUS.has(c.invoiceStatus)) {
    return { eligible: false, reason: "ALREADY_PAID" };
  }
  if (c.amountDue <= 0) return { eligible: false, reason: "ALREADY_PAID" };
  return { eligible: true };
}

/**
 * Decides whether `candidate` may receive `type` today.
 *
 * `today` is injected rather than read from the clock so the same function is
 * used by the scheduler and by tests covering month boundaries and leap days.
 */
export function evaluateEligibility(
  type: NotificationType,
  candidate: NotificationCandidate,
  today: IsoDate = todayInKarachi(),
): EligibilityDecision {
  const common = commonGates(candidate);
  if (!common.eligible) return common;

  const unpaid = unpaidGate(candidate);
  if (!unpaid.eligible) return unpaid;

  const remaining = daysUntilExpiry(candidate.expiryDate, today);

  switch (type) {
    case "TWO_DAY_REMINDER": {
      // Exactly two days before expiry. Not three, not one — a late reminder
      // that says "expires in 2 days" would be a lie.
      if (remaining > 2) return { eligible: false, reason: "NOT_DUE_YET" };
      if (remaining < 2) return { eligible: false, reason: "WINDOW_PASSED" };
      return { eligible: true };
    }
    case "FINAL_EXPIRY_WARNING": {
      // Fires at 00:00 on the expiry date itself.
      if (remaining > 0) return { eligible: false, reason: "NOT_DUE_YET" };
      if (remaining < 0) return { eligible: false, reason: "WINDOW_PASSED" };
      return { eligible: true };
    }
    case "PAYMENT_CONFIRMATION": {
      // Sent on payment, not on a schedule; the unpaid gate does not apply.
      return { eligible: true };
    }
  }
}

/**
 * Confirmation messages invert the unpaid gate: they require a settled bill.
 * Kept separate so the unpaid gate above stays unambiguous.
 */
export function evaluatePaymentConfirmation(
  candidate: NotificationCandidate,
): EligibilityDecision {
  const common = commonGates(candidate);
  if (!common.eligible) return common;
  if (!SETTLED_INVOICE_STATUS.has(candidate.invoiceStatus) && candidate.amountDue > 0) {
    return { eligible: false, reason: "NOT_DUE_YET" };
  }
  return { eligible: true };
}

/**
 * Logical idempotency key, mirroring the partial unique index
 * whatsapp_one_per_cycle on (invoice_id, notification_type).
 *
 * The invoice IS the billing cycle, so this key is stable across worker
 * restarts and across re-runs of the same sweep. Used as the BullMQ jobId so
 * a duplicate enqueue is dropped by Redis before it ever reaches Postgres.
 */
export function notificationKey(invoiceId: string, type: NotificationType): string {
  return `${type}:${invoiceId}`;
}

/** Human-readable skip reasons for the notification centre. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  NO_WHATSAPP_NUMBER: "No WhatsApp number on record",
  NUMBER_NOT_NORMALIZED: "Stored number is not in +92 format",
  NUMBER_INVALID: "Number rejected by the provider as not on WhatsApp",
  OPTED_OUT: "Customer opted out of notifications",
  CUSTOMER_INACTIVE: "Customer is inactive",
  CUSTOMER_INCOMPLETE: "Customer profile is incomplete",
  INVOICE_CANCELLED: "Invoice was cancelled",
  ALREADY_PAID: "Bill was paid before sending",
  NOT_DUE_YET: "Not yet within the notification window",
  WINDOW_PASSED: "Notification window has passed",
  ALREADY_SENT: "Already sent for this billing cycle",
};
