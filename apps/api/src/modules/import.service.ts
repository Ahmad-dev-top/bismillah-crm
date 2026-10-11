/**
 * Excel / CSV customer import (§29–§34).
 *
 * Built against the real Bismillah export, which drives several decisions
 * that a generic importer would get wrong:
 *
 *  - The sheet has NO header row. Data starts partway down and the first
 *    columns are blank, so header sniffing must be able to fail and fall back
 *    to positional mapping chosen by the operator.
 *  - Phone numbers arrive as Excel FLOATS with the leading zero eaten:
 *    03134630184 is stored as 3134630184. Formatting a float naively gives
 *    "3134630184" or worse "3.13463e+09".
 *  - One phone number legitimately appears on several rows (families, shops).
 *    The schema forbids that, so it has to be surfaced as a decision rather
 *    than silently dropped.
 *  - Package and price are absent entirely, so every row is INCOMPLETE.
 *    §58: never invent a price. Import and flag.
 */

import * as XLSX from "xlsx";
import { normalizeMsisdn, isIsoDate, type IsoDate } from "@bi/domain";

export type FieldName =
  | "serial"
  | "customer_code"
  | "full_name"
  | "phone"
  | "whatsapp"
  | "cnic"
  | "address"
  | "area"
  | "package"
  | "monthly_price"
  | "expiry_date"
  | "installation_date"
  | "ip_address"
  | "notes"
  | "ignore";

/** Which spreadsheet column feeds which CRM field. Chosen by the operator. */
export type ColumnMapping = Record<number, FieldName>;

/**
 * Date format is never sniffed. 03/09/2026 is 3 September or 9 March
 * depending on who typed it, and guessing wrong silently shifts every
 * expiry date by months — the exact class of error that then sends 548
 * customers a wrong date over WhatsApp.
 */
export type DateFormat = "ISO" | "DMY" | "MDY" | "EXCEL_SERIAL";

export interface ParseOptions {
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  /** 0-based row index where data begins. Detected, operator-confirmable. */
  firstDataRow: number;
  sheetName?: string;
}

export type RowVerdict = "VALID" | "INCOMPLETE" | "DUPLICATE" | "ERROR";

export interface ParsedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalized: {
    fullName?: string;
    phone?: string;
    whatsapp?: string;
    cnic?: string | null;
    address?: string | null;
    area?: string | null;
    packageName?: string | null;
    monthlyPrice?: number | null;
    expiryDate?: IsoDate | null;
    installationDate?: IsoDate | null;
    billingAnchorDay?: number | null;
    namePrefix?: string | null;
  };
  verdict: RowVerdict;
  missingFields: string[];
  problems: string[];
  duplicateOfRow?: number;
}

export interface ImportPreview {
  totalRows: number;
  valid: number;
  incomplete: number;
  duplicates: number;
  errors: number;
  /** Field -> how many rows lack it. Tells the operator what to go collect. */
  missingByField: Record<string, number>;
  /** Normalized number -> the rows that share it. Schema forbids sharing. */
  sharedNumbers: Record<string, number[]>;
  rows: ParsedRow[];
}

/* --------------------------- sheet reading ---------------------------- */

export interface SheetShape {
  sheetNames: string[];
  totalRows: number;
  columnCount: number;
  /** First row that looks like data rather than blanks or a title block. */
  firstDataRow: number;
  /** Detected header row, or null when the sheet has no headers. */
  headerRow: number | null;
  /** Per-column samples so the operator can map without opening Excel. */
  columns: { index: number; nonEmpty: number; samples: string[] }[];
  suggestedMapping: ColumnMapping;
}

