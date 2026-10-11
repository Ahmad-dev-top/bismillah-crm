/**
 * End-to-end verification of the notification pipeline against a real
 * PostgreSQL database with the production schema and constraints.
 *
 * These are the tests that matter for §17, §23, §25 and §26: unit tests prove
 * the rules, but only this proves the rules, the SQL and the constraints agree.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { runSweep, recheckBeforeSend } from "../apps/api/src/modules/notifications.service.ts";

const URL = process.env.TEST_DATABASE_URL!;
const sql = postgres(URL, {
  types: { date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v } },
  onnotice: () => {},
});

const TEMPLATE =
  "Assalam o Alaikum {{customer_name}}. Your Bismillah Internet bill of " +
  "{{amount_due}} is due on {{expiry_date}}. Pay via JazzCash/EasyPaisa/Raast: " +
  "0335-7287782. Details: https://bismillah.net.pk/pay";

before(async () => {
  await sql`INSERT INTO whatsapp_templates (code, notification_type, provider_name, language_code, body)
            VALUES ('two_day','TWO_DAY_REMINDER','bi_two_day','ur',${TEMPLATE}),
                   ('final','FINAL_EXPIRY_WARNING','bi_final','ur',${TEMPLATE})
            ON CONFLICT (code) DO NOTHING`;
});

beforeEach(async () => {
  await sql`TRUNCATE whatsapp_notifications, payments, invoices, subscriptions,
            customer_whatsapp_numbers, customers, audit_logs RESTART IDENTITY CASCADE`;
});

after(async () => { await sql.end(); });

async function seedCustomer(o: {
  code: string; name: string; msisdn: string; expiry: string;
  anchor: number; total: number; paid?: number;
}) {
  const [c] = await sql<{ id: string }[]>`
    INSERT INTO customers (customer_code, full_name, status, billing_anchor_day)
    VALUES (${o.code}, ${o.name}, 'ACTIVE', ${o.anchor}) RETURNING id`;
  await sql`INSERT INTO customer_whatsapp_numbers (customer_id, msisdn, state)
            VALUES (${c!.id}, ${o.msisdn}, 'VALID')`;
  const [i] = await sql<{ id: string }[]>`
    INSERT INTO invoices (invoice_no, customer_id, package_name, package_speed_mbps,
      period_start, period_end, due_date, amount, total, amount_paid, status, paid_at)
    VALUES (${"INV-" + o.code}, ${c!.id}, '20 Mbps Fiber', 20,
      '2026-08-16', ${o.expiry}, ${o.expiry}, ${o.total}, ${o.total},
      ${o.paid ?? 0}, ${(o.paid ?? 0) >= o.total ? "PAID" : "UNPAID"},
      ${(o.paid ?? 0) >= o.total ? new Date() : null})
    RETURNING id`;
  return { customerId: c!.id, invoiceId: i!.id };
}

test("SPEC 23: two customers, two dates, no crossover", async () => {
  await seedCustomer({ code: "BI-000124", name: "Muhammad Ahmed",
    msisdn: "+923001234567", expiry: "2026-09-15", anchor: 15, total: 2500 });
  await seedCustomer({ code: "BI-000125", name: "Ali Khan",
    msisdn: "+923002222222", expiry: "2026-09-15", anchor: 15, total: 3000 });

  const r = await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });
  assert.equal(r.queued, 2);

  const rows = await sql<{ customer_name: string; recipient_msisdn: string; rendered_body: string }[]>`
    SELECT customer_name, recipient_msisdn, rendered_body
      FROM whatsapp_notifications ORDER BY customer_name`;

  assert.equal(rows[0]!.customer_name, "Ali Khan");
  assert.equal(rows[0]!.recipient_msisdn, "+923002222222");
  assert.match(rows[0]!.rendered_body, /Ali Khan/);
  assert.match(rows[0]!.rendered_body, /Rs\. 3,000/);
  assert.ok(!rows[0]!.rendered_body.includes("Ahmed"), "no crossover of names");

  assert.equal(rows[1]!.customer_name, "Muhammad Ahmed");
  assert.equal(rows[1]!.recipient_msisdn, "+923001234567");
  assert.match(rows[1]!.rendered_body, /Rs\. 2,500/);
  assert.match(rows[1]!.rendered_body, /15 September 2026/);
});

test("SPEC 26: running the sweep twice queues nothing the second time", async () => {
  await seedCustomer({ code: "BI-1", name: "A", msisdn: "+923001111111",
    expiry: "2026-09-15", anchor: 15, total: 2500 });

  const first = await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });
  const second = await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });

  assert.equal(first.queued, 1);
  assert.equal(second.queued, 0);
  assert.equal(second.skipped["ALREADY_SENT"], 1);

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) FROM whatsapp_notifications`;
  assert.equal(Number(count), 1, "exactly one message ever queued");
});

test("SPEC 25: a payment between queue and send suppresses the message", async () => {
  const { invoiceId } = await seedCustomer({ code: "BI-2", name: "B",
    msisdn: "+923002222221", expiry: "2026-09-15", anchor: 15, total: 2500 });

  const r = await runSweep(sql, "FINAL_EXPIRY_WARNING", { businessDate: "2026-09-15" });
  assert.equal(r.queued, 1);
  const notificationId = r.queuedIds[0]!;

  // Green light before payment.
  assert.equal(await recheckBeforeSend(sql, notificationId, "2026-09-15"), null);

  // Counter takes cash.
  await sql`UPDATE invoices SET amount_paid = 2500, status = 'PAID', paid_at = now()
             WHERE id = ${invoiceId}`;

  // Red light after.
  assert.equal(await recheckBeforeSend(sql, notificationId, "2026-09-15"), "ALREADY_PAID");
});

test("the sweep respects the exact day window", async () => {
  await seedCustomer({ code: "BI-3", name: "C", msisdn: "+923003333333",
    expiry: "2026-09-15", anchor: 15, total: 2500 });

  assert.equal((await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-12" })).queued, 0);
  assert.equal((await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-14" })).queued, 0);
  assert.equal((await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" })).queued, 1);
});

test("customers without a number are skipped with a stated reason, not crashed on", async () => {
  const [c] = await sql<{ id: string }[]>`
    INSERT INTO customers (customer_code, full_name, status, billing_anchor_day)
    VALUES ('BI-4','No Number','ACTIVE',15) RETURNING id`;
  await sql`INSERT INTO invoices (invoice_no, customer_id, package_name,
      package_speed_mbps, period_start, period_end, due_date, amount, total)
    VALUES ('INV-BI-4', ${c!.id}, '20 Mbps', 20, '2026-08-16','2026-09-15','2026-09-15',2500,2500)`;

  const r = await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });
  assert.equal(r.queued, 0);
  assert.equal(r.skipped["NO_WHATSAPP_NUMBER"], 1);
});

test("an already-paid bill never enters the queue at all", async () => {
  await seedCustomer({ code: "BI-5", name: "Paid", msisdn: "+923005555555",
    expiry: "2026-09-15", anchor: 15, total: 2500, paid: 2500 });

  const r = await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });
  assert.equal(r.queued, 0);
  assert.equal(r.skipped["ALREADY_PAID"], 1);
});

test("provider params are frozen at queue time in template order", async () => {
  await seedCustomer({ code: "BI-6", name: "Sana", msisdn: "+923006666666",
    expiry: "2026-09-15", anchor: 15, total: 1800 });
  await runSweep(sql, "TWO_DAY_REMINDER", { businessDate: "2026-09-13" });

  const [row] = await sql<{ template_params: string[] }[]>`
    SELECT template_params FROM whatsapp_notifications`;
  assert.deepEqual(row!.template_params, ["Sana", "Rs. 1,800", "15 September 2026"]);
});
