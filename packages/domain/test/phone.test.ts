import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMsisdn, isNormalizedMsisdn, toNationalDisplay, findDuplicateMsisdns,
} from "../src/phone.ts";

const EXPECT = "+923001234567";

test("accepts every common Pakistani input form", () => {
  const forms = [
    "03001234567", "3001234567", "+923001234567", "923001234567",
    "00923001234567", "0300-1234567", "0300 1234567", "(0300) 123-4567",
    "+92 300 1234567", "0300.1234567", " 03001234567 ",
  ];
  for (const f of forms) {
    const r = normalizeMsisdn(f);
    assert.equal(r.ok, true, `failed on ${f}`);
    if (r.ok) assert.equal(r.msisdn, EXPECT, `wrong result for ${f}`);
  }
});

test("folds Urdu and Arabic-Indic digits", () => {
  const urdu = normalizeMsisdn("۰۳۰۰۱۲۳۴۵۶۷");
  assert.equal(urdu.ok && urdu.msisdn, EXPECT);
  const arabic = normalizeMsisdn("٠٣٠٠١٢٣٤٥٦٧");
  assert.equal(arabic.ok && arabic.msisdn, EXPECT);
});

test("strips bidi marks left by Urdu keyboards", () => {
  const r = normalizeMsisdn("\u200F03001234567\u200E");
  assert.equal(r.ok && r.msisdn, EXPECT);
});

test("rejects what must not be sent to", () => {
  const bad: [string, string][] = [
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["abcdefghijk", "NON_NUMERIC"],
    ["0300123456", "TOO_SHORT"],
    ["030012345678", "TOO_LONG"],
    ["0421234567", "NOT_PK_MOBILE"],   // Lahore landline
    ["02112345678", "NOT_PK_MOBILE"],  // Karachi landline
  ];
  for (const [input, reason] of bad) {
    const r = normalizeMsisdn(input);
    assert.equal(r.ok, false, `should have rejected ${JSON.stringify(input)}`);
    if (!r.ok) assert.equal(r.reason, reason, `wrong reason for ${input}`);
  }
  assert.equal(normalizeMsisdn(null).ok, false);
  assert.equal(normalizeMsisdn(undefined).ok, false);
});

test("isNormalizedMsisdn is strict about the stored form", () => {
  assert.equal(isNormalizedMsisdn("+923001234567"), true);
  assert.equal(isNormalizedMsisdn("03001234567"), false);
  assert.equal(isNormalizedMsisdn("923001234567"), false);
  assert.equal(isNormalizedMsisdn("+92 300 1234567"), false);
  assert.equal(isNormalizedMsisdn("+924211234567"), false, "landline");
});

test("display form round-trips", () => {
  assert.equal(toNationalDisplay(EXPECT), "0300-1234567");
  const back = normalizeMsisdn(toNationalDisplay(EXPECT));
  assert.equal(back.ok && back.msisdn, EXPECT);
});

test("import duplicate detection sees through formatting differences", () => {
  const dupes = findDuplicateMsisdns([
    { rowNumber: 2, phone: "03001234567" },
    { rowNumber: 7, phone: "+92 300 1234567" },
    { rowNumber: 9, phone: "0300-1234567" },
    { rowNumber: 11, phone: "03219999999" },
    { rowNumber: 12, phone: "garbage" },
  ]);
  assert.equal(dupes.size, 1);
  assert.deepEqual(dupes.get(EXPECT), [2, 7, 9]);
});
