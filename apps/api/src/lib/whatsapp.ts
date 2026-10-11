/**
 * WhatsApp Cloud API client (Meta official — NOT WhatsApp Web automation).
 *
 * The critical design point: sendNotification() accepts a notification ID and
 * nothing else. It reads the recipient, the rendered body and the template
 * parameters from the row that the database already validated via the
 * composite foreign key. There is deliberately NO function in this module
 * that takes a phone number as a parameter, so no caller — including a future
 * one written in a hurry — can dispatch to an arbitrary number.
 */

import type { Sql } from "postgres";

export interface WhatsappConfig {
  /** Meta phone number ID (not the display number). */
  phoneNumberId: string;
  /** System user access token. Read from the environment, never the DB. */
  accessToken: string;
  apiVersion: string;
  /** When true, log the payload and return a fake ID instead of calling Meta. */
  dryRun: boolean;
}

export function configFromEnv(): WhatsappConfig {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const dryRun = process.env.WHATSAPP_DRY_RUN === "true";

  if (!dryRun && (!phoneNumberId || !accessToken)) {
    throw new Error(
      "WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set " +
        "(or set WHATSAPP_DRY_RUN=true for a non-sending environment).",
    );
  }
  return {
    phoneNumberId: phoneNumberId ?? "dry-run",
    accessToken: accessToken ?? "dry-run",
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v21.0",
    dryRun,
  };
}

export type SendOutcome =
  | { status: "SENT"; providerMessageId: string }
  | { status: "FAILED"; errorCode: string; errorMessage: string; retryable: boolean };

/**
 * Meta error codes that will never succeed on retry. Retrying these burns
 * quota and, for 131026, repeatedly messages a number that is not on WhatsApp.
 */
const PERMANENT_ERRORS = new Set([
  "131026", // recipient not a WhatsApp user
  "131047", // re-engagement required outside the 24h window
  "132000", // template param count mismatch
  "132001", // template does not exist
  "132005", // template body too long / hydrated text too long
  "132007", // template format character policy violation
  "132012", // template parameter format mismatch
  "133010", // phone number not registered
  "100",    // invalid parameter
]);

interface TemplateSendRow {
  id: string;
  recipient_msisdn: string;
  provider_template_name: string;
  language_code: string;
  template_params: string[];
}

/**
 * Dispatches one notification by ID.
 *
 * The row is re-read inside the send path — not passed in from the sweep —
 * so the number that goes to Meta is the number the database vouched for at
 * insert time, not a value that travelled through a queue payload where it
 * could have been swapped.
 */
export async function sendNotification(
  sql: Sql,
  cfg: WhatsappConfig,
  notificationId: string,
): Promise<SendOutcome> {
  const rows = await sql<TemplateSendRow[]>`
    SELECT n.id,
           n.recipient_msisdn,
           t.provider_name       AS provider_template_name,
           t.language_code,
           n.template_params
      FROM whatsapp_notifications n
      JOIN whatsapp_templates t ON t.id = n.template_id
     WHERE n.id = ${notificationId}
       AND n.status = 'QUEUED'
  `;

  const row = rows[0];
  if (!row) {
    return {
      status: "FAILED",
      errorCode: "NOT_QUEUED",
      errorMessage: `Notification ${notificationId} is missing or no longer QUEUED.`,
      retryable: false,
    };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: row.recipient_msisdn,
    type: "template",
    template: {
      name: row.provider_template_name,
      language: { code: row.language_code },
      components: [
        {
          type: "body",
          parameters: row.template_params.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };

  if (cfg.dryRun) {
    return { status: "SENT", providerMessageId: `dryrun.${notificationId}` };
  }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Network failure, DNS, timeout — always worth a retry.
    return {
      status: "FAILED",
      errorCode: "NETWORK",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }

  const body = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { code?: number; message?: string; error_subcode?: number };
  };

  if (res.ok && body.messages?.[0]?.id) {
    return { status: "SENT", providerMessageId: body.messages[0].id };
  }

  const code = String(body.error?.code ?? res.status);
  return {
    status: "FAILED",
    errorCode: code,
    errorMessage: body.error?.message ?? `HTTP ${res.status}`,
    // 4xx other than rate limiting is a bad request; 429/5xx are transient.
    retryable:
      !PERMANENT_ERRORS.has(code) && (res.status === 429 || res.status >= 500),
  };
}

/**
 * Verifies Meta's delivery webhook signature. Without this, anyone who learns
 * the callback URL can mark messages delivered or failed.
 */
export async function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice(7), "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Maps a Meta webhook status to our notification_status enum. */
export function mapWebhookStatus(
  metaStatus: string,
): "SENT" | "DELIVERED" | "READ" | "FAILED" | null {
  switch (metaStatus) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}
