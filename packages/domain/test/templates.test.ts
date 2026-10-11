import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindingsForCustomer, renderTemplate, validateTemplateBody, extractVariables,
  toProviderTemplate, providerParameters, templateLength, TemplateError,
} from "../src/templates.ts";

const ahmed = bindingsForCustomer({
  recipientMsisdn: "+923001234567", customerName: "Muhammad Ahmed",
  customerCode: "BI-000124", expiryDate: "2026-09-15",
  amountDue: 2500, packageName: "20 Mbps Fiber", speedMbps: 20,
});
const ali = bindingsForCustomer({
  recipientMsisdn: "+923002222222", customerName: "Ali Khan",
  customerCode: "BI-000125", expiryDate: "2026-09-18",
  amountDue: 3000, packageName: "50 Mbps Fiber", speedMbps: 50,
});

test("SPEC 23: each customer's message carries that customer's own date", () => {
  const body = "Your bill of {{amount_due}} is due on {{expiry_date}}.";
  assert.equal(renderTemplate(body, ahmed),
    "Your bill of Rs. 2,500 is due on 15 September 2026.");
  assert.equal(renderTemplate(body, ali),
    "Your bill of Rs. 3,000 is due on 18 September 2026.");
});

test("bindings carry the recipient, so data and number cannot be separated", () => {
  assert.equal(ahmed.recipientMsisdn, "+923001234567");
  assert.equal(ali.recipientMsisdn, "+923002222222");
  assert.throws(() => { (ahmed as any).expiry_date = "2026-01-01"; },
    "bindings are frozen");
});

test("bindings refuse an un-normalized recipient", () => {
  assert.throws(() => bindingsForCustomer({
    recipientMsisdn: "03001234567", customerName: "X", customerCode: "BI-1",
    expiryDate: "2026-09-15", amountDue: 100, packageName: "P", speedMbps: 10,
  }), TemplateError);
});

test("bindings refuse an empty name or a negative balance", () => {
  const ok = { recipientMsisdn: "+923001234567", customerCode: "BI-1",
    expiryDate: "2026-09-15" as const, packageName: "P", speedMbps: 10 };
  assert.throws(() => bindingsForCustomer({ ...ok, customerName: "  ", amountDue: 1 }));
  assert.throws(() => bindingsForCustomer({ ...ok, customerName: "X", amountDue: -1 }));
});

test("a typo in a placeholder throws instead of shipping to a customer", () => {
  assert.throws(() => renderTemplate("Due {{expiry-date}}", ahmed), TemplateError);
  assert.throws(() => renderTemplate("Hi {{name}}", ahmed), TemplateError);
});

test("all supported variables render", () => {
  const body = "{{customer_name}}/{{customer_id}}/{{expiry_date}}/{{amount_due}}/{{package_name}}/{{speed}}";
  assert.equal(renderTemplate(body, ahmed),
    "Muhammad Ahmed/BI-000124/15 September 2026/Rs. 2,500/20 Mbps Fiber/20 Mbps");
});

test("whitespace inside braces is tolerated", () => {
  assert.equal(renderTemplate("Due {{ expiry_date }}", ahmed), "Due 15 September 2026");
});

test("extractVariables reports first-appearance order and dedupes", () => {
  assert.deepEqual(
    extractVariables("{{expiry_date}} ... {{customer_name}} ... {{expiry_date}}"),
    ["expiry_date", "customer_name"]);
});

test("named placeholders convert to Meta positional form", () => {
  const { providerBody, order } = toProviderTemplate(
    "Hi {{customer_name}}, your bill of {{amount_due}} is due {{expiry_date}}. Ref {{customer_name}}.");
  assert.equal(providerBody,
    "Hi {{1}}, your bill of {{2}} is due {{3}}. Ref {{1}}.");
  assert.deepEqual(order, ["customer_name", "amount_due", "expiry_date"]);
  assert.deepEqual(providerParameters(order, ahmed),
    ["Muhammad Ahmed", "Rs. 2,500", "15 September 2026"]);
});

test("Urdu and emoji count as characters, not bytes", () => {
  assert.equal(templateLength("السلام علیکم"), 12);
  assert.equal(templateLength("🇵🇰"), 2, "regional indicator pair");
});

test("validator catches every rejection cause in the supplied templates", () => {
  const v = validateTemplateBody(
    "# Heading\n\n---\n\n* bullet\n\ttabbed\n\nDue {{expiry_date}}");
  assert.equal(v.ok, false);
  const joined = v.problems.join(" | ");
  for (const expect of ["heading", "Horizontal rule", "bullet", "tab", "HTTPS"]) {
    assert.ok(joined.toLowerCase().includes(expect.toLowerCase()),
      `missing check: ${expect} in ${joined}`);
  }
});

test("validator reports exactly how many characters to remove", () => {
  const v = validateTemplateBody("ا".repeat(1219));
  assert.equal(v.length, 1219);
  assert.ok(v.problems[0]!.includes("195"), v.problems[0]);
});

test("a clean template passes", () => {
  const v = validateTemplateBody(
    "Assalam o Alaikum. Your Bismillah Internet bill is due on {{expiry_date}}. " +
    "Pay via JazzCash, EasyPaisa or Raast: 0335-7287782. " +
    "Details: https://bismillah.net.pk/pay");
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
});
