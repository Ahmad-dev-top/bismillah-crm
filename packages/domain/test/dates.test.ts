import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cycleEnd, cycleFor, cycleContaining, nextCycle, addDays, daysBetween,
  daysUntilExpiry, daysOverdue, midnightKarachiUtc, todayInKarachi,
  daysInMonth, isLeapYear, isIsoDate, formatForMessage,
} from "../src/dates.ts";

test("month-end clamping does not lose the anchor day", () => {
  assert.equal(cycleEnd(31, 2026, 1), "2026-01-31");
  assert.equal(cycleEnd(31, 2026, 2), "2026-02-28");
  // The bug this whole design exists to prevent:
  assert.equal(cycleEnd(31, 2026, 3), "2026-03-31");
  assert.equal(cycleEnd(31, 2026, 4), "2026-04-30");
  assert.equal(cycleEnd(31, 2026, 5), "2026-05-31");
});

test("leap years", () => {
  assert.equal(cycleEnd(29, 2028, 2), "2028-02-29");
  assert.equal(cycleEnd(29, 2026, 2), "2026-02-28");
  assert.equal(cycleEnd(31, 2028, 2), "2028-02-29");
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28, "1900-rule century");
  assert.equal(daysInMonth(2000, 2), 29, "400-rule century");
  assert.equal(isLeapYear(2028), true);
  assert.equal(isLeapYear(2026), false);
});

test("month overflow rolls the year", () => {
  assert.equal(cycleEnd(15, 2026, 13), "2027-01-15");
  assert.equal(cycleEnd(15, 2026, 0), "2025-12-15");
  assert.equal(cycleEnd(15, 2026, -1), "2025-11-15");
});

test("cycles tile the calendar with no gap or overlap", () => {
  let c = cycleFor(31, 2026, 1);
  for (let i = 0; i < 24; i++) {
    const next = nextCycle(31, c);
    assert.equal(next.periodStart, addDays(c.periodEnd, 1),
      `gap after ${c.periodEnd}`);
    c = next;
  }
});

test("cycleContaining finds the right cycle at boundaries", () => {
  const c = cycleFor(15, 2026, 9);
  assert.equal(c.periodEnd, "2026-09-15");
  assert.equal(c.periodStart, "2026-08-16");
  assert.deepEqual(cycleContaining(15, "2026-09-15"), c);
  assert.deepEqual(cycleContaining(15, "2026-08-16"), c);
  assert.equal(cycleContaining(15, "2026-09-16").periodEnd, "2026-10-15");
  assert.equal(cycleContaining(15, "2026-08-15").periodEnd, "2026-08-15");
});

test("year transition", () => {
  const dec = cycleFor(31, 2026, 12);
  assert.equal(dec.periodEnd, "2026-12-31");
  assert.equal(nextCycle(31, dec).periodEnd, "2027-01-31");
});

test("addDays and daysBetween cross month and year boundaries", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(daysBetween("2026-09-13", "2026-09-15"), 2);
  assert.equal(daysBetween("2026-09-15", "2026-09-13"), -2);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2, "leap day counted");
});

test("two-day reminder window is exactly two days", () => {
  assert.equal(daysUntilExpiry("2026-09-15", "2026-09-13"), 2);
  assert.equal(daysUntilExpiry("2026-09-15", "2026-09-14"), 1);
  assert.equal(daysUntilExpiry("2026-09-15", "2026-09-15"), 0);
  assert.equal(daysUntilExpiry("2026-09-15", "2026-09-16"), -1);
  // across a month end
  assert.equal(daysUntilExpiry("2026-03-01", "2026-02-27"), 2);
  assert.equal(daysUntilExpiry("2028-03-01", "2028-02-28"), 2, "leap day between");
});

test("daysOverdue floors at zero", () => {
  assert.equal(daysOverdue("2026-09-15", "2026-09-20"), 5);
  assert.equal(daysOverdue("2026-09-15", "2026-09-15"), 0);
  assert.equal(daysOverdue("2026-09-15", "2026-09-10"), 0);
});

test("midnight means 00:00 Karachi, which is 19:00 UTC the previous day", () => {
  const d = midnightKarachiUtc("2026-09-15");
  assert.equal(d.toISOString(), "2026-09-14T19:00:00.000Z");
  // and NOT noon
  assert.notEqual(d.toISOString(), "2026-09-15T12:00:00.000Z");
});

test("todayInKarachi is ahead of UTC during the 19:00-24:00 UTC window", () => {
  // 2026-09-14T20:00Z is already 2026-09-15 in Karachi.
  assert.equal(todayInKarachi(new Date("2026-09-14T20:00:00Z")), "2026-09-15");
  assert.equal(todayInKarachi(new Date("2026-09-14T18:00:00Z")), "2026-09-14");
});

test("isIsoDate rejects impossible dates", () => {
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("2026-2-01"), false);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
});

test("message date formatting", () => {
  assert.equal(formatForMessage("2026-09-15"), "15 September 2026");
});

test("cycleEnd rejects an out-of-range anchor", () => {
  assert.throws(() => cycleEnd(0, 2026, 1), RangeError);
  assert.throws(() => cycleEnd(32, 2026, 1), RangeError);
});
