/**
 * Background worker. Runs as bi-worker.service under systemd.
 *
 * This process is what makes the CRM work when the administrator's computer
 * is off (§4). Nothing here touches a browser, a session, or a logged-in user.
 *
 * Every job is idempotent. The worker can be killed at any point and restarted
 * without duplicating a message or an invoice — that property is verified by
 * the Phase 10 gate, not assumed.
 */

import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { createSql, requireEnv } from "@bi/api/db/index.ts";
import {
  runSweep,
  recheckBeforeSend,
  markSent,
  markSkipped,
  markFailed,
} from "@bi/api/modules/notifications.service.ts";
import {
  generateInvoices,
  refreshInvoiceStatuses,
} from "@bi/api/modules/billing.service.ts";
import { configFromEnv, sendNotification } from "@bi/api/lib/whatsapp.ts";
import { notificationKey, todayInKarachi, type NotificationType } from "@bi/domain";
import { QUEUES, type SendJob, type SweepJob } from "./queues.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", name: "bi-worker" });

const connection = new IORedis(requireEnv("REDIS_URL"), {
  maxRetriesPerRequest: null, // required by BullMQ
});
const sql = createSql();
const whatsappConfig = configFromEnv();

/* -------------------------------------------------------------------------
 * whatsapp queue — one job per notification row
 * ---------------------------------------------------------------------- */

const whatsappWorker = new Worker<SendJob>(
  QUEUES.whatsapp,
  async (job: Job<SendJob>) => {
    const { notificationId } = job.data;

    // §25: the bill may have been paid between the sweep and now. This is the
    // last gate before a message leaves the building.
    const skip = await recheckBeforeSend(sql, notificationId);
    if (skip) {
      await markSkipped(sql, notificationId, skip);
      log.info({ notificationId, skip }, "notification skipped at send time");
      return { status: "SKIPPED", reason: skip };
    }

    const outcome = await sendNotification(sql, whatsappConfig, notificationId);

    if (outcome.status === "SENT") {
      await markSent(sql, notificationId, outcome.providerMessageId);
      log.info(
        { notificationId, providerMessageId: outcome.providerMessageId },
        "notification sent",
      );
      return outcome;
    }

    await markFailed(sql, notificationId, outcome.errorCode, outcome.errorMessage);

    if (outcome.retryable) {
      // Throwing hands the job back to BullMQ's backoff policy.
      throw new Error(`${outcome.errorCode}: ${outcome.errorMessage}`);
    }

    log.warn({ notificationId, ...outcome }, "permanent send failure, not retrying");
    return outcome;
  },
  {
    connection,
    // Meta's per-second throughput is generous, but the A1 is not. Four in
    // flight keeps memory flat while clearing a thousand-customer sweep in
    // a few minutes.
    concurrency: Number(process.env.WHATSAPP_CONCURRENCY ?? 4),
    limiter: { max: 20, duration: 1000 },
  },
);

/* -------------------------------------------------------------------------
 * notifications queue — the daily sweeps
 * ---------------------------------------------------------------------- */

const sweepWorker = new Worker<SweepJob>(
  QUEUES.notifications,
  async (job: Job<SweepJob>) => {
    const type = job.data.type as NotificationType;
    if (type !== "TWO_DAY_REMINDER" && type !== "FINAL_EXPIRY_WARNING") {
      throw new Error(`Sweep does not handle ${type}`);
    }

    const businessDate = job.data.businessDate ?? todayInKarachi();

    const result = await runSweep(sql, type, {
      businessDate,
      onQueued: async (notificationId, jobKey) => {
        await whatsappWorker.client.then(() => undefined); // ensure connection
        await sendQueue.add(
          "send",
          { notificationId },
          {
            // Same logical key as the DB unique index. A repeat enqueue is
            // dropped by Redis before it reaches Postgres at all.
            jobId: jobKey,
            attempts: 4,
            backoff: { type: "exponential", delay: 60_000 },
            removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
            removeOnFail: false,
          },
        );
      },
    });

    log.info(result, "sweep complete");
    return result;
  },
  { connection, concurrency: 1 }, // one sweep at a time, always
);

/* -------------------------------------------------------------------------
 * billing queue — daily invoice generation and status refresh
 * ---------------------------------------------------------------------- */

const billingWorker = new Worker(
  QUEUES.billing,
  async (job: Job<{ businessDate?: string }>) => {
    const businessDate = job.data.businessDate ?? todayInKarachi();
    const generated = await generateInvoices(sql, { businessDate });
    const refreshed = await refreshInvoiceStatuses(sql, businessDate);
    log.info({ generated, refreshed }, "billing run complete");
    return { generated, refreshed };
  },
  { connection, concurrency: 1 },
);

/* -------------------------------------------------------------------------
 * retry queue — re-attempt failed sends that are still in their window
 * ---------------------------------------------------------------------- */

const retryWorker = new Worker(
  QUEUES.retry,
  async () => {
    const rows = await sql<{ id: string; invoice_id: string; notification_type: string }[]>`
      SELECT id, invoice_id, notification_type
        FROM whatsapp_notifications
       WHERE status = 'FAILED'
         AND retry_count < 3
         AND scheduled_for > now() - interval '24 hours'
       ORDER BY scheduled_for
       LIMIT 200
    `;

    for (const r of rows) {
      // Reset to QUEUED so the send path's status guard lets it through.
      await sql`
        UPDATE whatsapp_notifications SET status = 'QUEUED'
         WHERE id = ${r.id} AND status = 'FAILED'
      `;
      await sendQueue.add(
        "send",
        { notificationId: r.id },
        {
          jobId: `${notificationKey(r.invoice_id, r.notification_type as NotificationType)}:retry${Date.now()}`,
          attempts: 2,
          backoff: { type: "exponential", delay: 120_000 },
        },
      );
    }

    log.info({ requeued: rows.length }, "retry sweep complete");
    return { requeued: rows.length };
  },
  { connection, concurrency: 1 },
);

/* ---------------------------------------------------------------------- */

import { Queue } from "bullmq";
const sendQueue = new Queue<SendJob>(QUEUES.whatsapp, { connection });

for (const w of [whatsappWorker, sweepWorker, billingWorker, retryWorker]) {
  w.on("failed", (job, err) =>
    log.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"),
  );
  w.on("error", (err) => log.error({ queue: w.name, err: err.message }, "worker error"));
}

/**
 * Graceful shutdown. close() lets in-flight jobs finish rather than orphaning
 * a notification in QUEUED with a message already sent to Meta.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  await Promise.allSettled([
    whatsappWorker.close(),
    sweepWorker.close(),
    billingWorker.close(),
    retryWorker.close(),
    sendQueue.close(),
  ]);
  await sql.end({ timeout: 5 });
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info(
  { dryRun: whatsappConfig.dryRun, tz: "Asia/Karachi" },
  "bi-worker started",
);
