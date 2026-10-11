/**
 * WhatsApp template rendering.
 *
 * §23/§61: the values in a message must come from the customer receiving it.
 * The type system enforces this: renderTemplate() takes a single
 * TemplateBindings object built from one customer's row set. There is no
 * signature that accepts a loose list of numbers alongside a loose list of
 * dates, so the "right message, wrong recipient" bug has no shape to occupy.
 *
 * Rendering is strict. An unbound placeholder throws rather than emitting an
 * empty string or the literal "{{expiry_date}}" to a customer.
 */

import { type IsoDate, formatForMessage } from "./dates.ts";
import { isNormalizedMsisdn } from "./phone.ts";

/** Meta caps the template BODY at 1024 characters, emoji included. */
export const WHATSAPP_BODY_LIMIT = 1024;
export const WHATSAPP_HEADER_LIMIT = 60;
export const WHATSAPP_FOOTER_LIMIT = 60;

export type TemplateVariable =
  | "customer_name"
  | "customer_id"
  | "expiry_date"
  | "amount_due"
  | "package_name"
  | "speed";

/**
 * The complete, verified data for exactly ONE send. Constructed only by
 * bindingsForCustomer(), which requires the recipient number alongside the
 * data so the pair travels together.
 */
export interface TemplateBindings {
  readonly recipientMsisdn: string;
  readonly customer_name: string;
  readonly customer_id: string;
  readonly expiry_date: IsoDate;
  readonly amount_due: number;
  readonly package_name: string;
  readonly speed: number;
}

export class TemplateError extends Error {}

/**
 * Builds bindings, refusing anything that would produce a misleading message.
 * Call this with fields read in a SINGLE query against one customer — never
 * assembled from separate lookups.
 */
export function bindingsForCustomer(input: {
  recipientMsisdn: string;
  customerName: string;
  customerCode: string;
  expiryDate: IsoDate;
  amountDue: number;
  packageName: string;
  speedMbps: number;
}): TemplateBindings {
  if (!isNormalizedMsisdn(input.recipientMsisdn)) {
    throw new TemplateError(
      `Recipient ${input.recipientMsisdn} is not a normalized +92 number; refusing to render.`,
    );
  }
  if (!input.customerName.trim()) {
    throw new TemplateError("Customer name is empty; refusing to render.");
  }
  if (!Number.isFinite(input.amountDue) || input.amountDue < 0) {
    throw new TemplateError(`Invalid amount due: ${input.amountDue}`);
  }
  return Object.freeze({
    recipientMsisdn: input.recipientMsisdn,
    customer_name: input.customerName.trim(),
    customer_id: input.customerCode,
    expiry_date: input.expiryDate,
    amount_due: input.amountDue,
    package_name: input.packageName,
    speed: input.speedMbps,
  });
}

function formatValue(name: TemplateVariable, b: TemplateBindings): string {
  switch (name) {
    case "customer_name":
      return b.customer_name;
    case "customer_id":
      return b.customer_id;
    case "expiry_date":
      return formatForMessage(b.expiry_date);
    case "amount_due":
      return `Rs. ${b.amount_due.toLocaleString("en-PK", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}`;
    case "package_name":
      return b.package_name;
    case "speed":
      return `${b.speed} Mbps`;
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

const KNOWN: ReadonlySet<string> = new Set<TemplateVariable>([
  "customer_name",
  "customer_id",
  "expiry_date",
  "amount_due",
  "package_name",
  "speed",
]);

/** The variables a template body references, in first-appearance order. */
export function extractVariables(body: string): TemplateVariable[] {
  const out: TemplateVariable[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (name && KNOWN.has(name) && !out.includes(name as TemplateVariable)) {
      out.push(name as TemplateVariable);
    }
  }
  return out;
}

/**
 * Renders a template body for one customer.
 * Throws on any placeholder that is not a known variable — a typo like
 * {{expiry-date}} must fail loudly at queue time, not ship to a customer.
 */
export function renderTemplate(body: string, bindings: TemplateBindings): string {
  const unknown: string[] = [];
  const rendered = body.replace(PLACEHOLDER_RE, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!KNOWN.has(name)) {
      unknown.push(name);
      return _match;
    }
    return formatValue(name as TemplateVariable, bindings);
  });
  if (unknown.length) {
    throw new TemplateError(
      `Unknown template variable(s): ${[...new Set(unknown)].join(", ")}`,
    );
  }
  if (/\{\{|\}\}/.test(rendered)) {
    throw new TemplateError("Template still contains braces after rendering.");
  }
  return rendered;
}

/** Meta counts characters, not bytes. Urdu and emoji each count as they render. */
export function templateLength(body: string): number {
  return [...body].length;
}

export interface TemplateValidation {
  ok: boolean;
  length: number;
  limit: number;
  problems: string[];
}

/**
 * Pre-flight check before submitting a template to Meta for approval.
 * Catches the rejection reasons that cost days of review turnaround.
 */
export function validateTemplateBody(body: string): TemplateValidation {
  const problems: string[] = [];
  const length = templateLength(body);

  if (length > WHATSAPP_BODY_LIMIT) {
    problems.push(
      `Body is ${length} characters; the limit is ${WHATSAPP_BODY_LIMIT}. Remove ${length - WHATSAPP_BODY_LIMIT} more.`,
    );
  }
  if (body.includes("\t")) problems.push("Body contains a tab character.");
  if (/ {5,}/.test(body)) {
    problems.push("Body contains a run of more than four spaces.");
  }
  if (/^#{1,6}\s/m.test(body)) {
    problems.push("Markdown headings (#) do not render in WhatsApp; use *bold* instead.");
  }
  if (/^\s*[-*]{3,}\s*$/m.test(body)) {
    problems.push("Horizontal rules (---) do not render in WhatsApp; remove them.");
  }
  if (/^\s*[-*+]\s+/m.test(body)) {
    problems.push(
      "Markdown bullet lists do not render in WhatsApp; use plain lines or • characters.",
    );
  }
  if (/^\s*\{\{/.test(body.trim()) || /\}\}\s*$/.test(body.trim())) {
    problems.push("A template body may not start or end with a placeholder.");
  }
  if (!/https:\/\/[^\s]+/.test(body)) {
    problems.push(
      "No HTTPS URL present. Meta requires a verifiable HTTPS link in the body or a CTA button.",
    );
  }

  return { ok: problems.length === 0, length, limit: WHATSAPP_BODY_LIMIT, problems };
}

/**
 * Converts a body written with {{named}} placeholders into Meta's positional
 * {{1}}, {{2}} form plus the ordered parameter list a send call needs.
 * Keeping named placeholders in the CRM makes templates readable for staff;
 * the conversion happens only at the provider boundary.
 */
export function toProviderTemplate(body: string): {
  providerBody: string;
  order: TemplateVariable[];
} {
  const order = extractVariables(body);
  const providerBody = body.replace(PLACEHOLDER_RE, (_m, rawName: string) => {
    const idx = order.indexOf(rawName.trim() as TemplateVariable);
    if (idx === -1) throw new TemplateError(`Unknown variable ${rawName}`);
    return `{{${idx + 1}}}`;
  });
  return { providerBody, order };
}

export function providerParameters(
  order: TemplateVariable[],
  bindings: TemplateBindings,
): string[] {
  return order.map((v) => formatValue(v, bindings));
}
