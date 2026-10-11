/**
 * Bulk package/price assignment. Unit tests always run; database tests skip
 * unless TEST_DATABASE_URL is set (same pattern as import.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bulkAssignSchema,
  computeMissingFields,
  bulkAssignPackage,
  BulkAssignError,
} from "../apps/api/src/modules/bulk-assign.service.ts";

test("schema rejects a missing monthlyPrice — never invent one from the package", () => {
  const parsed = bulkAssignSchema.safeParse({ legacyGroup: "10", packageId: 1 });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((i) => i.path[0] === "monthlyPrice"));
  }
});

test("schema rejects a null or zero monthlyPrice", () => {
  assert.equal(
    bulkAssignSchema.safeParse({ legacyGroup: "10", packageId: 1, monthlyPrice: null }).success,
    false,
  );
  assert.equal(
    bulkAssignSchema.safeParse({ legacyGroup: "10", packageId: 1, monthlyPrice: 0 }).success,
    false,
  );
  assert.equal(
    bulkAssignSchema.safeParse({ legacyGroup: "10", packageId: 1, monthlyPrice: -100 }).success,
    false,
  );
});

test("schema accepts an explicit positive price and defaults confirm to false", () => {
  const parsed = bulkAssignSchema.parse({
    legacyGroup: "10",
    packageId: 1,
    monthlyPrice: 2500,
  });
  assert.equal(parsed.confirm, false);
  assert.equal(parsed.monthlyPrice, 2500);
});

test("computeMissingFields drops package/price once a subscription exists", () => {
  const after = computeMissingFields({
    fullName: "mwaseem",
    primaryPhone: "+923001234567",
    billingAnchorDay: 15,
    hasSubscription: true,
  });
  assert.deepEqual(after, []);
});

test("computeMissingFields keeps phone gaps so INCOMPLETE is not flipped to ACTIVE", () => {
  const after = computeMissingFields({
    fullName: "mwaseem",
    primaryPhone: null,
    billingAnchorDay: 15,
    hasSubscription: true,
  });
  assert.deepEqual(after, ["phone"]);
});

test("computeMissingFields still flags package and price when there is no subscription", () => {
  const before = computeMissingFields({
    fullName: "mwaseem",
    primaryPhone: "+923001234567",
    billingAnchorDay: 15,
    hasSubscription: false,
  });
  assert.deepEqual(before, ["package", "monthly_price"]);
});

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

test("dry-run writes nothing; confirm creates subscriptions and flips only complete rows", {
  skip: !hasDb,
}, async (t) => {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.TEST_DATABASE_URL!, {
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    onnotice: () => {},
  });

  await sql`TRUNCATE whatsapp_notifications, payments, invoices, subscriptions,
            customer_whatsapp_numbers, customers, audit_logs RESTART IDENTITY CASCADE`;

  const [pkg] = await sql<{ id: number }[]>`
    INSERT INTO packages (code, name, speed_mbps, monthly_price)
    VALUES ('PKG-BULK-20', '20 Mbps Fiber', 20, 9999)
    ON CONFLICT (code) DO UPDATE SET monthly_price = 9999
    RETURNING id`;
  const packageId = pkg!.id;

  // Complete row: should become ACTIVE.
  await sql`
    INSERT INTO customers (customer_code, full_name, primary_phone, status, missing_fields,
      billing_anchor_day, current_expiry_date, legacy_username, legacy_group)
    VALUES ('BI-100001', 'mwaseem', '+923001234567', 'INCOMPLETE',
      ${["package", "monthly_price"]}, 15, '2026-09-15', '10mwaseem', '10')`;

  // No phone: stays INCOMPLETE after assign.
  await sql`
    INSERT INTO customers (customer_code, full_name, primary_phone, status, missing_fields,
      billing_anchor_day, current_expiry_date, legacy_username, legacy_group)
    VALUES ('BI-100002', 'orphaned', NULL, 'INCOMPLETE',
      ${["phone", "package", "monthly_price"]}, 18, '2026-09-18', '10orphaned', '10')`;

  // Different group: must not be touched.
  await sql`
    INSERT INTO customers (customer_code, full_name, primary_phone, status, missing_fields,
      billing_anchor_day, current_expiry_date, legacy_username, legacy_group)
    VALUES ('BI-120001', 'adnan', '+923009999999', 'INCOMPLETE',
      ${["package", "monthly_price"]}, 20, '2026-09-20', '12adnan', '12')`;

  t.after(async () => {
    await sql`DELETE FROM packages WHERE id = ${packageId}`;
    await sql.end();
  });

  const dry = await bulkAssignPackage(sql, {
    legacyGroup: "10",
    packageId,
    monthlyPrice: 2500,
    confirm: false,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.matched, 2);
  assert.equal(dry.assigned, 2);
  assert.equal(dry.becameActive, 1);
  assert.equal(dry.remainedIncomplete, 1);
  assert.equal(dry.remainingMissing.phone, 1);
  assert.equal(dry.package.listPrice, 9999, "list price is informational");
  assert.equal(dry.monthlyPrice, 2500, "operator price is what would be written");

  const [{ subsBefore }] = await sql<{ subsBefore: string }[]>`SELECT COUNT(*) AS subsBefore FROM subscriptions`;
  assert.equal(Number(subsBefore), 0, "dry-run must not insert subscriptions");

  const committed = await bulkAssignPackage(sql, {
    legacyGroup: "10",
    packageId,
    monthlyPrice: 2500,
    confirm: true,
  });
  assert.equal(committed.dryRun, false);
  assert.equal(committed.assigned, 2);
  assert.equal(committed.becameActive, 1);
  assert.equal(committed.remainedIncomplete, 1);

  const customers = await sql<{ customer_code: string; status: string; missing_fields: string[] }[]>`
    SELECT customer_code, status, missing_fields FROM customers ORDER BY customer_code`;
  const byCode = Object.fromEntries(customers.map((c) => [c.customer_code, c]));
  assert.equal(byCode["BI-100001"]!.status, "ACTIVE");
  assert.deepEqual(byCode["BI-100001"]!.missing_fields, []);
  assert.equal(byCode["BI-100002"]!.status, "INCOMPLETE");
  assert.deepEqual(byCode["BI-100002"]!.missing_fields, ["phone"]);
  assert.equal(byCode["BI-120001"]!.status, "INCOMPLETE", "other groups untouched");

  const subs = await sql<{ monthly_price: string; customer_code: string }[]>`
    SELECT s.monthly_price, c.customer_code
      FROM subscriptions s JOIN customers c ON c.id = s.customer_id
     ORDER BY c.customer_code`;
  assert.equal(subs.length, 2);
  for (const s of subs) {
    assert.equal(Number(s.monthly_price), 2500, "must write the operator price, not the package list price of 9999");
  }

  const audits = await sql<{ entity_id: string }[]>`
    SELECT entity_id FROM audit_logs WHERE action = 'customer.bulk_assign_package'`;
  assert.equal(audits.length, 2, "one audit row per assigned customer");

  const again = await bulkAssignPackage(sql, {
    legacyGroup: "10",
    packageId,
    monthlyPrice: 2500,
    confirm: true,
  });
  assert.equal(again.assigned, 0, "second confirm is a no-op — already subscribed or no longer INCOMPLETE");

  const [{ subCount }] = await sql<{ subCount: string }[]>`SELECT COUNT(*) AS subCount FROM subscriptions`;
  assert.equal(Number(subCount), 2, "no duplicate subscriptions");
});

test("unknown package and inactive package are rejected before any write", {
  skip: !hasDb,
}, async () => {
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.TEST_DATABASE_URL!, {
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
    onnotice: () => {},
  });

  await assert.rejects(
    () => bulkAssignPackage(sql, { legacyGroup: "10", packageId: 999999, monthlyPrice: 2500, confirm: true }),
    (err: unknown) => err instanceof BulkAssignError && err.statusCode === 404,
  );

  const [pkg] = await sql<{ id: number }[]>`
    INSERT INTO packages (code, name, speed_mbps, monthly_price, is_active)
    VALUES ('PKG-BULK-OFF', 'Off', 10, 1000, false)
    ON CONFLICT (code) DO UPDATE SET is_active = false
    RETURNING id`;

  await assert.rejects(
    () => bulkAssignPackage(sql, { legacyGroup: "10", packageId: pkg!.id, monthlyPrice: 2500, confirm: true }),
    (err: unknown) => err instanceof BulkAssignError && err.statusCode === 409,
  );

  await sql`DELETE FROM packages WHERE id = ${pkg!.id}`;
  await sql.end();
});