const HEADER_HINTS: [RegExp, FieldName][] = [
  [/^(s\.?no|serial|sr|#)$/i, "serial"],
  [/(customer.*id|cust.*code|account.*no|user.*id)/i, "customer_code"],
  [/(name|customer|user|username|client)/i, "full_name"],
  [/(whats.?app|wa.?no)/i, "whatsapp"],
  [/(phone|mobile|contact|cell|number|no\.)/i, "phone"],
  [/(cnic|nic|id.?card)/i, "cnic"],
  [/(address|location|street)/i, "address"],
  [/(area|zone|sector|block)/i, "area"],
  [/(package|plan|speed|mbps|pkg)/i, "package"],
  [/(price|fee|amount|rent|charges|monthly)/i, "monthly_price"],
  [/(expiry|expire|due|valid.*till|end.*date)/i, "expiry_date"],
  [/(install|activation|start.*date|joining)/i, "installation_date"],
  [/(ip)/i, "ip_address"],
];

/**
 * Inspects the workbook so the operator can map columns from the UI.
 *
 * Header detection is allowed to return null. This file has no headers at
 * all — an importer that assumed row 1 held them would map every field to
 * a customer's data and silently corrupt the first record.
 */
export function inspectSheet(buffer: Buffer, sheetName?: string): SheetShape {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const name = sheetName ?? wb.SheetNames[0]!;
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found`);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: true,
    raw: true,
    defval: null,
  });

  const columnCount = grid.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);

  // A data row is one where several cells are populated. Title blocks and
  // stray single cells (this file has a lone "0" in row 1) are not data.
  const populated = (r: unknown[] | undefined) =>
    (r ?? []).filter((c) => c !== null && c !== undefined && c !== "").length;

  const typicalWidth = Math.max(
    2,
    Math.round(
      grid.map(populated).filter((n) => n > 1).sort((a, b) => b - a)[
        Math.floor(grid.filter((r) => populated(r) > 1).length / 2)
      ] ?? 2,
    ),
  );

  let firstDataRow = grid.findIndex((r) => populated(r) >= Math.min(3, typicalWidth));
  if (firstDataRow < 0) firstDataRow = 0;

  // A header row is one whose cells are all strings, immediately above data.
  let headerRow: number | null = null;
  const candidate = grid[firstDataRow - 1];
  if (candidate && populated(candidate) >= 2) {
    const cells = candidate.filter((c) => c !== null && c !== "");
    if (cells.every((c) => typeof c === "string")) headerRow = firstDataRow - 1;
  }

  const columns: SheetShape["columns"] = [];
  for (let i = 0; i < columnCount; i++) {
    const values = grid
      .slice(firstDataRow)
      .map((r) => r?.[i])
      .filter((v) => v !== null && v !== undefined && v !== "");
    columns.push({
      index: i,
      nonEmpty: values.length,
      samples: values.slice(0, 5).map(cellToDisplay),
    });
  }

  return {
    sheetNames: wb.SheetNames,
    totalRows: grid.length - firstDataRow,
    columnCount,
    firstDataRow,
    headerRow,
    columns,
    suggestedMapping: suggestMapping(grid, headerRow, firstDataRow, columnCount),
  };
}

/**
 * Best-effort mapping suggestion. Uses headers when present; otherwise infers
 * from the shape of the values themselves. Always a suggestion — the operator
 * confirms before anything is written.
 */
function suggestMapping(
  grid: unknown[][],
  headerRow: number | null,
  firstDataRow: number,
  columnCount: number,
): ColumnMapping {
  const mapping: ColumnMapping = {};

  if (headerRow !== null) {
    const headers = grid[headerRow] ?? [];
    for (let i = 0; i < columnCount; i++) {
      const h = String(headers[i] ?? "").trim();
      if (!h) continue;
      const hit = HEADER_HINTS.find(([re]) => re.test(h));
      mapping[i] = hit ? hit[1] : "ignore";
    }
    return mapping;
  }

  // No headers: infer from value shape.
  const body = grid.slice(firstDataRow, firstDataRow + 200);
  for (let i = 0; i < columnCount; i++) {
    const vals = body.map((r) => r?.[i]).filter((v) => v !== null && v !== "");
    if (vals.length === 0) {
      mapping[i] = "ignore";
      continue;
    }
    const dateish = vals.filter((v) => v instanceof Date).length / vals.length;
    const phoneish =
      vals.filter((v) => {
        const digits = String(typeof v === "number" ? Math.round(v) : v).replace(/\D/g, "");
        return digits.length >= 9 && digits.length <= 12 && /^(0?3|92)/.test(digits);
      }).length / vals.length;
    const stringish = vals.filter((v) => typeof v === "string").length / vals.length;
    const sequential =
      vals.filter((v) => typeof v === "number").length / vals.length > 0.9 &&
      Number(vals[0]) <= 2;

    if (dateish > 0.7) mapping[i] = "expiry_date";
    else if (phoneish > 0.7) mapping[i] = "phone";
    else if (sequential) mapping[i] = "serial";
    else if (stringish > 0.7) mapping[i] = "full_name";
    else mapping[i] = "ignore";
  }
  return mapping;
}

function cellToDisplay(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}

/* ------------------------------ parsing -------------------------------- */

/**
 * Excel stores a phone typed as 03134630184 as the NUMBER 3134630184 —
 * the leading zero is gone and large values may render in scientific
 * notation. Reconstructing the digits before normalization is what makes
 * 531 of these rows importable instead of 0.
 */
export function cellToPhoneDigits(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return String(Math.round(v));
  }
  const s = String(v).trim();
  // Scientific notation survives a round trip through Number.
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) return String(Math.round(Number(s)));
  return s;
}

export function parseDateCell(v: unknown, format: DateFormat): IsoDate | null {
  if (v === null || v === undefined || v === "") return null;

  if (v instanceof Date) {
    // cellDates gives a UTC-midnight Date; take the calendar parts directly
    // so no timezone can shift the day.
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }

  if (typeof v === "number") {
    if (format !== "EXCEL_SERIAL") return null;
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  }

  const s = String(v).trim();
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return normalizeParts(+iso[1]!, +iso[2]!, +iso[3]!);

  const parts = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (parts) {
    const a = +parts[1]!, b = +parts[2]!;
    let y = +parts[3]!;
    if (y < 100) y += 2000;
    // No sniffing: the operator's declared format decides.
    return format === "MDY" ? normalizeParts(y, a, b) : normalizeParts(y, b, a);
  }
  return null;
}

function normalizeParts(y: number, m: number, d: number): IsoDate | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isIsoDate(iso) ? (iso as IsoDate) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Usernames in this export carry a numeric prefix — "10mwaseem", "12adnan".
 * That almost certainly encodes a pole, box or area. It is preserved as a
 * separate field rather than guessed at: §58 forbids inventing meaning, but
 * throwing the digits away would lose real operational information.
 */
export function splitNamePrefix(raw: string): { prefix: string | null; name: string } {
  const m = raw.trim().match(/^(\d+)\s*[-_.]?\s*(.+)$/);
  if (!m) return { prefix: null, name: raw.trim() };
  return { prefix: m[1]!, name: m[2]!.trim() };
}

/** Fields that must be present for a customer to be billable. */
const REQUIRED: { field: string; label: string }[] = [
  { field: "full_name", label: "Customer name" },
  { field: "phone", label: "Phone number" },
  { field: "package", label: "Package" },
  { field: "monthly_price", label: "Monthly price" },
  { field: "expiry_date", label: "Expiry date" },
];

export function parseWorkbook(buffer: Buffer, opts: ParseOptions): ImportPreview {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const name = opts.sheetName ?? wb.SheetNames[0]!;
  const ws = wb.Sheets[name]!;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1, blankrows: true, raw: true, defval: null,
  });

  const rows: ParsedRow[] = [];
  const seenPhone = new Map<string, number>();
  // Usernames must be unique on the router, so a repeat inside one export is
  // a genuine duplicate. Merging the two silently would collapse two paying
  // customers into one record, so it is surfaced instead.
  const seenUsername = new Map<string, number>();
  const sharedNumbers: Record<string, number[]> = {};
  const missingByField: Record<string, number> = {};

  for (let r = opts.firstDataRow; r < grid.length; r++) {
    const line = grid[r];
    if (!line || line.every((c) => c === null || c === "")) continue;

    const rowNumber = r + 1; // 1-based, matches what Excel shows the operator
    const raw: Record<string, unknown> = {};
    const parsed: ParsedRow = {
      rowNumber,
      raw,
      normalized: {},
      verdict: "VALID",
      missingFields: [],
      problems: [],
    };

    for (const [colStr, field] of Object.entries(opts.mapping)) {
      const col = Number(colStr);
      const value = line[col] ?? null;
      if (field === "ignore") continue;
      raw[field] = value instanceof Date ? value.toISOString().slice(0, 10) : value;

      switch (field) {
        case "full_name": {
          const s = value === null ? "" : String(value).trim();
          if (s) {
            // Keep the spreadsheet name verbatim, including any leading
            // digits (10mwaseem). The prefix is still stored separately so
            // bulk-assign by legacy_group keeps working.
            const { prefix } = splitNamePrefix(s);
            parsed.normalized.fullName = s;
            parsed.normalized.namePrefix = prefix;
          }
          break;
        }
        case "phone":
        case "whatsapp": {
          const digits = cellToPhoneDigits(value);
          if (!digits) break;
          const res = normalizeMsisdn(digits);
          if (res.ok) {
            if (field === "phone") parsed.normalized.phone = res.msisdn;
            else parsed.normalized.whatsapp = res.msisdn;
          } else {
            parsed.problems.push(`${field}: ${res.reason} (${digits})`);
          }
          break;
        }
        case "expiry_date": {
          const d = parseDateCell(value, opts.dateFormat);
          if (d) {
            parsed.normalized.expiryDate = d;
            // §15: the day of the expiry date IS the customer's billing anchor.
            parsed.normalized.billingAnchorDay = Number(d.slice(8, 10));
          } else if (value !== null && value !== "") {
            parsed.problems.push(`expiry_date: unparseable (${String(value)})`);
          }
          break;
        }
        case "monthly_price": {
          const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
          if (Number.isFinite(n) && n > 0) parsed.normalized.monthlyPrice = n;
          break;
        }
        case "package":
          if (value) parsed.normalized.packageName = String(value).trim();
          break;
        case "area":
          if (value) parsed.normalized.area = String(value).trim();
          break;
        case "address":
          if (value) parsed.normalized.address = String(value).trim();
          break;
        case "cnic": {
          const cnic = value === null ? "" : String(value).trim();
          if (/^\d{5}-\d{7}-\d$/.test(cnic)) parsed.normalized.cnic = cnic;
          break;
        }
        case "installation_date": {
          const d = parseDateCell(value, opts.dateFormat);
          if (d) parsed.normalized.installationDate = d;
          else if (value !== null && value !== "") {
            parsed.problems.push(`installation_date: unparseable (${String(value)})`);
          }
          break;
        }
      }
    }

    // WhatsApp defaults to the phone when no separate column exists.
    parsed.normalized.whatsapp ??= parsed.normalized.phone;

    const rawUsername = String(raw["full_name"] ?? "").trim();

    for (const { field } of REQUIRED) {
      const has =
        field === "full_name" ? !!parsed.normalized.fullName
        : field === "phone" ? !!parsed.normalized.phone
        : field === "package" ? !!parsed.normalized.packageName
        : field === "monthly_price" ? parsed.normalized.monthlyPrice != null
        : !!parsed.normalized.expiryDate;
      if (!has) {
        parsed.missingFields.push(field);
        missingByField[field] = (missingByField[field] ?? 0) + 1;
      }
    }

    // A row with no name at all is unusable; everything else is recoverable.
    if (!parsed.normalized.fullName) {
      parsed.verdict = "ERROR";
      parsed.problems.push("No customer name — cannot create a record.");
    } else if (seenUsername.has(rawUsername)) {
      parsed.verdict = "DUPLICATE";
      parsed.duplicateOfRow = seenUsername.get(rawUsername);
      parsed.problems.push(
        `Username "${rawUsername}" already used by row ${seenUsername.get(rawUsername)}.`,
      );
    } else if (parsed.normalized.phone) {
      seenUsername.set(rawUsername, rowNumber);
      const prev = seenPhone.get(parsed.normalized.phone);
      if (prev !== undefined) {
        parsed.verdict = "DUPLICATE";
        parsed.duplicateOfRow = prev;
        (sharedNumbers[parsed.normalized.phone] ??= [prev]).push(rowNumber);
      } else {
        seenPhone.set(parsed.normalized.phone, rowNumber);
      }
    } else if (rawUsername) {
      seenUsername.set(rawUsername, rowNumber);
    }

    // §30: missing data flags the row, it never rejects it.
    if (parsed.verdict === "VALID" && parsed.missingFields.length > 0) {
      parsed.verdict = "INCOMPLETE";
    }

    rows.push(parsed);
  }

  return {
    totalRows: rows.length,
    valid: rows.filter((r) => r.verdict === "VALID").length,
    incomplete: rows.filter((r) => r.verdict === "INCOMPLETE").length,
    duplicates: rows.filter((r) => r.verdict === "DUPLICATE").length,
    errors: rows.filter((r) => r.verdict === "ERROR").length,
    missingByField,
    sharedNumbers,
    rows,
  };
}

/* ------------------------------ commit --------------------------------- */

import type { Sql } from "../db/index.ts";

export interface CommitOptions {
  /**
   * What to do with a row whose phone is already claimed by another customer.
   * The schema forbids one number across two customers — that constraint is
   * what makes cross-customer mis-sends impossible, so it is not relaxed here.
   *
   *  IMPORT_WITHOUT_NUMBER  create the customer, attach no number (default).
   *                         The customer is not lost; they simply cannot be
   *                         messaged until staff resolve the collision.
   *  SKIP                   do not create the customer at all.
   */
  onSharedNumber?: "IMPORT_WITHOUT_NUMBER" | "SKIP";
  /** Re-running an import updates matched customers instead of duplicating. */
  onExisting?: "UPDATE" | "SKIP";
  actorId?: string | null;
  batchId?: string | null;
}

export interface CommitResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  numbersAttached: number;
  numbersWithheld: number;
  incomplete: number;
  failures: { rowNumber: number; reason: string }[];
}

/**
 * Writes a parsed preview into the database.
 *
 * Deliberately does NOT create invoices. These rows carry no package and no
 * price, so there is nothing to bill; §58 forbids inventing one. Customers
 * land as INCOMPLETE with their gaps recorded in missing_fields, and become
 * billable the moment staff fill those in through the app.
 *
 * Idempotent via customers_legacy_username_idx.
 */
export async function commitImport(
  sql: Sql,
  preview: ImportPreview,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const onShared = opts.onSharedNumber ?? "IMPORT_WITHOUT_NUMBER";
  const onExisting = opts.onExisting ?? "UPDATE";

  const result: CommitResult = {
    created: 0, updated: 0, skipped: 0, failed: 0,
    numbersAttached: 0, numbersWithheld: 0, incomplete: 0, failures: [],
  };

  // Rows flagged DUPLICATE lost a race against an earlier row for the same
  // number. They are still real customers.
  const sharedRows = new Set(
    Object.values(preview.sharedNumbers).flat(),
  );

  for (const row of preview.rows) {
    if (row.verdict === "ERROR") {
      result.skipped++;
      continue;
    }

    const n = row.normalized;
    const isShared = sharedRows.has(row.rowNumber) && row.verdict === "DUPLICATE";
    // A row that lost the username race must not reuse that username, or the
    // unique index would merge it into the earlier customer's record.
    const usernameTaken = row.problems.some((p) => p.startsWith("Username \""));
    const rawUsername = String(row.raw["full_name"] ?? "").trim() || null;
    // A collided username gets a deterministic suffix rather than NULL.
    // NULL would make the row unmatchable on re-import, so every re-run would
    // create one more copy of it — silent growth that only shows up months later.
    const legacyUsername =
      usernameTaken && rawUsername ? `${rawUsername}#row${row.rowNumber}` : rawUsername;

    if (isShared && onShared === "SKIP") {
      result.skipped++;
      continue;
    }

    // Withhold the number only from the LATER row(s) claiming it, so the
    // first customer keeps it and the collision is visible on the rest.
    const attachNumber = n.phone && !(isShared && onShared === "IMPORT_WITHOUT_NUMBER");

    const missing = [...row.missingFields];
    if (!attachNumber && !missing.includes("phone")) missing.push("phone");

    try {
      await sql.begin(async (tx) => {
        const existing = legacyUsername
          ? await tx<{ id: string }[]>`
              SELECT id FROM customers WHERE legacy_username = ${legacyUsername}`
          : [];

        let customerId: string;

        if (existing.length > 0) {
          if (onExisting === "SKIP") {
            result.skipped++;
            return;
          }
          customerId = existing[0]!.id;
          const [live] = await tx<{ has_sub: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM subscriptions WHERE customer_id = ${customerId} AND ended_on IS NULL
            ) AS has_sub`;
          const keepStatus = Boolean(live?.has_sub);
          if (keepStatus) {
            await tx`
              UPDATE customers SET
                full_name           = ${n.fullName ?? null},
                legacy_group        = COALESCE(${n.namePrefix ?? null}, legacy_group),
                cnic                = COALESCE(${n.cnic ?? null}, cnic),
                installation_date   = COALESCE(${n.installationDate ?? null}, installation_date),
                primary_phone       = COALESCE(${attachNumber ? n.phone! : null}, primary_phone),
                billing_anchor_day  = COALESCE(${n.billingAnchorDay ?? null}, billing_anchor_day),
                current_expiry_date = COALESCE(${n.expiryDate ?? null}, current_expiry_date)
              WHERE id = ${customerId}`;
          } else {
            await tx`
              UPDATE customers SET
                full_name           = ${n.fullName ?? null},
                legacy_group        = COALESCE(${n.namePrefix ?? null}, legacy_group),
                cnic                = COALESCE(${n.cnic ?? null}, cnic),
                installation_date   = COALESCE(${n.installationDate ?? null}, installation_date),
                primary_phone       = COALESCE(${attachNumber ? n.phone! : null}, primary_phone),
                billing_anchor_day  = COALESCE(${n.billingAnchorDay ?? null}, billing_anchor_day),
                current_expiry_date = COALESCE(${n.expiryDate ?? null}, current_expiry_date),
                missing_fields      = ${missing},
                status              = ${missing.length ? "INCOMPLETE" : "ACTIVE"}
              WHERE id = ${customerId}`;
          }
          result.updated++;
        } else {
          const [seq] = await tx<{ n: string }[]>`
            SELECT COALESCE(MAX(SUBSTRING(customer_code FROM '[0-9]+$')::int), 0) + 1 AS n
              FROM customers WHERE customer_code LIKE 'BI-%'`;
          const code = "BI-" + String(Number(seq?.n ?? 1)).padStart(6, "0");

          const [c] = await tx<{ id: string }[]>`
            INSERT INTO customers (
              customer_code, full_name, primary_phone, status, missing_fields,
              billing_anchor_day, current_expiry_date, installation_date, cnic,
              legacy_username, legacy_group)
            VALUES (
              ${code}, ${n.fullName ?? "(unnamed)"}, ${attachNumber ? n.phone! : null},
              ${missing.length ? "INCOMPLETE" : "ACTIVE"}, ${missing},
              ${n.billingAnchorDay ?? null}, ${n.expiryDate ?? null},
              ${n.installationDate ?? null}, ${n.cnic ?? null},
              ${legacyUsername}, ${n.namePrefix ?? null})
            RETURNING id`;
          customerId = c!.id;
          result.created++;
        }

        if (attachNumber) {
          const whatsapp = n.whatsapp ?? n.phone!;
          // Only one primary per customer. On a re-import the customer may
          // already have one, so the flag is computed rather than assumed.
          const [hasPrimary] = await tx<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM customer_whatsapp_numbers
               WHERE customer_id = ${customerId} AND is_primary
            ) AS exists`;
          const inserted = await tx`
            INSERT INTO customer_whatsapp_numbers (customer_id, msisdn, state, is_primary)
            VALUES (${customerId}, ${whatsapp}, 'UNVERIFIED', ${!hasPrimary?.exists})
            ON CONFLICT (msisdn) DO NOTHING
            RETURNING msisdn`;
          if (inserted.length > 0) result.numbersAttached++;
          else result.numbersWithheld++;
        } else if (n.phone) {
          result.numbersWithheld++;
        }

        if (missing.length) result.incomplete++;
      });
    } catch (err) {
      result.failed++;
      result.failures.push({
        rowNumber: row.rowNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
