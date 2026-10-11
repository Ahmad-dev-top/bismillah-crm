#!/usr/bin/env node --experimental-strip-types
/**
 * One-off customer import from a spreadsheet.
 *
 *   DATABASE_URL=postgres://... \
 *   node --experimental-strip-types scripts/import-customers.ts <file.xlsx> [--commit]
 *
 * Without --commit it only prints the preview. Nothing is written until you
 * have read the numbers and agreed with them.
 */
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { createSql } from "../apps/api/src/db/index.ts";
import {
  inspectSheet,
  parseWorkbook,
  commitImport,
  type ColumnMapping,
  type DateFormat,
} from "../apps/api/src/modules/import.service.ts";

const file = process.argv[2];
const doCommit = process.argv.includes("--commit");
if (!file) {
  console.error("usage: import-customers.ts <file.xlsx> [--commit]");
  process.exit(1);
}

const buf = readFileSync(file);
const shape = inspectSheet(buf);

/** The Pakistan export: header on row 2, User ID / Cell No / Installation / Expiry / CNIC. */
function pakistanExportOptions(): {
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  firstDataRow: number;
} | null {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!], {
    header: 1, blankrows: true, raw: true, defval: null,
  });
  const header = (grid[1] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  const isPakistan =
    header[1]?.startsWith("user id") &&
    header[2]?.includes("cell") &&
    header[3]?.startsWith("install") &&
    header[4]?.startsWith("expir");
  if (!isPakistan) return null;
  return {
    mapping: {
      0: "serial",
      1: "full_name",
      2: "phone",
      3: "installation_date",
      4: "expiry_date",
      8: "cnic",
    },
    dateFormat: "ISO",
    firstDataRow: 2,
  };
}

const opts = pakistanExportOptions() ?? {
  mapping: shape.suggestedMapping,
  dateFormat: "ISO" as DateFormat,
  firstDataRow: shape.firstDataRow,
};

console.log(`sheet "${shape.sheetNames[0]}" · ${shape.totalRows} rows · ${shape.columnCount} columns`);
console.log(`header row: ${shape.headerRow ?? "none detected"} · data starts at row ${opts.firstDataRow + 1}`);
console.log("mapping:", Object.entries(opts.mapping)
  .filter(([, f]) => f !== "ignore").map(([c, f]) => `col${c}->${f}`).join("  "));

const preview = parseWorkbook(buf, opts);

console.log("\n--- PREVIEW ---");
console.log(`Total rows : ${preview.totalRows}`);
console.log(`Valid      : ${preview.valid}`);
console.log(`Incomplete : ${preview.incomplete}`);
console.log(`Duplicates : ${preview.duplicates}`);
console.log(`Errors     : ${preview.errors}`);
console.log("Missing by field:", preview.missingByField);
console.log("Shared numbers  :", Object.keys(preview.sharedNumbers).length);
const sample = preview.rows.slice(0, 5).map((r) => r.normalized.fullName).join(", ");
console.log("Sample names   :", sample);

if (!doCommit) {
  console.log("\nDry run. Re-run with --commit to write these customers.");
  process.exit(0);
}

const sql = createSql();
const result = await commitImport(sql, preview);
console.log("\n--- COMMITTED ---");
console.log(result);
await sql.end();
