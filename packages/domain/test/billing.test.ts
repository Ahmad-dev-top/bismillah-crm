import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rupeesToPaisa, paisaToRupees, formatPkr, computeTotals, deriveStatus,
  amountDue, allocatePayment, dueDateFor, invoiceNumber,
} from "../src/billing.ts";

test("money is exact across carried-forward balances", () => {
  // 12 cycles of Rs 2500.10 carried forward in floats drifts; in paisa it does not.
  let balance = 0;
  for (let i = 0; i < 12; i++) balance += rupeesToPaisa(2500.10);
  assert.equal(balance, 3_000_120, "30,001.20 rupees exactly");
  assert.equal(paisaToRupees(balance), 30001.2);
});

test("totals apply previous balance then discount", () => {
  const t = computeTotals({
    monthlyPrice: rupeesToPaisa(2500),
    previousBalance: rupeesToPaisa(500),
    discount: rupeesToPaisa(200),
  });
  assert.equal(t.total, rupeesToPaisa(2800));
});

test("a discount cannot make a bill negative", () => {
  const t = computeTotals({
    monthlyPrice: rupeesToPaisa(2500), previousBalance: 0,
    discount: rupeesToPaisa(9999),
  });
  assert.equal(t.total, 0);
  assert.equal(t.discount, rupeesToPaisa(2500));
});

test("status derives from payment and time, never contradicting the amount", () => {
  const total = rupeesToPaisa(2500);
  assert.equal(deriveStatus(total, 0, "2026-09-15", "2026-09-10"), "UNPAID");
  assert.equal(deriveStatus(total, 0, "2026-09-15", "2026-09-16"), "OVERDUE");
  assert.equal(deriveStatus(total, rupeesToPaisa(500), "2026-09-15", "2026-09-10"), "PARTIALLY_PAID");
  assert.equal(deriveStatus(total, rupeesToPaisa(500), "2026-09-15", "2026-09-16"), "OVERDUE");
  assert.equal(deriveStatus(total, total, "2026-09-15", "2026-09-30"), "PAID",
    "paid stays paid even past the due date");
  assert.equal(deriveStatus(total, total + 100, "2026-09-15", "2026-09-16"), "PAID");
  assert.equal(deriveStatus(total, 0, "2026-09-15", "2026-09-16", true), "CANCELLED");
  assert.equal(deriveStatus(total, 0, "2026-09-15", "2026-09-15"), "UNPAID",
    "due today is not yet overdue");
});

test("amountDue floors at zero on overpayment", () => {
  assert.equal(amountDue(rupeesToPaisa(2500), rupeesToPaisa(3000)), 0);
});

test("payments settle the oldest invoice first", () => {
  const open = [
    { invoiceId: "sep", dueDate: "2026-09-15", total: rupeesToPaisa(2500), amountPaid: 0 },
    { invoiceId: "aug", dueDate: "2026-08-15", total: rupeesToPaisa(2500), amountPaid: 0 },
  ];
  const { allocations, surplus } = allocatePayment(open, rupeesToPaisa(3000));
  assert.equal(allocations[0]!.invoiceId, "aug");
  assert.equal(allocations[0]!.applied, rupeesToPaisa(2500));
  assert.equal(allocations[0]!.fullySettled, true);
  assert.equal(allocations[1]!.invoiceId, "sep");
  assert.equal(allocations[1]!.applied, rupeesToPaisa(500));
  assert.equal(allocations[1]!.fullySettled, false);
  assert.equal(surplus, 0);
});

test("overpayment leaves a surplus rather than vanishing", () => {
  const open = [{ invoiceId: "a", dueDate: "2026-09-15", total: rupeesToPaisa(2500), amountPaid: 0 }];
  const { allocations, surplus } = allocatePayment(open, rupeesToPaisa(4000));
  assert.equal(allocations.length, 1);
  assert.equal(surplus, rupeesToPaisa(1500));
});

test("already-settled invoices are skipped during allocation", () => {
  const open = [
    { invoiceId: "paid", dueDate: "2026-07-15", total: rupeesToPaisa(2500), amountPaid: rupeesToPaisa(2500) },
    { invoiceId: "open", dueDate: "2026-08-15", total: rupeesToPaisa(2500), amountPaid: 0 },
  ];
  const { allocations } = allocatePayment(open, rupeesToPaisa(2500));
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0]!.invoiceId, "open");
});

test("a non-positive payment is rejected", () => {
  assert.throws(() => allocatePayment([], 0), RangeError);
  assert.throws(() => allocatePayment([], -100), RangeError);
});

test("due date and invoice number", () => {
  assert.equal(dueDateFor("2026-09-15"), "2026-09-15");
  assert.equal(dueDateFor("2026-09-15", 5), "2026-09-20");
  assert.equal(invoiceNumber("2026-09-15", "BI-000124"), "INV-2026-09-000124");
});

test("PKR formatting", () => {
  assert.equal(formatPkr(rupeesToPaisa(2500)), "Rs. 2,500");
  assert.equal(formatPkr(rupeesToPaisa(2500.5)), "Rs. 2,500.50");
});
