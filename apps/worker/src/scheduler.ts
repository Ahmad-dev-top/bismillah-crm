/**
 * Scheduler. Runs as bi-scheduler.service.
 *
 * This process only REGISTERS repeatable jobs; Redis owns the cron state and
 * the worker executes them. Two consequences worth stating:
 *
 *  - Restarting the scheduler re-registers the same jobs by key, so it is safe
 *    to restart at any time and does not fire a catch-up burst.
 *  - Running two scheduler instances cannot double-fire, because the repeat
 *    key is what deduplicates, not the process.
 *
 * All cron expressions are evaluated in Asia/Karachi. BullMQ takes the
 * timezone explicitly, so the host's clock setting cannot change when the
 * midnight job runs.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { QUEUES } from "./queues.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", name: "bi-scheduler" });
const TZ = "Asia/Karachi";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

const billing = new Queue(QUEUES.billing, { connection });
const notifications = new Queue(QUEUES.notifications, { connection });
const retry = new Queue(QUEUES.retry, { connection });

async function register(): Promise<void> {
  // 00:30 — generate invoices and refresh statuses before anyone logs in.
  await billing.add(
    "daily-billing",
    {},
    {
      repeat: { pattern: "30 0 * * *", tz: TZ, key: "daily-billing" },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  );

  // 09:00 — two-day reminders. A civil hour, not the middle of the night:
  // a billing reminder that arrives at 3 a.m. reads as spam and hurts the
  // template's quality rating with Meta.
  await notifications.add(
    "two-day-sweep",
    { type: "TWO_DAY_REMINDER" },
    {
      repeat: { pattern: "0 9 * * *", tz: TZ, key: "two-day-sweep" },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  );

  // 00:00 — final expiry warning, at the FIRST minute of the expiry date.
  // "12:00 AM" in the business's wording is midnight, not noon (§24).
  await notifications.add(
    "final-expiry-sweep",
    { type: "FINAL_EXPIRY_WARNING" },
    {
      repeat: { pattern: "0 0 * * *", tz: TZ, key: "final-expiry-sweep" },
      removeOnComplete: { count: 30 },
      removeOnFail: { count: 30 },
    },
  );

  // Hourly retry of transient failures inside their 24-hour window.
  await retry.add(
    "retry-sweep",
    {},
    {
      repeat: { pattern: "15 * * * *", tz: TZ, key: "retry-sweep" },
      removeOnComplete: { count: 24 },
      removeOnFail: { count: 24 },
    },
  );

  const scheduled = await Promise.all([
    billing.getRepeatableJobs(),
    notifications.getRepeatableJobs(),
    retry.getRepeatableJobs(),
  ]);

  log.info(
    { tz: TZ, jobs: scheduled.flat().map((j) => ({ name: j.name, next: new Date(j.next).toISOString() })) },
    "repeatable jobs registered",
  );
}

register()
  .then(async () => {
    await Promise.all([billing.close(), notifications.close(), retry.close()]);
    await connection.quit();
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err: err.message }, "scheduler registration failed");
    process.exit(1);
  });
