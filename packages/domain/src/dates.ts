/**
 * Billing date arithmetic, Asia/Karachi.
 *
 * Two rules govern everything here:
 *
 *  1. Billing decisions compare CALENDAR DATES in Asia/Karachi, never UTC
 *     instants. Karachi is UTC+5 with no DST, so a naive UTC date is wrong
 *     for the first five hours of every Karachi day — which is exactly when
 *     the midnight expiry job runs.
 *
 *  2. Cycle ends derive from an immutable anchor day, never from the previous
 *     cycle end. Repeatedly adding a month to a stored date walks
 *     31 Jan -> 28 Feb -> 28 Mar and permanently loses the customer's real
 *     billing day. Anchoring gives 31 Jan -> 28 Feb -> 31 Mar.
 *
 * Dates are handled as plain "YYYY-MM-DD" strings. They carry no timezone and
 * cannot be accidentally shifted by a Date constructor.
 */

export const BUSINESS_TZ = "Asia/Karachi";

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: string): v is IsoDate {
  if (!ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

export function assertIsoDate(v: string): IsoDate {
  if (!isIsoDate(v)) throw new RangeError(`Not a valid ISO date: ${v}`);
  return v;
}

/** Today's calendar date in the business timezone. */
export function todayInKarachi(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now) as IsoDate;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function isLeapYear(year: number): boolean {
  return daysInMonth(year, 2) === 29;
}

export function parseIsoDate(d: IsoDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return { y, m, d: day };
}

export function formatIsoDate(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The end of the billing cycle falling in (year, month), for a customer whose
 * billing anchor day is `anchorDay`. Clamps to the last day of short months.
 *
 *   cycleEnd(31, 2026, 2) -> 2026-02-28
 *   cycleEnd(31, 2026, 3) -> 2026-03-31   (not 2026-03-28)
 *   cycleEnd(29, 2028, 2) -> 2028-02-29   (leap year)
 *   cycleEnd(30, 2026, 2) -> 2026-02-28
 *
 * Mirrors bi_cycle_end() in schema.sql. The two must not diverge.
 */
export function cycleEnd(anchorDay: number, year: number, month: number): IsoDate {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`anchorDay must be 1..31, got ${anchorDay}`);
  }
  // Normalize month overflow/underflow (month 13 -> next Jan, month 0 -> prev Dec)
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  return formatIsoDate(y, m, Math.min(anchorDay, daysInMonth(y, m)));
}

/** Adds days to a calendar date without any timezone involvement. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const { y, m, d } = parseIsoDate(date);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** b - a, in whole days. Positive when b is later. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round(
    (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000,
  );
}

export function compareIsoDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface BillingCycle {
  /** First day covered by the cycle. */
  periodStart: IsoDate;
  /** Last day covered — the customer's expiry date for this cycle. */
  periodEnd: IsoDate;
}

/**
 * The cycle whose end is the anchored date in (year, month).
 * periodStart is the day after the previous cycle's end, so cycles tile the
 * calendar with no gaps and no overlaps even across month-length changes.
 */
export function cycleFor(anchorDay: number, year: number, month: number): BillingCycle {
  const periodEnd = cycleEnd(anchorDay, year, month);
  const prevEnd = cycleEnd(anchorDay, year, month - 1);
  return { periodStart: addDays(prevEnd, 1), periodEnd };
}

/** The cycle that contains `date`. */
export function cycleContaining(anchorDay: number, date: IsoDate): BillingCycle {
  const { y, m } = parseIsoDate(date);
  const thisMonth = cycleFor(anchorDay, y, m);
  if (compareIsoDates(date, thisMonth.periodEnd) <= 0) {
    if (compareIsoDates(date, thisMonth.periodStart) >= 0) return thisMonth;
    return cycleFor(anchorDay, y, m - 1);
  }
  return cycleFor(anchorDay, y, m + 1);
}

/** The cycle immediately following the one ending on `periodEnd`. */
export function nextCycle(anchorDay: number, cycle: BillingCycle): BillingCycle {
  const { y, m } = parseIsoDate(cycle.periodEnd);
  return cycleFor(anchorDay, y, m + 1);
}

/**
 * Days remaining until expiry, from the business "today".
 * 0 means expiry is today; negative means already overdue.
 */
export function daysUntilExpiry(expiry: IsoDate, today: IsoDate = todayInKarachi()): number {
  return daysBetween(today, expiry);
}

export function daysOverdue(dueDate: IsoDate, today: IsoDate = todayInKarachi()): number {
  return Math.max(0, daysBetween(dueDate, today));
}

/**
 * The instant at which the final expiry notification for `expiry` must fire:
 * 00:00 Asia/Karachi on the expiry date. Karachi is a fixed UTC+5 offset with
 * no daylight saving, so this is exact.
 *
 * "12:00 AM" in the business's wording means midnight — the START of the
 * expiry date, not noon and not the end of the day.
 */
export function midnightKarachiUtc(expiry: IsoDate): Date {
  const { y, m, d } = parseIsoDate(expiry);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5 * 3_600_000);
}

/** Formats a date for display inside a WhatsApp message: 15 September 2026. */
export function formatForMessage(date: IsoDate, locale = "en-GB"): string {
  const { y, m, d } = parseIsoDate(date);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
