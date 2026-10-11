import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEligibility, notificationKey, type NotificationCandidate,
} from "../src/eligibility.ts";

const base: NotificationCandidate = {
  customerId: "cust-a",
  customerStatus: "ACTIVE",
  recipientMsisdn: "+923001234567",
  numberState: "VALID",
  invoiceId: "inv-a",
  invoiceStatus: "UNPAID",
  amountDue: 2500,
  expiryDate: "2026-09-15",
  alreadySent: false,
};
const c = (o: Partial<NotificationCandidate> = {}) => ({ ...base, ...o });

test("two-day reminder fires exactly two days out", () => {
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", c(), "2026-09-13"),
    { eligible: true });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", c(), "2026-09-12"),
    { eligible: false, reason: "NOT_DUE_YET" });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", c(), "2026-09-14"),
    { eligible: false, reason: "WINDOW_PASSED" });
});

test("final expiry fires on the expiry date only", () => {
  assert.deepEqual(evaluateEligibility("FINAL_EXPIRY_WARNING", c(), "2026-09-15"),
    { eligible: true });
  assert.deepEqual(evaluateEligibility("FINAL_EXPIRY_WARNING", c(), "2026-09-14"),
    { eligible: false, reason: "NOT_DUE_YET" });
  assert.deepEqual(evaluateEligibility("FINAL_EXPIRY_WARNING", c(), "2026-09-16"),
    { eligible: false, reason: "WINDOW_PASSED" });
});

test("SPEC 25: paying before the expiry warning suppresses it", () => {
  // Reminder went out on the 13th, customer pays on the 14th.
  const paid = c({ invoiceStatus: "PAID", amountDue: 0 });
  assert.deepEqual(evaluateEligibility("FINAL_EXPIRY_WARNING", paid, "2026-09-15"),
    { eligible: false, reason: "ALREADY_PAID" });
});

test("a zero balance suppresses even when status lags behind", () => {
  const settled = c({ invoiceStatus: "UNPAID", amountDue: 0 });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", settled, "2026-09-13"),
    { eligible: false, reason: "ALREADY_PAID" });
});

test("a partial payment still owes money, so it still sends", () => {
  const partial = c({ invoiceStatus: "PARTIALLY_PAID", amountDue: 500 });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", partial, "2026-09-13"),
    { eligible: true });
});

test("recipient gates", () => {
  const cases: [Partial<NotificationCandidate>, string][] = [
    [{ recipientMsisdn: null }, "NO_WHATSAPP_NUMBER"],
    [{ recipientMsisdn: "03001234567" }, "NUMBER_NOT_NORMALIZED"],
    [{ numberState: "OPTED_OUT" }, "OPTED_OUT"],
    [{ numberState: "INVALID" }, "NUMBER_INVALID"],
    [{ customerStatus: "INACTIVE" }, "CUSTOMER_INACTIVE"],
    [{ customerStatus: "INCOMPLETE" }, "CUSTOMER_INCOMPLETE"],
    [{ invoiceStatus: "CANCELLED" }, "INVOICE_CANCELLED"],
    [{ alreadySent: true }, "ALREADY_SENT"],
  ];
  for (const [patch, reason] of cases) {
    const r = evaluateEligibility("TWO_DAY_REMINDER", c(patch), "2026-09-13");
    assert.equal(r.eligible, false, `should refuse ${reason}`);
    if (!r.eligible) assert.equal(r.reason, reason);
  }
});

test("suspended customers still get billing reminders", () => {
  // Suspension is usually FOR non-payment; silencing them defeats the purpose.
  assert.deepEqual(
    evaluateEligibility("TWO_DAY_REMINDER", c({ customerStatus: "SUSPENDED" }), "2026-09-13"),
    { eligible: true });
});

test("already-sent wins over every other reason (idempotency first)", () => {
  const r = evaluateEligibility("TWO_DAY_REMINDER",
    c({ alreadySent: true, recipientMsisdn: null }), "2026-09-13");
  assert.equal(r.eligible === false && r.reason, "ALREADY_SENT");
});

test("window logic holds across a month end and a leap day", () => {
  const marchExpiry = c({ expiryDate: "2026-03-01" });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", marchExpiry, "2026-02-27"),
    { eligible: true });
  const leap = c({ expiryDate: "2028-03-01" });
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", leap, "2028-02-28"),
    { eligible: true }, "29 Feb sits between, so the 28th is two days out");
  assert.deepEqual(evaluateEligibility("TWO_DAY_REMINDER", leap, "2028-02-29"),
    { eligible: false, reason: "WINDOW_PASSED" });
});

test("idempotency key matches the DB unique index shape", () => {
  assert.equal(notificationKey("inv-a", "TWO_DAY_REMINDER"), "TWO_DAY_REMINDER:inv-a");
  assert.notEqual(
    notificationKey("inv-a", "TWO_DAY_REMINDER"),
    notificationKey("inv-a", "FINAL_EXPIRY_WARNING"));
});
