/**
 * Phone normalization for Pakistani mobile numbers.
 *
 * Every number entering the system — typed, imported, or pasted — passes
 * through normalizeMsisdn() before it touches the database. The `msisdn`
 * domain in schema.sql rejects anything that is not already E.164, so a
 * normalization miss surfaces as a constraint error rather than a silent
 * bad send.
 *
 * PK mobile numbers: country code 92, then a 3-digit network code beginning
 * with 3, then 7 subscriber digits. National form is 11 digits starting 03.
 */

export type PhoneParseResult =
  | { ok: true; msisdn: string }
  | { ok: false; reason: PhoneError; input: string };

export type PhoneError =
  | "EMPTY"
  | "NON_NUMERIC"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "NOT_PK_MOBILE"
  | "AMBIGUOUS";

/** Digits after the +92 country code, for a valid PK mobile. */
const PK_NSN_LENGTH = 10;

/**
 * Strips formatting humans and Excel introduce: spaces, dashes, dots,
 * parentheses, non-breaking spaces, and the Unicode bidi marks that Urdu
 * keyboards leave behind. Also folds Eastern Arabic-Indic digits (۰-۹) and
 * Arabic-Indic digits (٠-٩) to ASCII, which appear routinely in data typed
 * on Urdu layouts.
 */
export function scrubPhoneInput(raw: string): string {
  let s = raw.normalize("NFKC");
  // Bidi / zero-width marks
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
  // Eastern Arabic-Indic (Urdu/Persian) digits
  s = s.replace(/[\u06F0-\u06F9]/g, (d) =>
    String(d.charCodeAt(0) - 0x06f0),
  );
  // Arabic-Indic digits
  s = s.replace(/[\u0660-\u0669]/g, (d) =>
    String(d.charCodeAt(0) - 0x0660),
  );
  // Common separators
  s = s.replace(/[\s\-().\u00A0/]/g, "");
  return s.trim();
}

/**
 * Normalizes a Pakistani mobile number to E.164 (+92XXXXXXXXXX).
 *
 * Accepted inputs, all yielding +923001234567:
 *   03001234567        national form
 *   3001234567         leading zero dropped (very common in Excel, where the
 *                      column was formatted as a number)
 *   +923001234567      already E.164
 *   923001234567       E.164 without the plus
 *   0092 300 1234567   international prefix form
 *   0300-1234567       dashed
 */
export function normalizeMsisdn(raw: string | null | undefined): PhoneParseResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "EMPTY", input: "" };
  }
  const input = String(raw);
  let s = scrubPhoneInput(input);

  if (s === "") return { ok: false, reason: "EMPTY", input };

  // Normalize the international prefix to a bare "+"
  if (s.startsWith("00")) s = "+" + s.slice(2);
  const hadPlus = s.startsWith("+");
  if (hadPlus) s = s.slice(1);

  if (!/^\d+$/.test(s)) return { ok: false, reason: "NON_NUMERIC", input };

  // Reduce to the national significant number (NSN) after the 92 country code.
  let nsn: string;
  if (s.startsWith("92")) {
    nsn = s.slice(2);
    // "92" is also a valid start to nothing else in PK national form, but a
    // bare 10-digit local number could theoretically begin 92. PK mobiles
    // always start with 3 after the country code, so this stays unambiguous.
  } else if (s.startsWith("0")) {
    nsn = s.replace(/^0+/, "");
  } else {
    nsn = s;
  }

  // Prefix is checked before length: a Lahore landline (0421234567) is both
  // too short AND not a mobile, and "not a mobile number" is the reason that
  // tells import staff what to actually fix.
  if (!nsn.startsWith("3")) return { ok: false, reason: "NOT_PK_MOBILE", input };
  if (nsn.length < PK_NSN_LENGTH) return { ok: false, reason: "TOO_SHORT", input };
  if (nsn.length > PK_NSN_LENGTH) return { ok: false, reason: "TOO_LONG", input };

  return { ok: true, msisdn: "+92" + nsn };
}

/** True only for strings already in the exact stored form. */
export function isNormalizedMsisdn(value: string): boolean {
  return /^\+923\d{9}$/.test(value);
}

/** Display form for the UI and receipts: +92 300 1234567 -> 0300-1234567 */
export function toNationalDisplay(msisdn: string): string {
  if (!isNormalizedMsisdn(msisdn)) return msisdn;
  const nsn = msisdn.slice(3); // drop +92
  return `0${nsn.slice(0, 3)}-${nsn.slice(3)}`;
}

/**
 * Normalizes a batch and reports collisions. Used by the import preview to
 * detect two spreadsheet rows that are the same customer written differently
 * (0300-1234567 and +923001234567) BEFORE either is inserted.
 */
export function findDuplicateMsisdns(
  rows: { rowNumber: number; phone: string }[],
): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  for (const r of rows) {
    const res = normalizeMsisdn(r.phone);
    if (!res.ok) continue;
    const list = seen.get(res.msisdn);
    if (list) list.push(r.rowNumber);
    else seen.set(res.msisdn, [r.rowNumber]);
  }
  for (const [k, v] of seen) if (v.length < 2) seen.delete(k);
  return seen;
}
