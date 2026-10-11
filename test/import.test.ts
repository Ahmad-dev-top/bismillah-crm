/**
 * Import tests, run against the REAL Bismillah export. Synthetic fixtures
 * would not have caught the float-encoded phone numbers or the absent
 * header row — both of which a naive importer gets silently wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  inspectSheet, parseWorkbook, cellToPhoneDigits, parseDateCell, splitNamePrefix,
} from "../apps/api/src/modules/import.service.ts";

const FILE = process.env.SAMPLE_XLSX ?? "/mnt/user-data/uploads/1788083476192_Pakistan.xlsx";
const buf = existsSync(FILE) ? readFileSync(FILE) : null;

test("Excel float phone numbers keep their digits", () => {
  // 03134630184 typed into Excel becomes the number 3134630184.
  assert.equal(cellToPhoneDigits(3134630184), "3134630184");
  assert.equal(cellToPhoneDigits(3.134630184e9), "3134630184");
  assert.equal(cellToPhoneDigits("0313-4630184"), "0313-4630184");
  assert.equal(cellToPhoneDigits(null), null);
  assert.equal(cellToPhoneDigits(""), null);
});

test("date parsing never guesses between DMY and MDY", () => {
  assert.equal(parseDateCell("03/09/2026", "DMY"), "2026-09-03");
  assert.equal(parseDateCell("03/09/2026", "MDY"), "2026-03-09");
  assert.equal(parseDateCell("2026-09-15", "ISO"), "2026-09-15");
  assert.equal(parseDateCell("31/02/2026", "DMY"), null, "impossible date rejected");
  assert.equal(parseDateCell(new Date(Date.UTC(2026, 8, 15)), "ISO"), "2026-09-15");
});

test("username prefixes are preserved, not discarded or guessed at", () => {
  assert.deepEqual(splitNamePrefix("10mwaseem"), { prefix: "10", name: "mwaseem" });
  assert.deepEqual(splitNamePrefix("12adnan"), { prefix: "12", name: "adnan" });
  assert.deepEqual(splitNamePrefix("waseem"), { prefix: null, name: "waseem" });
});

test("headerless sheet is detected and mapped", { skip: !buf }, () => {
  const shape = inspectSheet(buf!);
  assert.equal(shape.headerRow, null, "this file genuinely has no header row");
  assert.ok(shape.firstDataRow > 0, "data does not start at row 0");
  const fields = Object.values(shape.suggestedMapping);
  for (const f of ["full_name", "phone", "expiry_date"]) {
    assert.ok(fields.includes(f as any), `auto-detection found ${f}`);
  }
});

test("real file: every row survives import, none rejected", { skip: !buf }, () => {
  const shape = inspectSheet(buf!);
  const p = parseWorkbook(buf!, {
    mapping: shape.suggestedMapping, dateFormat: "ISO", firstDataRow: shape.firstDataRow,
  });
  assert.equal(p.totalRows, 548);
  assert.equal(p.errors, 0, "§30: no row is rejected for missing data");
  assert.equal(p.valid + p.incomplete + p.duplicates + p.errors, p.totalRows);
});

test("real file: absent price/package flags every row incomplete, invents nothing",
  { skip: !buf }, () => {
    const shape = inspectSheet(buf!);
    const p = parseWorkbook(buf!, {
      mapping: shape.suggestedMapping, dateFormat: "ISO", firstDataRow: shape.firstDataRow,
    });
    assert.equal(p.missingByField["package"], 548);
    assert.equal(p.missingByField["monthly_price"], 548);
    assert.equal(p.valid, 0, "nothing is billable until prices are supplied");
    for (const r of p.rows) {
      assert.equal(r.normalized.monthlyPrice ?? null, null, "§58: no invented price");
    }
  });

test("real file: shared phone numbers are surfaced, not silently dropped",
  { skip: !buf }, () => {
    const shape = inspectSheet(buf!);
    const p = parseWorkbook(buf!, {
      mapping: shape.suggestedMapping, dateFormat: "ISO", firstDataRow: shape.firstDataRow,
    });
    assert.ok(p.duplicates > 0);
    for (const [msisdn, rows] of Object.entries(p.sharedNumbers)) {
      assert.match(msisdn, /^\+923\d{9}$/);
      assert.ok(rows.length >= 2);
    }
  });

test("real file: expiry day becomes the billing anchor day", { skip: !buf }, () => {
  const shape = inspectSheet(buf!);
  const p = parseWorkbook(buf!, {
    mapping: shape.suggestedMapping, dateFormat: "ISO", firstDataRow: shape.firstDataRow,
  });
  for (const r of p.rows) {
    if (!r.normalized.expiryDate) continue;
    assert.equal(r.normalized.billingAnchorDay, Number(r.normalized.expiryDate.slice(8, 10)));
    assert.ok(r.normalized.billingAnchorDay! >= 1 && r.normalized.billingAnchorDay! <= 31);
  }
});

test("real file: unparseable phones are reported with a reason", { skip: !buf }, () => {
  const shape = inspectSheet(buf!);
  const p = parseWorkbook(buf!, {
    mapping: shape.suggestedMapping, dateFormat: "ISO", firstDataRow: shape.firstDataRow,
  });
  const phoneProblems = p.rows.flatMap((r) => r.problems).filter((x) => x.startsWith("phone:"));
  assert.ok(phoneProblems.length > 0);
  for (const x of phoneProblems) assert.match(x, /TOO_SHORT|TOO_LONG|NOT_PK_MOBILE|NON_NUMERIC/);
});

test("re-importing the same file twice does not duplicate customers",
  { skip: !buf || !process.env.TEST_DATABASE_URL }, async () => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(process.env.TEST_DATABASE_URL!, {
      types: { date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v } },
      onnotice: () => {},
    });
    const { commitImport } = await import("../apps/api/src/modules/import.service.ts");
    await sql`TRUNCATE customer_whatsapp_numbers, customers RESTART IDENTITY CASCADE`;

    const shape = inspectSheet(buf!);
    const opts = { mapping: shape.suggestedMapping, dateFormat: "ISO" as const, firstDataRow: shape.firstDataRow };

    const first = await commitImport(sql, parseWorkbook(buf!, opts));
    const second = await commitImport(sql, parseWorkbook(buf!, opts));

    assert.equal(first.created, 548);
    assert.equal(first.failed, 0);
    assert.equal(second.created, 0, "second run creates nothing");
    assert.equal(second.failed, 0, "second run does not error");

    const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*) FROM customers`;
    assert.equal(Number(count), 548, "still exactly 548 customers");

    const shared = await sql`
      SELECT msisdn FROM customer_whatsapp_numbers
       GROUP BY msisdn HAVING COUNT(DISTINCT customer_id) > 1`;
    assert.equal(shared.length, 0, "no number ever shared across customers");
    await sql.end();
  });
