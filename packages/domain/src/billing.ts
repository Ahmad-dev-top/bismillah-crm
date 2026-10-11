/**
 * Invoice money arithmetic.
 *
 * All money is handled in PAISA (integer minor units) internally. Currency in
 * floating point accumulates error across carried-forward balances; an ISP
 * carrying an unpaid balance across twelve cycles would visibly drift. The
 * database stores numeric(12,2), which is exact, and these helpers convert at
 * the boundary.
 */

import { type IsoDate, addDays } from "./dates.ts";
import type { InvoiceStatus } from "./eligibility.ts";

export type Paisa = number; // integer

export function rupeesToPaisa(rupees: number): Paisa {
  return Math.round(rupees * 100);
}

export function paisaToRupees(p: Paisa): number {
  return p / 100;
}

export function formatPkr(p: Paisa): string {
  const rupees = paisaToRupees(p);
  return `Rs. ${rupees.toLocaleString("en-PK", {
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface InvoiceDraft {
  monthlyPrice: Paisa;
  previousBalance: Paisa;
  discount: Paisa;
}

export interface InvoiceTotals {
  amount: Paisa;
  previousBalance: Paisa;
  discount: Paisa;
  total: Paisa;
}

export function computeTotals(d: InvoiceDraft): InvoiceTotals {
  if (d.monthlyPrice < 0) throw new RangeError("monthlyPrice must be >= 0");
  if (d.discount < 0) throw new RangeError("discount must be >= 0");
  const gross = d.monthlyPrice + d.previousBalance;
  const discount = Math.min(d.discount, gross);
  return {
    amount: d.monthlyPrice,
    previousBalance: d.previousBalance,
    discount,
    total: gross - discount,
  };
}

/**
 * Invoice status implied by payments so far. Derived rather than stored
 * independently, so status can never contradict amount_paid.
 *
 * OVERDUE is a time-dependent view of UNPAID/PARTIALLY_PAID, applied only once
 * the due date has passed.
 */
export function deriveStatus(
  total: Paisa,
  amountPaid: Paisa,
  dueDate: IsoDate,
  today: IsoDate,
  cancelled = false,
): InvoiceStatus {
  if (cancelled) return "CANCELLED";
  if (amountPaid >= total && total > 0) return "PAID";
  if (total === 0) return "PAID";
  const overdue = today > dueDate;
  if (amountPaid > 0) return overdue ? "OVERDUE" : "PARTIALLY_PAID";
  return overdue ? "OVERDUE" : "UNPAID";
}

export function amountDue(total: Paisa, amountPaid: Paisa): Paisa {
  return Math.max(0, total - amountPaid);
}

/**
 * Applies a payment across a customer's open invoices, oldest first.
 * Returns the allocation plus any surplus, which becomes an on-account credit
 * rather than being silently dropped.
 */
export interface OpenInvoice {
  invoiceId: string;
  dueDate: IsoDate;
  total: Paisa;
  amountPaid: Paisa;
}

export interface Allocation {
  invoiceId: string;
  applied: Paisa;
  newAmountPaid: Paisa;
  fullySettled: boolean;
}

export function allocatePayment(
  invoices: OpenInvoice[],
  payment: Paisa,
): { allocations: Allocation[]; surplus: Paisa } {
  if (payment <= 0) throw new RangeError("payment must be > 0");
  const ordered = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const allocations: Allocation[] = [];
  let remaining = payment;

  for (const inv of ordered) {
    if (remaining <= 0) break;
    const owed = amountDue(inv.total, inv.amountPaid);
    if (owed <= 0) continue;
    const applied = Math.min(owed, remaining);
    remaining -= applied;
    allocations.push({
      invoiceId: inv.invoiceId,
      applied,
      newAmountPaid: inv.amountPaid + applied,
      fullySettled: inv.amountPaid + applied >= inv.total,
    });
  }
  return { allocations, surplus: remaining };
}

/** Due date for a cycle: the expiry date itself, optionally with a grace period. */
export function dueDateFor(periodEnd: IsoDate, graceDays = 0): IsoDate {
  return graceDays === 0 ? periodEnd : addDays(periodEnd, graceDays);
}

/** INV-2026-09-000124 — sortable, human-readable, unique per customer-cycle. */
export function invoiceNumber(periodEnd: IsoDate, customerCode: string): string {
  const [y, m] = periodEnd.split("-");
  const seq = customerCode.replace(/^BI-/, "");
  return `INV-${y}-${m}-${seq}`;
}
